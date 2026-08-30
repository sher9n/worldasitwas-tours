/**
 * pipeline run <recipe.json> [--stops N] [--quality draft|final] [--provider fal|mock]
 *                            [--image-model gpt-image-2|nano-banana-pro] [--steps hero,video,...]
 *                            [--no-portrait] [--fresh]
 *
 * Stages: research -> archive -> script -> character -> media -> assemble.
 * Research, archive picks and scripts are cached in content/work/<tourId>/ and
 * reused on re-runs unless --fresh is given. Media goes through an asset cache
 * keyed on the exact request, so re-running (or widening --steps) only pays for
 * assets that do not exist yet.
 */
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { parseRecipe, type Recipe } from "@timetravel/schema";
import { dirs, env, type ProviderName, type Quality } from "./env.ts";
import { FFMPEG } from "./ffmpeg.ts";
import { Ledger } from "./ledger.ts";
import { Llm } from "./llm.ts";
import { CachedProvider } from "./providers/cached.ts";
import { OpenAiVoice, withVoice } from "./providers/voice.ts";
import { FalProvider, type ImageModel } from "./providers/fal.ts";
import { MockProvider } from "./providers/mock.ts";
import type { MediaProvider } from "./providers/types.ts";
import { CompanionDossier, StopDossier, StopScript } from "./shapes.ts";
import { pickArchive, type StopArchive } from "./stages/archive.ts";
import { assemble } from "./stages/assemble.ts";
import { makeStopHotspots, type StopHotspots } from "./stages/hotspots.ts";
import { applyWrittenScript, loadWritten, type WrittenScript } from "./stages/written.ts";
import { emptyScript, planTour, toWrittenStop, writeStop } from "./stages/screenplay.ts";
import { KNOWN_STEPS, makeCharacter, makeStopMedia, type CharacterSheet, type MediaStep, type StopMedia } from "./stages/media.ts";
import { applyPolish, polishStop, PolishedStop } from "./stages/polish.ts";
import { companionMarkdown, researchCompanion, researchStop } from "./stages/research.ts";
import { scriptStop } from "./stages/script.ts";

interface Args {
  cmd: string;
  recipe: string;
  stops?: number;
  quality: Quality;
  provider: ProviderName;
  imageModel: ImageModel;
  steps?: Set<MediaStep>;
  portrait: boolean;
  fresh: boolean;
  /** Rebuild only these stops; every other stop keeps the media it already has. */
  only?: Set<string>;
  /** Where her recorded voice comes from: the tour's ElevenLabs voice, or the live call's. */
  voiceProvider?: "eleven" | "openai";
}

function parseArgs(argv: string[]): Args {
  const [cmd, recipe, ...rest] = argv;
  const a: Args = { cmd, recipe, quality: env.quality, provider: env.mediaProvider, imageModel: "gpt-image-2", portrait: true, fresh: false };
  for (let i = 0; i < rest.length; i++) {
    const k = rest[i];
    if (k === "--stops") a.stops = Number(rest[++i]);
    else if (k === "--quality") a.quality = rest[++i] as Quality;
    else if (k === "--provider") a.provider = rest[++i] as ProviderName;
    else if (k === "--image-model") a.imageModel = rest[++i] as ImageModel;
    else if (k === "--steps") {
      const list = rest[++i].split(",").map((s) => s.trim()) as MediaStep[];
      for (const s of list) if (!KNOWN_STEPS.includes(s)) throw new Error(`unknown step "${s}"; valid: ${KNOWN_STEPS.join(", ")}`);
      a.steps = new Set(list);
    } else if (k === "--only") a.only = new Set(rest[++i].split(",").map((x) => x.trim()));
    else if (k === "--voice-provider") a.voiceProvider = rest[++i] as "eleven" | "openai";
    else if (k === "--no-portrait") a.portrait = false;
    else if (k === "--fresh") a.fresh = true;
    else throw new Error(`unknown argument ${k}`);
  }
  return a;
}

async function readJson<T>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as T;
  } catch {
    return undefined;
  }
}
async function writeJson(file: string, data: unknown): Promise<void> {
  await fs.writeFile(file, JSON.stringify(data, null, 2));
}

function log(msg: string): void {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.cmd !== "run" || !args.recipe) {
    console.log("usage: pipeline run <recipe.json> [--stops N] [--quality draft|final] [--provider fal|mock] [--image-model gpt-image-2|nano-banana-pro] [--steps a,b] [--only stopId,stopId] [--no-portrait] [--fresh]");
    process.exit(1);
  }
  const recipePath = path.isAbsolute(args.recipe) ? args.recipe : path.resolve(process.cwd(), args.recipe);
  const recipeFull: Recipe = parseRecipe(JSON.parse(await fs.readFile(recipePath, "utf8")));
  const recipe: Recipe = args.stops ? { ...recipeFull, stops: recipeFull.stops.slice(0, args.stops) } : recipeFull;

  const work = path.join(dirs.work, recipe.id);
  if (args.fresh) await fs.rm(work, { recursive: true, force: true });
  await fs.mkdir(work, { recursive: true });
  await fs.mkdir(dirs.tours, { recursive: true });

  const ledger = await Ledger.load(path.join(work, "ledger.json"));
  const llm = new Llm(env.openaiApiKey, env.researchModel, ledger);
  const base: MediaProvider = args.provider === "mock" ? new MockProvider(path.join(work, "mock"), ledger) : new FalProvider(env.falKey, ledger, { imageModel: args.imageModel });
  // Her recorded voice is the tour's own, from ElevenLabs through fal;
  // --voice-provider openai swaps it for the voice the live call answers in.
  const inner: MediaProvider =
    args.provider === "mock" || args.voiceProvider !== "openai" || !env.openaiApiKey
      ? base
      : withVoice(base, new OpenAiVoice(env.openaiApiKey, ledger));
  const provider = new CachedProvider(inner, path.join(work, "assets"), ledger);
  const startCost = ledger.total();
  log(
    `tour ${recipe.id}: ${recipe.stops.length} stop(s), quality=${args.quality}, provider=${provider.name}${provider.name === "fal" ? ` (${args.imageModel})` : ""}, steps=${args.steps ? [...args.steps].join(",") : "all"}, talking portrait=${args.portrait}`,
  );

  // 1. Research
  const dossiers: StopDossier[] = await Promise.all(
    recipe.stops.map(async (stop) => {
      const f = path.join(work, `dossier.${stop.id}.json`);
      const cached = await readJson<unknown>(f).then((x) => (x ? StopDossier.parse(x) : undefined));
      if (cached) {
        log(`research ${stop.id} (cached)`);
        return cached;
      }
      log(`research ${stop.id}`);
      const d = await researchStop(recipe, stop, llm);
      await writeJson(f, d);
      return d;
    }),
  );
  let companion = await readJson<unknown>(path.join(work, "companion.json")).then((x) => (x ? CompanionDossier.parse(x) : undefined));
  if (!companion) {
    log("research companion");
    companion = await researchCompanion(recipe, dossiers, llm);
    await writeJson(path.join(work, "companion.json"), companion);
  } else log("research companion (cached)");

  // 2. Archive picks (real pictures)
  const archives: StopArchive[] = [];
  for (const stop of recipe.stops) {
    const f = path.join(work, `archive.${stop.id}.json`);
    let a = await readJson<StopArchive>(f);
    if (!a) {
      log(`archive ${stop.id}`);
      a = await pickArchive(recipe, stop, dossiers.find((d) => d.stopId === stop.id)!, llm, ledger);
      await writeJson(f, a);
    } else log(`archive ${stop.id} (cached)`);
    log(`  now photo: ${a.nowPhoto ? a.nowPhoto.title : "none"} | archive: ${a.archive ? a.archive.title : "none"}`);
    archives.push(a);
  }

  // 3. Script
  const scripts: StopScript[] = [];
  for (let i = 0; i < recipe.stops.length; i++) {
    const stop = recipe.stops[i];
    const f = path.join(work, `script.${stop.id}.json`);
    let s = await readJson<unknown>(f).then((x) => (x ? StopScript.parse(x) : undefined));
    if (!s) {
      log(`script ${stop.id}`);
      const a = archives[i];
      s = await scriptStop(recipe, stop, dossiers[i], companion, llm, { hasNowPhoto: Boolean(a.nowPhoto), hasArchive: Boolean(a.archive), stopIndex: i, stopCount: recipeFull.stops.length });
      await writeJson(f, s);
    } else log(`script ${stop.id} (cached)`);
    scripts.push(s);
  }

  // 3b. A hand-written script, if this tour has one, speaks for itself: it
  // replaces the generated words before anything is recorded, and it turns the
  // polish pass off, since polish exists to rewrite the model's own prose.
  let written = await loadWritten(env.contentDir, recipe.id);
  // A tour with no script of its own gets one written for it, as one piece
  // rather than stop by stop, and saved where it can be read and edited.
  if (!written && provider.name === "fal") {
    const scriptFile = path.join(env.contentDir, "scripts", `${recipe.id}.script.json`);
    log(`screenplay: planning ${recipe.id}`);
    const plan = await planTour(recipe, dossiers, companion, llm);
    const draft: WrittenScript = emptyScript(recipe);
    const said: string[] = [];
    for (let i = 0; i < scripts.length; i++) {
      log(`screenplay: writing ${scripts[i].stopId}`);
      const cardIds = scripts[i].cards.filter((c) => c.kind === "image" || c.kind === "thenNow").map((c) => c.id);
      const screens = await writeStop(recipe, plan, i, dossiers[i], companion, cardIds, said, llm);
      draft.stops[scripts[i].stopId] = toWrittenStop(screens);
      said.push(screens.arrival.line, ...screens.cards.map((c) => c.line), ...screens.arrival.points.map((pt) => pt.line), ...screens.cards.flatMap((c) => c.points.map((pt) => pt.line)));
    }
    await fs.mkdir(path.dirname(scriptFile), { recursive: true });
    await writeJson(scriptFile, draft);
    written = draft;
    log(`screenplay: wrote ${scriptFile}`);
  }
  if (written) {
    for (let i = 0; i < scripts.length; i++) scripts[i] = applyWrittenScript(scripts[i], written.stops[scripts[i].stopId]);
    log(`written script: ${Object.keys(written.stops).length} stop(s) spoken verbatim`);
  }

  // 4. Character sheet (asset-cached, so this is free after the first run).
  // Her face is identity: the first portraitPrompt is locked per companion so
  // re-researching the dossier can never quietly change what she looks like.
  const lockDir = path.join(env.contentDir, "companions", recipe.companion.name.toLowerCase().replace(/[^a-z0-9]+/g, "-"));
  await fs.mkdir(lockDir, { recursive: true });
  const lockFile = path.join(lockDir, "portrait.lock.json");
  const lock = await readJson<{ portraitPrompt: string }>(lockFile);
  if (lock) companion = { ...companion, portraitPrompt: lock.portraitPrompt };
  else await writeJson(lockFile, { portraitPrompt: companion.portraitPrompt });
  log("character portrait");
  const character: CharacterSheet = await makeCharacter(recipe, companion, provider, args.quality, { greeting: !args.steps || args.steps.has("line") });
  await writeJson(path.join(work, `character.${provider.name}.${args.imageModel}.${args.quality}.json`), character);

  // 4b. Grounding polish: her lines rewritten against the actual stills, in the
  // narrator-host voice. Visuals stay cached; only words (and their audio and
  // faces) change. Vision needs real images, so the mock provider skips this.
  if (provider.name === "fal" && !written) {
    for (let i = 0; i < scripts.length; i++) {
      const f = path.join(work, `polished.${scripts[i].stopId}.json`);
      let pol = await readJson<unknown>(f).then((x) => (x ? PolishedStop.parse(x) : undefined));
      if (!pol) {
        log(`polish ${scripts[i].stopId}`);
        const stills = await makeStopMedia(recipe, scripts[i], archives.find((a) => a.stopId === scripts[i].stopId), character, provider, args.quality, {
          talkingPortrait: false,
          steps: new Set(["hero", "cards"]),
        });
        pol = await polishStop(recipe, scripts[i], dossiers[i], companion, stills, llm, { stopIndex: i, stopCount: recipeFull.stops.length });
        await writeJson(f, pol);
      } else log(`polish ${scripts[i].stopId} (cached)`);
      scripts[i] = applyPolish(scripts[i], pol);
    }
  }

  // 5. Media per stop (always runs; the asset cache makes repeats free)
  const media: StopMedia[] = [];
  for (const script of scripts) {
    const f = path.join(work, `media.${script.stopId}.${provider.name}.${args.quality}.json`);
    // --only keeps the recordings a stop already has; it never changes what she
    // says, only whether these particular lines are recorded again.
    if (args.only && !args.only.has(script.stopId)) {
      const kept = await readJson<StopMedia>(f);
      if (kept) {
        log(`media ${script.stopId} (kept)`);
        media.push(kept);
        continue;
      }
    }
    log(`media ${script.stopId}`);
    const m = await makeStopMedia(recipe, script, archives.find((a) => a.stopId === script.stopId), character, provider, args.quality, { talkingPortrait: args.portrait, steps: args.steps });
    await writeJson(f, m);
    media.push(m);
  }
  log(`assets: ${provider.hits} cached, ${provider.misses} generated`);

  // 5b. Her talking reel: reusable clips the player rotates through while any
  // of her audio plays. Reuses salvaged clips when present; otherwise makes
  // three generic ones (the only talking-portrait spend a tour ever needs).
  // The reel belongs to the CHARACTER: any tour with the same companion reuses
  // it for free. content/companions/<slug>/reel is the shared home; a tour's
  // work dir may seed it (salvaged clips) but never duplicates the spend.
  const companionSlug = recipe.companion.name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const reelDir = path.join(env.contentDir, "companions", companionSlug, "reel");
  await fs.mkdir(reelDir, { recursive: true });
  const seedDir = path.join(work, "reel");
  try {
    for (const f of (await fs.readdir(seedDir)).filter((x) => x.endsWith(".mp4"))) {
      await fs.copyFile(path.join(seedDir, f), path.join(reelDir, f)).catch(() => undefined);
    }
  } catch {
    // no seed dir; fine
  }
  let reelClips = (await fs.readdir(reelDir)).filter((f) => f.endsWith(".mp4")).sort().map((f) => path.join(reelDir, f));
  if (reelClips.length === 0 && provider.name === "fal") {
    log("reel: generating the guide's presence clip");
    // The circle is always muted and only moves while her recorded voice plays,
    // so these clips need speaking MOVEMENT, not speech. A lip-synced render
    // costs about $1.50 and ten minutes each for a mouth nobody can hear; a
    // plain image-to-video clip of the same person talking costs a fraction of
    // that and looks identical behind a muted circle.
    // One clip that begins and ends on the same picture. Every other approach
    // leaves a seam: cutting between clips snaps her back to the starting pose,
    // dissolving puts the same woman on screen twice, and reversing makes the
    // people behind her walk backwards. Given the same frame at both ends, the
    // model brings her back to where she started, so the clip simply loops.
    const PRESENCE =
      `${recipe.companion.name} stands where they work and looks calmly toward the viewer, as though listening to someone they like. ` +
      "They breathe, blink, shift their weight and turn the head a little, and by the end they have settled back into exactly the posture and expression they began in. " +
      "The mouth stays closed and relaxed; they are not speaking. " +
      "Behind them the world moves gently and always forwards: people walking past at a distance, smoke or dust drifting. " +
      "The camera is locked off and does not move or zoom.";
    try {
      const clip = await provider.video({
        prompt: PRESENCE,
        imageUrl: character.portraitUrl,
        endImageUrl: character.portraitUrl,
        durationSec: 10,
        quality: args.quality,
        audio: false,
        stage: "reel",
        note: "presence",
      });
      if (clip.localPath) {
        // Re-encoded locally with a keyframe every second and the index at the
        // front. Looping means seeking back to zero, and on a clip whose only
        // keyframe is at the start that seek can drop a frame, which is seen as
        // a hiccup once every time round.
        const out = path.join(reelDir, "presence.mp4");
        await new Promise<void>((ok, bad) => {
          execFile(
            FFMPEG,
            ["-y", "-i", clip.localPath as string, "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-g", "24", "-keyint_min", "24", "-pix_fmt", "yuv420p", "-movflags", "+faststart", out],
            (err) => (err ? bad(err) : ok()),
          );
        }).catch(async (err) => {
          console.warn(`[reel] could not re-encode the presence clip: ${(err as Error).message}`);
          await fs.copyFile(clip.localPath as string, out);
        });
      }
    } catch (err) {
      console.warn(`[reel] presence clip failed: ${(err as Error).message}`);
    }
    reelClips = (await fs.readdir(reelDir)).filter((f) => f.endsWith(".mp4")).sort().map((f) => path.join(reelDir, f));
  }
  log(`reel: ${reelClips.length} clips`);

  // 6. Points of interest inside the finished stills
  const hotspots: StopHotspots[] = [];
  const wantCards = !args.steps || args.steps.has("cards");
  if (wantCards) {
    for (const script of scripts) {
      // Points are positions inside particular pictures, so a new picture must
      // mean a new search: the cache is keyed on the images it was found in.
      const m0 = media.find((x) => x.stopId === script.stopId)!;
      const shot = createHash("sha1")
        .update([m0.hero, ...m0.cards.map((c) => c.image ?? c.then)].map((a) => a?.localPath ?? a?.remoteUrl ?? "-").join("|"))
        .update(JSON.stringify(written?.stops[script.stopId] ?? {}))
        .digest("hex")
        .slice(0, 8);
      const f = path.join(work, `hotspots.${script.stopId}.${provider.name}.${args.quality}.${shot}.json`);
      let h = await readJson<StopHotspots>(f);
      if (!h) {
        log(`hotspots ${script.stopId}`);
        const m = media.find((x) => x.stopId === script.stopId)!;
        if (provider.name === "mock") {
          // Offline stand-in: two fixed points per image card, spoken via the mock voice.
          h = { stopId: script.stopId, cards: [] };
          for (const sc of script.cards) {
            if (sc.kind !== "image" || !m.cards.find((c) => c.id === sc.id)?.image) continue;
            const points = [];
            for (const [i, spot] of [{ x: 0.32, y: 0.55, label: "a passer-by" }, { x: 0.7, y: 0.42, label: "a shopfront" }].entries()) {
              const text = `Look there, love: ${spot.label}.`;
              const audio = await provider.tts({ text, voice: recipe.companion.narrationVoice, stage: "hotspots", note: `mock poi ${sc.id}/${i + 1}` }).catch(() => undefined);
              points.push({ id: `${sc.id}_p${i + 1}`, ...spot, text, audio });
            }
            h.cards.push({ cardId: sc.id, points });
          }
        } else {
          h = await makeStopHotspots(recipe, script, dossiers.find((d) => d.stopId === script.stopId)!, companion, m, llm, provider, args.quality, written?.stops[script.stopId]);
        }
        await writeJson(f, h);
      } else log(`hotspots ${script.stopId} (cached)`);

      // A cached result written while the voice provider was down has points
      // with no recording. Trusting that cache ships a tour where tapping a
      // point does nothing, so any gap is filled in before the tour is built.
      // A point counts as silent if it has no recording, and also if the
      // recording it names is gone: clearing a walk's audio to re-record it
      // leaves these pointing at files that no longer exist, and a cached
      // result must never be trusted further than the disk backs it up.
      const stillThere = async (pt: { audio?: { localPath?: string; remoteUrl?: string } }): Promise<boolean> => {
        if (!pt.audio) return false;
        if (!pt.audio.localPath) return Boolean(pt.audio.remoteUrl);
        return fs.access(pt.audio.localPath).then(() => true, () => false);
      };
      const everyPoint = [...(h.arrival ?? []), ...h.cards.flatMap((c) => c.points)];
      const silent: typeof everyPoint = [];
      for (const pt of everyPoint) if (!(await stillThere(pt))) silent.push(pt);
      if (silent.length) {
        log(`hotspots ${script.stopId}: recording ${silent.length} line(s) that have no audio`);
        await Promise.all(
          silent.map(async (pt) => {
            try {
              pt.audio = await provider.tts({ text: pt.text, voice: recipe.companion.narrationVoice, stage: "hotspots", note: `poi ${pt.id}` });
            } catch (err) {
              console.warn(`[hotspots] tts ${pt.id} failed: ${(err as Error).message}`);
            }
          }),
        );
        await writeJson(f, h);
      }
      hotspots.push(h);
    }
  }

  // 7. Assemble and publish
  log("assemble");
  const { tour, dir } = await assemble({
    recipe,
    dossiers,
    companion,
    scripts,
    archives,
    character,
    media,
    reelClips,
    hotspots,
    ledger,
    publicBaseUrl: env.publicBaseUrl,
    toursDir: dirs.tours,
    companionMarkdown: companionMarkdown(recipe, companion, dossiers),
  });
  log(`published ${tour.id} v${tour.version} -> ${dir}`);
  log(
    `stops=${tour.stops.length} cards=${tour.stops.reduce((n, s) => n + s.cards.length, 0)} sources=${tour.sources.length} | this run $${(ledger.total() - startCost).toFixed(2)}, tour total $${ledger.total().toFixed(2)} ${JSON.stringify(ledger.byProvider())}`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
