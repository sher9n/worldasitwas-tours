/**
 * Does the guide sound like a person, or like the research?
 *
 * The screenplay stage writes from a dossier, and the dossier's habits come
 * with it: a chronicler cited by name, an endowment deed's daily allowance of
 * mutton read aloud, a railway distance to three decimal places, a load in
 * litres four centuries before anyone used one. Each of those shipped in a
 * walk before it was caught by eye. This catches them by reading.
 *
 *   node tools/check-voice.mjs content/scripts/<tour>.script.json
 */
import { readFileSync } from "node:fs";

const LEAKS = [
  [/\b(litre|liter|kilo|kilogram|metre|meter|kilometre|kilometer|centimetre|percent|per cent)\b/i,
   "modern units in a period mouth"],
  [/\b(says|said|reports|reported|writes|wrote|according to|records that)\s+(the\s+)?[A-ZÂÜÖÇĞİŞ][a-zâüöçğış]+/,
   "a named source: a guide does not cite"],
  [/\b\d{1,3}[.,]\d{2,}\b/, "false precision: nobody carries decimals in their head"],
  [/\b\d{3,}\s+(keyl|ukiyye|vezne|okka|dirhem|akçe|kuruş)\b/i, "an archive quantity read aloud"],
  [/\b(Reuters|Associated Press|the Sunday Times|Wikipedia|the census|the gazette)\b/i, "a modern source named"],
  [/\bon (the )?\d{1,2}(st|nd|rd|th)? (of )?(January|February|March|April|May|June|July|August|September|October|November|December)\b/i,
   "a report's date rather than how a person says it"],
];

const file = process.argv[2];
if (!file) {
  console.error("usage: node tools/check-voice.mjs <script.json>");
  process.exit(2);
}
const text = readFileSync(file, "utf8");
// Only what is spoken: scene descriptions are for the image model, not the ear.
const spoken = [];
const walk = (o) => {
  if (!o || typeof o !== "object") return;
  for (const [k, v] of Object.entries(o)) {
    if ((k === "line" || k === "narration" || k === "transitionOut") && typeof v === "string") spoken.push(v);
    else walk(v);
  }
};
walk(JSON.parse(text));

let found = 0;
for (const line of spoken) {
  for (const [re, why] of LEAKS) {
    const m = line.match(re);
    if (m) {
      found++;
      console.log(`LEAK (${why})\n  ...${line.slice(Math.max(0, m.index - 40), m.index + 60).trim()}...`);
    }
  }
}
console.log(found ? `\n${found} line(s) sound like the research, not the guide` : `${spoken.length} spoken lines, none sound like research`);
process.exit(found ? 1 : 0);
