/**
 * pipeline run <recipe.json> [--stops N] [--quality draft|final] [--provider fal|mock] [--no-portrait] [--fresh]
 *
 * Stages: research -> archive -> script -> character -> media -> assemble.
 * Intermediate results live in content/work/<tourId>/ and are reused on re-runs
 * unless --fresh is given, so a failed media stage does not repeat the research.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { parseRecipe, type Recipe } from "@timetravel/schema";
import { dirs, env, type ProviderName, type Quality } from "./env.ts";
import { Ledger } from "./ledger.ts";
import { Llm } from "./llm.ts";
import { FalProvider } from "./providers/fal.ts";
import { MockProvider } from "./providers/mock.ts";
import type { MediaProvider } from "./providers/types.ts";
import { CompanionDossier, StopDossier, StopScript } from "./shapes.ts";
import { pickArchive, type StopArchive } from "./stages/archive.ts";
import { assemble } from "./stages/assemble.ts";
import { makeCharacter, makeStopMedia, type CharacterSheet, type StopMedia } from "./stages/media.ts";
import { companionMarkdown, researchCompanion, researchStop } from "./stages/research.ts";
import { scriptStop } from "./stages/script.ts";

interface Args {
  cmd: string;
  recipe: string;
  stops?: number;
  quality: Quality;
  provider: ProviderName;
  portrait: boolean;
  fresh: boolean;
}

function parseArgs(argv: string[]): Args {
  const [cmd, recipe, ...rest] = argv;
  const a: Args = { cmd, recipe, quality: env.quality, provider: env.mediaProvider, portrait: true, fresh: false };
  for (let i = 0; i < rest.length; i++) {
    const k = rest[i];
    if (k === "--stops") a.stops = Number(rest[++i]);
    else if (k === "--quality") a.quality = rest[++i] as Quality;
    else if (k === "--provider") a.provider = rest[++i] as ProviderName;
    else if (k === "--no-portrait") a.portrait = false;
    else if (k === "--fresh") a.fresh = true;
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
    console.log("usage: pipeline run <recipe.json> [--stops N] [--quality draft|final] [--provider fal|mock] [--no-portrait] [--fresh]");
    process.exit(1);
  }
  const recipePath = path.isAbsolute(args.recipe) ? args.recipe : path.resolve(process.cwd(), args.recipe);
  const recipeFull: Recipe = parseRecipe(JSON.parse(await fs.readFile(recipePath, "utf8")));
  const recipe: Recipe = args.stops ? { ...recipeFull, stops: recipeFull.stops.slice(0, args.stops) } : recipeFull;

  const work = path.join(dirs.work, recipe.id);
  await fs.mkdir(work, { recursive: true });
  await fs.mkdir(dirs.tours, { recursive: true });
  if (args.fresh) await fs.rm(work, { recursive: true, force: true }).then(() => fs.mkdir(work, { recursive: true }));

  const ledger = await Ledger.load(path.join(work, "ledger.json"));
  const llm = new Llm(env.openaiApiKey, env.researchModel, ledger);
  const provider: MediaProvider = args.provider === "mock" ? new MockProvider(path.join(work, "mock"), ledger) : new FalProvider(env.falKey, ledger);
  log(`tour ${recipe.id}: ${recipe.stops.length} stop(s), quality=${args.quality}, provider=${provider.name}, talking portrait=${args.portrait}`);

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

  // 4. Character sheet
  const charFile = path.join(work, `character.${provider.name}.${args.quality}.json`);
  let character = await readJson<CharacterSheet>(charFile);
  if (!character) {
    log("character portrait");
    character = await makeCharacter(recipe, companion, provider, args.quality);
    await writeJson(charFile, character);
  } else log("character portrait (cached)");

  // 5. Media per stop
  const media: StopMedia[] = [];
  for (const script of scripts) {
    const f = path.join(work, `media.${script.stopId}.${provider.name}.${args.quality}.json`);
    let m = await readJson<StopMedia>(f);
    if (!m) {
      log(`media ${script.stopId}`);
      m = await makeStopMedia(recipe, script, archives.find((a) => a.stopId === script.stopId), character, provider, args.quality, { talkingPortrait: args.portrait });
      await writeJson(f, m);
    } else log(`media ${script.stopId} (cached)`);
    media.push(m);
  }

  // 6. Assemble and publish
  log("assemble");
  const { tour, dir } = await assemble({
    recipe,
    dossiers,
    companion,
    scripts,
    archives,
    character,
    media,
    ledger,
    publicBaseUrl: env.publicBaseUrl,
    toursDir: dirs.tours,
    companionMarkdown: companionMarkdown(recipe, companion, dossiers),
  });
  log(`published ${tour.id} v${tour.version} -> ${dir}`);
  log(`stops=${tour.stops.length} cards=${tour.stops.reduce((n, s) => n + s.cards.length, 0)} sources=${tour.sources.length} cost=$${ledger.total().toFixed(2)} ${JSON.stringify(ledger.byProvider())}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
