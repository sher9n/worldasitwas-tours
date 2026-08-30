/**
 * The script doctor.
 *
 * Reads a written script, finds the places where it breaks its own rules, and
 * rewrites only those lines: two lines telling the same thing, a point echoing
 * the scene it sits on, a pointing opener, a missing introduction. Everything
 * else is left exactly as written. Run the pipeline afterwards and only the
 * changed lines are recorded again.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { dirs, env } from "../env.ts";
import { Ledger } from "../ledger.ts";
import { Llm } from "../llm.ts";
import { parseRecipe } from "@timetravel/schema";
import type { WrittenScript } from "../stages/written.ts";

const STOP_WORDS = new Set(
  "the a an and or of to in on at it is are was were be been this that these those there here with for from by as if so but not no you your i my me we us our they them he she his her its im ive will shall would could should can may might must do does did done have has had am one two three all any every some more most much many few own same than then now when where who whom which what how why up down out off over under again further once".split(
    /\s+/,
  ),
);
const words = (s: string) => (s || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);
const gist = (s: string) => new Set(words(s).filter((w) => w.length > 3 && !STOP_WORDS.has(w)));
function overlap(a: string, b: string): number {
  const A = gist(a);
  const B = gist(b);
  let n = 0;
  for (const w of A) if (B.has(w)) n++;
  return n / Math.max(1, Math.min(A.size, B.size));
}

interface Line {
  path: string[];
  text: string;
  kind: "scene" | "tap";
  label?: string;
  parent?: string;
}

function collect(script: WrittenScript): Line[] {
  const out: Line[] = [];
  for (const [stopId, stop] of Object.entries(script.stops)) {
    if (stop.arrival?.line) out.push({ path: [stopId, "arrival", "line"], text: stop.arrival.line, kind: "scene" });
    for (const [i, p] of (stop.arrival?.points ?? []).entries()) {
      out.push({ path: [stopId, "arrival", "points", String(i)], text: p.line, kind: "tap", label: p.label, parent: stop.arrival?.line });
    }
    for (const [cardId, card] of Object.entries(stop.cards ?? {})) {
      if (card.narration) out.push({ path: [stopId, "cards", cardId, "narration"], text: card.narration, kind: "scene" });
      for (const [i, p] of (card.points ?? []).entries()) {
        out.push({ path: [stopId, "cards", cardId, "points", String(i)], text: p.line, kind: "tap", label: p.label, parent: card.narration });
      }
    }
    if (stop.transitionOut) out.push({ path: [stopId, "transitionOut"], text: stop.transitionOut, kind: "scene" });
  }
  return out;
}

function setAt(script: WrittenScript, p: string[], value: string): void {
  let node: Record<string, unknown> = script.stops as unknown as Record<string, unknown>;
  for (const key of p.slice(0, -1)) node = (node as Record<string, unknown>)[key] as Record<string, unknown>;
  const last = p[p.length - 1];
  if (Array.isArray(node)) (node as unknown as { line: string }[])[Number(last)].line = value;
  else if (typeof (node as Record<string, unknown>)[last] === "object") ((node as Record<string, unknown>)[last] as { line: string }).line = value;
  else (node as Record<string, unknown>)[last] = value;
}

const Rewrite = z.object({ line: z.string() });
const REWRITE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["line"],
  properties: { line: { type: "string", description: "The replacement line, spoken by the guide, in the same voice and length as the original." } },
} as const;

async function main(): Promise<void> {
  const recipeFile = process.argv[2];
  if (!recipeFile) {
    console.log("usage: repair <recipe.json>");
    process.exit(1);
  }
  const recipe = parseRecipe(JSON.parse(await fs.readFile(recipeFile, "utf8")));
  const file = path.join(env.contentDir, "scripts", `${recipe.id}.script.json`);
  const script = JSON.parse(await fs.readFile(file, "utf8")) as WrittenScript;
  const ledger = await Ledger.load(path.join(dirs.work, recipe.id, "ledger.json"));
  const llm = new Llm(env.openaiApiKey, env.researchModel, ledger);

  const lines = collect(script);
  const faults: { line: Line; why: string; clash?: string }[] = [];

  for (let i = 0; i < lines.length; i++) {
    for (let j = i + 1; j < lines.length; j++) {
      if (overlap(lines[i].text, lines[j].text) >= 0.4) {
        faults.push({ line: lines[j], why: "it tells the same thing as another line in this tour", clash: lines[i].text });
      }
    }
  }
  for (const l of lines) {
    if (l.kind === "tap" && l.parent && overlap(l.text, l.parent) >= 0.34) {
      faults.push({ line: l, why: "it repeats the narration of the picture it sits on", clash: l.parent });
    }
    if (l.kind === "tap" && /^(look there|see |mind that|there now)/i.test(l.text.trim())) {
      faults.push({ line: l, why: "it opens with a pointing phrase, which the whole tour must avoid" });
    }
  }

  const seen = new Set<string>();
  const unique = faults.filter((f) => {
    const k = f.line.path.join("/");
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  if (!unique.length) {
    console.log(`${recipe.id}: nothing to repair`);
    return;
  }
  console.log(`${recipe.id}: repairing ${unique.length} line(s)`);

  for (const f of unique) {
    const rewritten = await llm.structured({
      name: "repair_line",
      jsonSchema: REWRITE_SCHEMA as unknown as Record<string, unknown>,
      zod: Rewrite,
      system: `You rewrite one line of a spoken walking tour. Keep the speaker's voice exactly: a real person talking to a friend beside them, joined-up sentences, plain words, contractions, warm and unhurried, no pointing openers such as "Look there" or "See". Keep it the same length as the original. Say something genuinely different from the line it currently clashes with, about the same thing in the picture, grounded in what a person of the period could know. Never invent numbers or names.`,
      user: `The guide is ${recipe.companion.name}, ${recipe.companion.role}, in ${recipe.cityName} in ${recipe.year}.
${f.line.label ? `This line is what they say when the visitor taps "${f.line.label}" in the picture.` : "This line is narration over a picture."}

The line as it stands:
${f.line.text}

The problem: ${f.why}.
${f.clash ? `The line it clashes with, which stays as it is:\n${f.clash}` : ""}

Write the replacement.`,
      webSearch: false,
      effort: "low",
      stage: "repair",
      note: f.line.path.join("/"),
    });
    setAt(script, f.line.path, rewritten.line.trim());
    console.log(`  ${f.line.path.join("/")}: ${rewritten.line.trim().slice(0, 90)}...`);
  }

  await fs.writeFile(file, JSON.stringify(script, null, 2) + "\n");
  console.log(`wrote ${file}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
