/**
 * Shortens the spoken lines of a written script without touching anything else.
 *
 * A picture holds the screen for exactly as long as its line, so long lines are
 * what make a walk feel like a slideshow with a voiceover. Rewriting the script
 * outright would change the picture briefs too and pay for every image again;
 * this rewrites only the words, so the next build re-records and nothing else.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { parseRecipe } from "@timetravel/schema";
import { dirs, env } from "../env.ts";
import { Ledger } from "../ledger.ts";
import { Llm } from "../llm.ts";
import type { WrittenScript } from "../stages/written.ts";

const Shorter = z.object({ line: z.string() });
const SHORTER_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["line"],
  properties: { line: { type: "string", description: "The shortened line, in the same voice, saying the most interesting part of the original." } },
} as const;

const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;

async function main(): Promise<void> {
  const recipeFile = process.argv[2];
  const limit = Number(process.argv[3] || 26);
  if (!recipeFile) {
    console.log("usage: tighten <recipe.json> [words]");
    process.exit(1);
  }
  const recipe = parseRecipe(JSON.parse(await fs.readFile(recipeFile, "utf8")));
  const file = path.join(env.contentDir, "scripts", `${recipe.id}.script.json`);
  const script = JSON.parse(await fs.readFile(file, "utf8")) as WrittenScript;
  const ledger = await Ledger.load(path.join(dirs.work, recipe.id, "ledger.json"));
  const llm = new Llm(env.openaiApiKey, env.researchModel, ledger);

  const stopIds = Object.keys(script.stops);
  const lastStop = stopIds[stopIds.length - 1];
  let changed = 0;

  const shorten = async (text: string, what: string): Promise<string> => {
    if (words(text) <= limit) return text;
    const out = await llm.structured({
      name: "shorten_line",
      jsonSchema: SHORTER_SCHEMA as unknown as Record<string, unknown>,
      zod: Shorter,
      system:
        `You shorten one spoken line of a walking tour to ${limit} words or fewer, keeping the speaker's exact voice: a real person talking to a friend beside them, joined-up sentences, plain words, contractions, warm and unhurried. Keep the single most interesting thing in the line and drop the rest; do not summarise, do not list, do not add anything new, and never invent a number or a name. What remains must still sound like speech, not a caption.`,
      user: `The guide is ${recipe.companion.name}, ${recipe.companion.role}, in ${recipe.cityName} in ${recipe.year}.
This line is ${what}. It currently runs ${words(text)} words:

${text}`,
      webSearch: false,
      effort: "low",
      stage: "tighten",
      note: what,
    });
    changed++;
    return out.line.trim();
  };

  for (const [stopId, stop] of Object.entries(script.stops)) {
    if (stop.arrival?.line) stop.arrival.line = await shorten(stop.arrival.line, `${stopId} arrival`);
    for (const [cardId, card] of Object.entries(stop.cards ?? {})) {
      if (card.narration) card.narration = await shorten(card.narration, `${cardId} narration`);
    }
    // The farewell is the one moment nobody wants hurried.
    if (stop.transitionOut && stopId !== lastStop) stop.transitionOut = await shorten(stop.transitionOut, `${stopId} walking on`);
  }

  await fs.writeFile(file, JSON.stringify(script, null, 2) + "\n");
  console.log(`${recipe.id}: shortened ${changed} line(s) to ${limit} words or fewer`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
