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
import fs from "node:fs/promises";
import path from "node:path";
import { parseRecipe, type Recipe } from "@timetravel/schema";
import { dirs, env, type ProviderName, type Quality } from "./env.ts";
import { Ledger } from "./ledger.ts";
import { Llm } from "./llm.ts";
import { CachedProvider } from "./providers/cached.ts";
import { FalProvider, type ImageModel } from "./providers/fal.ts";
import { MockProvider } from "./providers/mock.ts";
import type { MediaProvider } from "./providers/types.ts";
import { CompanionDossier, StopDossier, StopScript } from "./shapes.ts";
import { pickArchive, type StopArchive } from "./stages/archive.ts";
import { assemble } from "./stages/assemble.ts";
import { makeStopHotspots, type StopHotspots } from "./stages/hotspots.ts";
import { ALL_STEPS, makeCharacter, makeStopMedia, type CharacterSheet, type MediaStep, type StopMedia } from "./stages/media.ts";
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
      for (const s of list) if (!ALL_STEPS.includes(s)) throw new Error(`unknown step "${s}"; valid: ${ALL_STEPS.join(", ")}`);
      a.steps = new Set(list);
    } else if (k === "--no-portrait") a.portrait = false;
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
    console.log("usage: pipeline run <recipe.json> [--stops N] [--quality draft|final] [--provider fal|mock] [--image-model gpt-image-2|nano-banana-pro] [--steps a,b] [--no-portrait] [--fresh]");
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
  const inner: MediaProvider = args.provider === "mock" ? new MockProvider(path.join(work, "mock"), ledger) : new FalProvider(env.falKey, ledger, { imageModel: args.imageModel });
  const provider = new CachedProvider(inner, path.join(work, "assets"), ledger);
  const startCost = ledger.total();
  log(
    `tour ${recipe.id}: ${recipe.stops.length} stop(s), quality=${args.quality}, provider=${provider.name}${provider.name === "fal" ? ` (${args.imageModel})` : ""}, steps=${args.steps ? [...args.steps].join(",") : "all"}, talking portrait=${args.portrait}`,
  );

  // 1. Research
  const dossiers: StopDossier[] = [];
  for (const stop of recipe.stops) {
    const f = path.join(work, `dossier.${stop.id}.json`);
    let d = await readJson<unknown>(f).then((x) => (x ? StopDossier.parse(x) : undefined));
    if (!d) {
      log(`research ${stop.id}`);
      d = await researchStop(recipe, stop, llm);
      await writeJson(f, d);
    } else log(`research ${stop.id} (cached)`);
    dossiers.push(d);
  }
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

  // 4. Character sheet (asset-cached, so this is free after the first run)
  log("character portrait");
  const character: CharacterSheet = await makeCharacter(recipe, companion, provider, args.quality, { greeting: !args.steps || args.steps.has("line") });
  await writeJson(path.join(work, `character.${provider.name}.${args.imageModel}.${args.quality}.json`), character);

  // 4b. Grounding polish: her lines rewritten against the actual stills, in the
  // narrator-host voice. Visuals stay cached; only words (and their audio and
  // faces) change. Vision needs real images, so the mock provider skips this.
  if (provider.name === "fal") {
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
    log(`media ${script.stopId}`);
    const m = await makeStopMedia(recipe, script, archives.find((a) => a.stopId === script.stopId), character, provider, args.quality, { talkingPortrait: args.portrait, steps: args.steps });
    await writeJson(path.join(work, `media.${script.stopId}.${provider.name}.${args.quality}.json`), m);
    media.push(m);
  }
  log(`assets: ${provider.hits} cached, ${provider.misses} generated`);

  // 6. Points of interest inside the finished stills
  const hotspots: StopHotspots[] = [];
  const wantCards = !args.steps || args.steps.has("cards");
  if (wantCards) {
    for (const script of scripts) {
      const f = path.join(work, `hotspots.${script.stopId}.${provider.name}.${args.quality}.json`);
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
          h = await makeStopHotspots(recipe, script, dossiers.find((d) => d.stopId === script.stopId)!, companion, m, llm, provider, args.quality);
        }
        await writeJson(f, h);
      } else log(`hotspots ${script.stopId} (cached)`);
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
