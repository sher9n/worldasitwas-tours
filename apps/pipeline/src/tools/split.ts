/**
 * Restores a hand-written script and spreads it over more pictures.
 *
 * A picture holds the screen for exactly as long as its line, so an approved
 * script written in long paragraphs shows one still image for half a minute.
 * This does not rewrite a single word: it deals the sentences of each long line
 * out across the screens the tour now has, in order, and only writes something
 * new where a screen has no words left to give it.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { parseRecipe } from "@timetravel/schema";
import { dirs, env } from "../env.ts";
import { Ledger } from "../ledger.ts";
import { Llm } from "../llm.ts";
import type { StopScript } from "../shapes.ts";
import type { WrittenScript, WrittenScreen, WrittenStop } from "../stages/written.ts";

/** Sentences, kept whole, with their punctuation. */
function sentences(text: string): string[] {
  return (text.match(/[^.!?]+[.!?]+(?:\s|$)|[^.!?]+$/g) ?? [text]).map((s) => s.trim()).filter(Boolean);
}

const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;

/**
 * Packs sentences into runs of about `target` words each, never breaking a
 * sentence and never leaving one run carrying everything the others did not.
 * The number of runs comes from how much there is to say, not from a guess.
 */
function pack(text: string, target = 24): string[] {
  const parts = sentences(text);
  const total = words(text);
  if (parts.length <= 1 || total <= target * 1.4) return [text];
  const runs = Math.max(1, Math.round(total / target));
  const ideal = total / runs;
  const out: string[] = [];
  let current: string[] = [];
  for (const part of parts) {
    current.push(part);
    const enough = words(current.join(" ")) >= ideal * 0.85;
    const roomLeft = out.length < runs - 1;
    if (enough && roomLeft) {
      out.push(current.join(" "));
      current = [];
    }
  }
  if (current.length) out.push(current.join(" "));
  return out;
}

const Scene = z.object({ scene: z.string(), line: z.string(), points: z.array(z.object({ label: z.string(), line: z.string() })) });
const SCENE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["scene", "line", "points"],
  properties: {
    scene: { type: "string", description: "What this picture shows: one photographic frame described in a paragraph, naming everything the points below refer to." },
    line: { type: "string", description: "What the guide says over it: 20 to 30 words, one idea, in their voice." },
    points: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["label", "line"],
        properties: {
          label: { type: "string", description: "Two or three plain words naming a thing visible in the picture." },
          line: { type: "string", description: "What they say about it when tapped: 25 to 40 words, adding something the narration has not said." },
        },
      },
    },
  },
} as const;

async function main(): Promise<void> {
  const [recipeFile, sourceFile] = process.argv.slice(2);
  if (!recipeFile || !sourceFile) {
    console.log("usage: split <recipe.json> <approved-script.json>");
    process.exit(1);
  }
  const recipe = parseRecipe(JSON.parse(await fs.readFile(recipeFile, "utf8")));
  const approved = JSON.parse(await fs.readFile(sourceFile, "utf8")) as WrittenScript;
  const work = path.join(dirs.work, recipe.id);
  const ledger = await Ledger.load(path.join(work, "ledger.json"));
  const llm = new Llm(env.openaiApiKey, env.researchModel, ledger);

  const out: WrittenScript = {
    tourId: recipe.id,
    companion: recipe.companion.name,
    note: "Hand-written script, spoken verbatim. Long lines are dealt across more pictures, sentence by sentence, so no picture holds the screen for long; only screens with no approved words of their own were newly written.",
    stops: {},
  };

  let reused = 0;
  let written = 0;

  for (const stop of recipe.stops) {
    const src = approved.stops[stop.id];
    if (!src) continue;
    const script = JSON.parse(await fs.readFile(path.join(work, `script.${stop.id}.json`), "utf8")) as StopScript;
    const cardIds = script.cards.filter((c) => c.kind === "image" || c.kind === "thenNow").map((c) => c.id);
    const slots = 1 + cardIds.length;

    // Everything the guide says at this stop, as sentences, with a note of which
    // approved screen each sentence came from so its picture and its points can
    // travel with it.
    const flat: { text: string; from: number }[] = [];
    const origins: { scene?: string; points?: { label: string; line: string }[] }[] = [];
    const addScreen = (line: string | undefined, scene?: string, points?: { label: string; line: string }[]) => {
      const idx = origins.length;
      origins.push({ scene, points });
      for (const sentence of sentences(line ?? "")) flat.push({ text: sentence, from: idx });
    };
    addScreen(src.arrival?.line, src.arrival?.scene, src.arrival?.points);
    for (const [, card] of Object.entries(src.cards ?? {})) addScreen(card.narration, card.scene, card.points);

    // Deal those sentences into exactly as many runs as there are screens, so
    // every screen carries a similar share and none is left holding the rest.
    const total = flat.reduce((a, s2) => a + words(s2.text), 0);
    const share = total / slots;
    const runs: { text: string[]; from: number }[] = [];
    for (const sentence of flat) {
      const current = runs[runs.length - 1];
      const roomLeft = runs.length < slots;
      if (!current || (words(current.text.join(" ")) >= share * 0.8 && roomLeft)) runs.push({ text: [sentence.text], from: sentence.from });
      else current.text.push(sentence.text);
    }

    const stopOut: WrittenStop = { cards: {}, transitionOut: src.transitionOut };
    // A screen's points belong to the screen its picture belongs to. Giving them
    // to every run a long line was split across would put the same three taps,
    // word for word, on three screens in a row.
    const pointsUsed = new Set<number>();
    for (const [i, run] of runs.entries()) {
      const origin = origins[run.from] ?? {};
      const mine = pointsUsed.has(run.from) ? [] : origin.points ?? [];
      pointsUsed.add(run.from);
      const line = run.text.join(" ");
      reused++;
      if (i === 0) {
        stopOut.arrival = { line, scene: origin.scene, points: mine };
        continue;
      }
      const cardId = cardIds[i - 1];
      if (!cardId) break;
      const screen: WrittenScreen = { narration: line, points: mine };
      if (origin.scene) screen.scene = origin.scene;
      stopOut.cards![cardId] = screen;
    }

    // Any screen with no approved words left gets new ones: a closer look at
    // something the guide has already been talking about.
    for (const cardId of cardIds) {
      if (stopOut.cards![cardId]) continue;
      const said = [stopOut.arrival?.line, ...Object.values(stopOut.cards ?? {}).map((c) => c.narration)].filter(Boolean).join(" ");
      const fresh = await llm.structured({
        name: "extra_screen",
        jsonSchema: SCENE_SCHEMA as unknown as Record<string, unknown>,
        zod: Scene,
        system:
          "You write one extra screen for a walking tour that already exists. The guide's voice is set and must be matched exactly: a real person talking to a friend beside them, joined-up sentences, plain words, contractions, warm and unhurried, no pointing openers such as \"Look there\". This screen is a closer look at one thing in the place, not the wide view again, and it must say something the tour has not said yet. Never invent a number, a name or a date.",
        user: `Tour: ${recipe.title}. ${recipe.cityName}, ${recipe.year}.
Guide: ${recipe.companion.name}, ${recipe.companion.role}.
Stop: ${stop.title}. ${stop.brief}

What they have already said at this stop, which you must not repeat:
${said}

Write the extra screen.`,
        webSearch: false,
        effort: "low",
        stage: "split",
        note: `${stop.id}/${cardId}`,
      });
      stopOut.cards![cardId] = { narration: fresh.line, scene: fresh.scene, points: fresh.points };
      written++;
    }
    out.stops[stop.id] = stopOut;
  }

  const file = path.join(env.contentDir, "scripts", `${recipe.id}.script.json`);
  await fs.writeFile(file, JSON.stringify(out, null, 2) + "\n");
  console.log(`${recipe.id}: ${reused} screens carry the approved words, ${written} were newly written`);
  console.log(`wrote ${file}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
