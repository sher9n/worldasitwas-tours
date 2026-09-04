/**
 * Real buildings, from real photographs.
 *
 * A generative model asked for "the World Trade Center twin towers" draws two
 * plausible glass slabs. The actual towers in Colombo are curved, lens-shaped
 * in plan, banded horizontally in blue-green glass. Nobody who lives in the
 * city would accept the invention, and for a walk set inside living memory the
 * skyline is the first thing a viewer checks.
 *
 * So the picture is not described to the model, it is SHOWN to it: a present
 * day photograph of each landmark named in the recipe, fetched from Wikimedia
 * Commons and handed to the image call as a reference. The scene is still the
 * tour's year; only the building's form comes from the photograph.
 *
 * Picks are cached per tour so a re-run costs nothing and, more importantly,
 * so the same building looks the same at every stop it appears in.
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { Recipe, RecipeStop } from "@timetravel/schema";
import { isReusable, searchCommons, type CommonsCandidate } from "../commons.ts";
import type { Ledger } from "../ledger.ts";
import type { MediaProvider } from "../providers/types.ts";

export interface LandmarkRef {
  landmark: string;
  title: string;
  pageUrl: string;
  license: string;
  artist: string;
  /** Fetchable by the image model: mirrored onto the provider's storage. */
  refUrl: string;
}

/** A photograph of the building itself, not of a crowd standing near it. */
function score(c: CommonsCandidate, landmark: string): number {
  const t = c.title.toLowerCase();
  const words = landmark.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
  let s = words.filter((w) => t.includes(w)).length * 3;
  if (c.width >= 1200) s += 2;
  if (c.height > c.width) s += 1; // a tall building photographed tall
  if (/night|dark|interior|inside|lobby|construction|model|map|logo|plan/.test(t)) s -= 4;
  return s;
}

export async function landmarkRefs(opts: {
  recipe: Recipe;
  stop: RecipeStop;
  provider: MediaProvider;
  ledger: Ledger;
  workDir: string;
  log?: (m: string) => void;
}): Promise<LandmarkRef[]> {
  const names = opts.stop.landmarks ?? [];
  if (names.length === 0) return [];

  const cacheFile = path.join(opts.workDir, `landmarks.${opts.stop.id}.json`);
  try {
    return JSON.parse(await fs.readFile(cacheFile, "utf8")) as LandmarkRef[];
  } catch {
    // not resolved yet
  }

  const refs: LandmarkRef[] = [];
  for (const landmark of names.slice(0, 4)) {
    const candidates = (await searchCommons(landmark, opts.ledger, 12)).filter(
      (c) => isReusable(c.license) && /jpeg|jpg|png/i.test(c.mime),
    );
    const best = candidates.sort((a, b) => score(b, landmark) - score(a, landmark))[0];
    if (!best) {
      opts.log?.(`  no usable photograph of "${landmark}"; it will be described, not shown`);
      continue;
    }
    // The model has to be able to fetch it, and Wikimedia refuses anonymous
    // hotlinking often enough that the picture must be mirrored first.
    const refUrl = opts.provider.mirrorUrl ? await opts.provider.mirrorUrl(best.thumbUrl, best.mime) : best.thumbUrl;
    refs.push({ landmark, title: best.title, pageUrl: best.pageUrl, license: best.license, artist: best.artist, refUrl });
    opts.log?.(`  ${landmark} -> ${best.title} (${best.license})`);
  }

  await fs.mkdir(opts.workDir, { recursive: true });
  await fs.writeFile(cacheFile, `${JSON.stringify(refs, null, 2)}\n`);
  return refs;
}

/**
 * What to tell the model about the pictures it has been handed. Named
 * explicitly, because "use the reference" is not enough: without being told
 * these are buildings rather than a scene to copy, the model reproduces the
 * reference photograph's weather, crowd and time of day too.
 */
export function landmarkClause(refs: LandmarkRef[], year: number): string {
  if (refs.length === 0) return "";
  const list = refs.map((r) => r.landmark).join(", ");
  return (
    ` The reference photographs show real buildings: ${list}. Any of these that appear in this scene must match the reference exactly in shape, proportion, facade pattern and roofline. Do not invent a different building and do not substitute a generic tower.` +
    ` Take ONLY the buildings from the references: the light, weather, vehicles, clothing, street life and everything else belong to ${year}, not to the modern photographs, and anything built after ${year} that appears in a reference must be left out.`
  );
}
