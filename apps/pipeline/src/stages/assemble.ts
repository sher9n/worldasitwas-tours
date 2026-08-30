/**
 * Builds the manifest from the script, archive picks and media, copies every
 * asset into content/tours/<id>/ with a stable name, rewrites URLs to the public
 * base, validates against the schema and writes manifest.json + companion.md.
 */
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { parseTour, type Card, type Hotspot, type Recipe, type Source, type Stop, type Tour } from "@timetravel/schema";
import { levelAudio, probeDuration } from "../ffmpeg.ts";
import type { Asset } from "../providers/types.ts";
import type { CompanionDossier, StopDossier, StopScript } from "../shapes.ts";
import type { StopArchive } from "./archive.ts";
import type { StopHotspots } from "./hotspots.ts";
import type { CharacterSheet, StopMedia } from "./media.ts";
import type { Ledger } from "../ledger.ts";

const EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "video/mp4": "mp4",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/wav": "wav",
};

export interface AssembleInput {
  recipe: Recipe;
  dossiers: StopDossier[];
  companion: CompanionDossier;
  scripts: StopScript[];
  archives: StopArchive[];
  character: CharacterSheet;
  media: StopMedia[];
  /** Reusable talking clips for her circle (local file paths). */
  reelClips?: string[];
  hotspots?: StopHotspots[];
  ledger: Ledger;
  publicBaseUrl: string;
  toursDir: string;
  companionMarkdown: string;
}

/**
 * Brings one recording to a fixed loudness, so nothing in the tour is louder or
 * quieter than anything else. Speech sits at -16 LUFS, the street bed far below
 * it, and the true peak is held under -1.5 dB so a phone's amplifier never
 * clips, which is what turns a quiet crackle into a loud one.
 */
/** One archive request at a time, with a gap: several tours building at once
 * will otherwise trip Wikimedia's rate limit and lose a whole assemble. */
let archiveQueue: Promise<unknown> = Promise.resolve();
function politely<T>(fn: () => Promise<T>): Promise<T> {
  const next = archiveQueue.then(fn, fn);
  archiveQueue = next.then(() => new Promise((ok) => setTimeout(ok, 350)), () => new Promise((ok) => setTimeout(ok, 350)));
  return next;
}

/** Polite download: identifies itself, queues, and waits out a rate limit rather than failing the tour. */
async function download(url: string, target: string, tries = 7): Promise<void> {
  const archive = /wikimedia\.org|wikipedia\.org/.test(url);
  for (let i = 0; i < tries; i++) {
    const res = await (archive
      ? politely(() => fetch(url, { headers: { "User-Agent": "TimeTravelTours/0.1 (tour engine prototype) node-fetch" } }))
      : fetch(url, { headers: { "User-Agent": "TimeTravelTours/0.1 (tour engine prototype) node-fetch" } }));
    if (res.ok) {
      await fs.writeFile(target, Buffer.from(await res.arrayBuffer()));
      return;
    }
    if ((res.status === 429 || res.status >= 500) && i < tries - 1) {
      const retryAfter = Number(res.headers.get("retry-after")) || 0;
      // Back off properly: 3s, 6s, 12s, 24s, 48s, 60s.
      await new Promise((ok) => setTimeout(ok, Math.max(retryAfter * 1000, Math.min(60_000, 3000 * 2 ** i))));
      continue;
    }
    throw new Error(`download ${url}: ${res.status}`);
  }
}

class Materializer {
  constructor(
    private dir: string,
    private baseUrl: string,
  ) {}

  /** Copies or downloads an asset into the tour folder and returns its public URL. */
  async put(asset: Asset | undefined, name: string): Promise<{ url: string; durationSec?: number; width?: number; height?: number } | undefined> {
    if (!asset || (!asset.remoteUrl && !asset.localPath)) return undefined;
    const ext = EXT[asset.mime] ?? (asset.remoteUrl ? path.extname(new URL(asset.remoteUrl).pathname).slice(1) || "bin" : "bin");
    const file = `${name}.${ext}`;
    const target = path.join(this.dir, file);
    if (asset.localPath) {
      await fs.copyFile(asset.localPath, target);
    } else if (asset.remoteUrl) {
      try {
        await download(asset.remoteUrl, target);
      } catch (err) {
        // An archive photo this walk has published before is already sitting at
        // exactly this path. Wikimedia rate-limits hard when several walks are
        // rebuilt at once, and losing a whole republish over a picture we
        // already hold is the wrong trade: keep the copy and carry on. Only a
        // photo we have never had is fatal.
        const held = await fs.stat(target).catch(() => undefined);
        if (!held?.size) throw err;
        console.warn(`[assemble] keeping the copy already published of ${file}: ${(err as Error).message}`);
      }
    }
    // Every recording lands at the same loudness. The provider returns lines
    // that differ by a few decibels, which on a phone is heard as her voice
    // rising and falling between sentences for no reason.
    // Recordings are levelled once, where they are made. Anything older than
    // that, or brought in from elsewhere, is levelled here instead.
    if (asset.mime.startsWith("audio/") && !asset.levelled) await levelAudio(target, name.includes("ambience") ? -26 : -16);
    const durationSec = /^(video|audio)\//.test(asset.mime) ? (await probeDuration(target)) ?? asset.durationSec : undefined;
    // File names are stable across publishes but their contents are not, and the
    // media route is served immutable for a year. Without a content stamp in the
    // URL a browser keeps playing the narration it downloaded before a rewrite.
    const stamp = createHash("sha1").update(await fs.readFile(target)).digest("hex").slice(0, 10);
    return { url: `${this.baseUrl}/media/${path.basename(this.dir)}/${file}?v=${stamp}`, durationSec, width: asset.width ?? undefined, height: asset.height ?? undefined };
  }

  async putRemote(url: string, name: string, mime: string): Promise<string> {
    const r = await this.put({ remoteUrl: url, mime }, name);
    return r!.url;
  }
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 40);
}

export async function assemble(input: AssembleInput): Promise<{ tour: Tour; dir: string }> {
  const { recipe } = input;
  const dir = path.join(input.toursDir, recipe.id);
  await fs.mkdir(dir, { recursive: true });
  const m = new Materializer(dir, input.publicBaseUrl);

  // Sources: seed sources plus everything the researcher cited, deduplicated by URL.
  const sources: Source[] = [];
  const sourceIdByTitle = new Map<string, string>();
  const addSource = (title: string, url: string, license: string) => {
    const key = title.trim().toLowerCase();
    if (sourceIdByTitle.has(key)) return sourceIdByTitle.get(key)!;
    const existing = sources.find((s) => s.url === url);
    if (existing) {
      sourceIdByTitle.set(key, existing.id);
      return existing.id;
    }
    const id = `src_${String(sources.length + 1).padStart(2, "0")}_${slug(title)}`;
    sources.push({ id, title: title.trim(), url: url || "https://commons.wikimedia.org/", license: license || "see source" });
    sourceIdByTitle.set(key, id);
    return id;
  };
  for (const s of recipe.seedSources) addSource(s.title, s.url, s.license);
  for (const d of input.dossiers) for (const f of d.facts) addSource(f.sourceTitle, f.sourceUrl, "see source");
  const resolveSource = (title: string): string | undefined => {
    const key = title.trim().toLowerCase();
    if (sourceIdByTitle.has(key)) return sourceIdByTitle.get(key);
    // Loose match: the writer sometimes shortens titles.
    const hit = [...sourceIdByTitle.entries()].find(([k]) => k.includes(key) || key.includes(k));
    return hit?.[1];
  };

  const portrait = await m.put(input.character.portrait, "companion_portrait");
  const greeting = await m.put(input.character.greetingAudio, "companion_greeting");
  const faceReel = [];
  for (const [ri, clip] of (input.reelClips ?? []).entries()) {
    const f = await m.put({ localPath: clip, mime: "video/mp4" }, `companion_reel_${ri + 1}`);
    if (f) faceReel.push({ video: f.url, poster: portrait?.url, durationSec: f.durationSec ?? 8, hasAudio: false, origin: "reconstruction" as const });
  }

  const stops: Stop[] = [];
  for (let i = 0; i < input.scripts.length; i++) {
    const script = input.scripts[i];
    const recipeStop = recipe.stops.find((s) => s.id === script.stopId)!;
    const media = input.media.find((x) => x.stopId === script.stopId);
    const archive = input.archives.find((x) => x.stopId === script.stopId);
    const n = String(i + 1).padStart(2, "0");
    if (!media) throw new Error(`no media for ${script.stopId}`);

    const hero = await m.put(media.hero, `s${n}_hero`);
    const living = await m.put(media.livingScene, `s${n}_arrival`);
    const arrivalAudio = await m.put(media.arrivalAudio, `s${n}_arrival_line`);
    const talking = await m.put(media.talkingPortrait, `s${n}_talking`);
    const ambience = await m.put(media.ambience, `s${n}_ambience`);
    const transitionAudio = await m.put(media.transitionAudio, `s${n}_transition`);

    const stopHot = input.hotspots?.find((h) => h.stopId === script.stopId);
    const arrivalHotspots: Hotspot[] = [];
    for (const [pi, pt] of (stopHot?.arrival ?? []).entries()) {
      const audioFile = await m.put(pt.audio, `s${n}_arr_poi${pi + 1}`);
      arrivalHotspots.push({ id: pt.id, x: pt.x, y: pt.y, label: pt.label, line: { text: pt.text, audio: audioFile?.url, durationSec: audioFile?.durationSec } });
    }
    const cards: Card[] = [];
    for (let c = 0; c < script.cards.length; c++) {
      const sc = script.cards[c];
      const cm = media.cards.find((x) => x.id === sc.id);
      const narrationFile = await m.put(cm?.narration, `s${n}_c${c + 1}_narration`);
      const narration = sc.narration.trim() ? { text: sc.narration.trim(), audio: narrationFile?.url, durationSec: narrationFile?.durationSec } : undefined;
      const claims = sc.claims
        .map((k) => ({ text: k.text, confidence: k.confidence, sourceId: resolveSource(k.sourceTitle) }))
        .filter((k): k is { text: string; confidence: "known" | "likely" | "interpretation"; sourceId: string } => Boolean(k.sourceId));
      const hotspots: Hotspot[] = [];
      for (const [pi, p] of (stopHot?.cards.find((x) => x.cardId === sc.id)?.points ?? []).entries()) {
        const audioFile = await m.put(p.audio, `s${n}_c${c + 1}_poi${pi + 1}`);
        hotspots.push({ id: p.id, x: p.x, y: p.y, label: p.label, line: { text: p.text, audio: audioFile?.url, durationSec: audioFile?.durationSec } });
      }
      const base = { id: sc.id, caption: sc.caption.slice(0, 280) || undefined, narration, claims, hotspots };

      if (sc.kind === "thenNow" && cm?.then && archive?.nowPhoto) {
        const then = await m.put(cm.then, `s${n}_c${c + 1}_then`);
        const now = await m.putRemote(archive.nowPhoto.thumbUrl, `s${n}_c${c + 1}_now`, archive.nowPhoto.mime);
        cards.push({
          ...base,
          kind: "thenNow",
          then: { image: then!.url, origin: "reconstruction", width: then!.width, height: then!.height },
          now: {
            image: now,
            origin: "photograph",
            credit: { title: archive.nowPhoto.title, holder: "Wikimedia Commons" + (archive.nowPhoto.artist ? ", " + archive.nowPhoto.artist : ""), license: archive.nowPhoto.license, url: archive.nowPhoto.pageUrl },
          },
          companionContext: { text: sc.companionContextText, image: then!.url },
        });
      } else if (sc.kind === "archive" && archive?.archive) {
        const img = await m.putRemote(archive.archive.thumbUrl, `s${n}_c${c + 1}_archive`, archive.archive.mime);
        const animated = await m.put(cm?.animated, `s${n}_c${c + 1}_alive`);
        cards.push({
          ...base,
          caption: (sc.caption || archive.archive.caption).slice(0, 280) || undefined,
          kind: "archive",
          media: { image: img, origin: "archive", width: archive.archive.width, height: archive.archive.height },
          animated: animated ? { video: animated.url, poster: img, durationSec: animated.durationSec ?? 4, hasAudio: true, origin: "reconstruction" } : undefined,
          credit: { title: archive.archive.title, holder: "Wikimedia Commons" + (archive.archive.artist ? ", " + archive.archive.artist : ""), license: archive.archive.license, url: archive.archive.pageUrl },
          companionContext: { text: sc.companionContextText + " This is a real picture of the period.", image: img },
        });
      } else if (sc.kind === "text") {
        cards.push({ ...base, kind: "text", text: sc.textBody.slice(0, 320) || sc.caption, companionContext: { text: sc.companionContextText } });
      } else {
        const img = await m.put(cm?.image ?? cm?.then, `s${n}_c${c + 1}`);
        if (!img) {
          // The writer asked for a picture we could not make; fall back to text so the stop still plays.
          cards.push({ ...base, kind: "text", text: (sc.textBody || sc.caption || sc.narration).slice(0, 320), companionContext: { text: sc.companionContextText } });
          continue;
        }
        cards.push({
          ...base,
          kind: "image",
          media: { image: img.url, origin: "reconstruction", width: img.width, height: img.height },
          companionContext: { text: sc.companionContextText, image: img.url },
        });
      }
    }

    stops.push({
      id: script.stopId,
      order: i + 1,
      title: recipeStop.title,
      geo: recipeStop.geo,
      arrival: {
        still: hero ? { image: hero.url, width: hero.width ?? undefined, height: hero.height ?? undefined, origin: "reconstruction" } : undefined,
        livingScene: living ? { video: living.url, poster: hero?.url, durationSec: living.durationSec ?? 4, hasAudio: true, origin: "reconstruction" } : undefined,
        talkingPortrait: talking ? { video: talking.url, poster: portrait?.url, durationSec: talking.durationSec ?? 8, hasAudio: true, origin: "reconstruction" } : undefined,
        line: { text: script.arrivalLine, audio: arrivalAudio?.url, durationSec: arrivalAudio?.durationSec },
        ambience: ambience ? { audio: ambience.url, loop: true, gainDb: -14 } : undefined,
        hotspots: arrivalHotspots,
      },
      cards,
      transitionOut: script.transitionLine.trim() ? { text: script.transitionLine.trim(), audio: transitionAudio?.url, durationSec: transitionAudio?.durationSec } : undefined,
    });
  }

  const firstHero = stops[0]?.arrival.still?.image ?? stops[0]?.arrival.livingScene?.poster ?? portrait?.url ?? "";
  const totalNarrationSec = stops.reduce(
    (s, st) => s + (st.arrival.line.durationSec ?? 8) + st.cards.reduce((a, c) => a + (c.narration?.durationSec ?? 8) + 6, 0) + (st.transitionOut?.durationSec ?? 5),
    0,
  );

  const tour: Tour = parseTour({
    schema: "tour/1",
    id: recipe.id,
    version: new Date().toISOString().slice(0, 10) + "." + String(Math.floor(Date.now() / 1000) % 100000),
    city: recipe.city,
    year: recipe.year,
    yearRange: recipe.yearRange,
    lang: recipe.lang,
    title: recipe.title,
    summary: recipe.theme.split(". ").slice(0, 2).join(". ").replace(/\.?$/, "."),
    durationMin: Math.max(3, Math.round(totalNarrationSec / 60)),
    cover: { image: firstHero, video: stops[0]?.arrival.livingScene?.video },
    companion: {
      name: recipe.companion.name,
      role: recipe.companion.role,
      bio: input.companion.bio,
      portrait: portrait?.url ?? firstHero,
      greeting: { text: input.companion.greeting, audio: greeting?.url, durationSec: greeting?.durationSec },
      voice: { provider: "openai-realtime", voice: recipe.companion.voice },
      narrationVoice: recipe.companion.narrationVoice,
      faceReel,
    },
    stops,
    sources,
    provenance: {
      generatedAt: new Date().toISOString(),
      reviewedBy: "none",
      models: input.ledger.modelsUsed(),
      costUsd: input.ledger.total(),
    },
  });

  await fs.writeFile(path.join(dir, "manifest.json"), JSON.stringify(tour, null, 2));

  // Files from earlier builds pile up in the tour folder and are still served
  // from it, so a tour can keep shipping the pictures and recordings of a
  // version nobody plays. Anything this manifest does not name goes.
  const named = new Set<string>();
  for (const m of JSON.stringify(tour).matchAll(/\/media\/[^/"]+\/([^"?#]+)/g)) named.add(decodeURIComponent(m[1]));
  const kept = new Set(["manifest.json", "companion.md", "ledger.json"]);
  for (const entry of await fs.readdir(dir)) {
    if (kept.has(entry) || named.has(entry)) continue;
    await fs.rm(path.join(dir, entry), { force: true });
  }
  await fs.writeFile(path.join(dir, "companion.md"), input.companionMarkdown);
  await fs.writeFile(path.join(dir, "ledger.json"), JSON.stringify({ totalUsd: input.ledger.total(), byProvider: input.ledger.byProvider(), entries: input.ledger.entries }, null, 2));
  return { tour, dir };
}
