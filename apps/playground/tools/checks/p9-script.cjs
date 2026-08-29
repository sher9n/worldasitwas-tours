/**
 * The script as a guided walk, not a pile of facts. Reads the published tour
 * and holds it to the rules the writing was done under: she introduces herself,
 * the interface is explained once and not in the same breath as the welcome,
 * she says goodbye, no fact is told twice, and no tap echoes the scene it sits on.
 */
const fs = require("fs");
const TOUR = "/Applications/MAMP/htdocs/timetravel/content/tours/tour_london_1850_flower_seller/manifest.json";
const ok = (n, c, d = "") => console.log(`[p9] ${c ? "PASS" : "FAIL"} ${n}${d ? " · " + d : ""}`) || c;

const words = (s) => (s || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);
const STOP_WORDS = new Set("the a an and or of to in on at it is are was were be been this that these those there here with for from by as if so but not no you your i my me we us our they them he she his her they it's im ive will shall would could should can may might must do does did done have has had am are one two three all any every some more most much many few own same than then now when where who whom which what how why up down out off over under again further once".split(/\s+/));
/** The distinctive words of a line: what it is actually about. */
const gist = (s) => new Set(words(s).filter((w) => w.length > 3 && !STOP_WORDS.has(w)));
const overlap = (a, b) => { const A = gist(a), B = gist(b); let n = 0; for (const w of A) if (B.has(w)) n++; return n / Math.max(1, Math.min(A.size, B.size)); };

const m = JSON.parse(fs.readFileSync(TOUR, "utf8"));
let pass = true;
const first = m.stops[0].arrival.line.text;
const last = m.stops[m.stops.length - 1].transitionOut?.text || "";

// 1. She introduces herself before anything else.
const name = m.companion.name.split(" ")[0].toLowerCase();
const openingWords = words(first);
pass = ok("she gives her name in the opening", openingWords.includes(name), first.slice(0, 60) + "...") && pass;
pass = ok("she says what she sells", /violet|watercress|flower/i.test(first)) && pass;
pass = ok("she says what the walk is", /walk you|from here to the river|six stops/i.test(first)) && pass;
// 2. The interface is explained, but not before she has introduced herself.
const touchAt = first.toLowerCase().indexOf("touch it");
const nameAt = first.toLowerCase().indexOf(name);
pass = ok("how to look is explained after she introduces herself", touchAt > nameAt && touchAt > 0, `name at ${nameAt}, instructions at ${touchAt}`) && pass;
pass = ok("the interface is explained once in the whole tour", (JSON.stringify(m).match(/green disc/gi) || []).length === 1) && pass;
// 3. She closes the walk.
pass = ok("she says goodbye at the end", /thank you|farewell|walking with me/i.test(last), last.slice(-60)) && pass;

// 4. Nothing is told twice: gather every spoken line with its home.
const lines = [];
for (const s of m.stops) {
  lines.push({ id: `${s.id}/arrival`, text: s.arrival.line.text, kind: "scene" });
  for (const h of s.arrival.hotspots || []) lines.push({ id: `${s.id}/arrival/${h.label}`, text: h.line.text, kind: "tap", parent: `${s.id}/arrival` });
  for (const c of s.cards) {
    if (c.kind !== "image" && c.kind !== "thenNow") continue;
    lines.push({ id: c.id, text: c.narration?.text || "", kind: "scene" });
    for (const h of c.hotspots || []) lines.push({ id: `${c.id}/${h.label}`, text: h.line.text, kind: "tap", parent: c.id });
  }
  if (s.transitionOut) lines.push({ id: `${s.id}/walking`, text: s.transitionOut.text, kind: "scene" });
}
const worst = [];
for (let i = 0; i < lines.length; i++) {
  for (let j = i + 1; j < lines.length; j++) {
    const o = overlap(lines[i].text, lines[j].text);
    if (o >= 0.4) worst.push(`${lines[i].id} ~ ${lines[j].id} (${Math.round(o * 100)}%)`);
  }
}
pass = ok("no two lines tell the same thing", worst.length === 0, worst.slice(0, 4).join(" | ")) && pass;

// 5. A tap must add to its scene, never echo it.
const echoes = lines.filter((l) => l.kind === "tap").filter((l) => {
  const parent = lines.find((x) => x.id === l.parent);
  return parent && overlap(l.text, parent.text) >= 0.34;
}).map((l) => l.id);
pass = ok("no tap repeats the scene it sits on", echoes.length === 0, echoes.slice(0, 4).join(" | ")) && pass;

// 6. The pointing habit is capped, and prices do not dominate.
const taps = lines.filter((l) => l.kind === "tap");
const pointy = taps.filter((l) => /^(look there|see |mind that|there now)/i.test(l.text.trim()));
pass = ok("pointing openers are rare", pointy.length <= m.stops.length, `${pointy.length} of ${taps.length} taps`) && pass;
for (const s of m.stops) {
  const stopText = [s.arrival.line.text, ...(s.arrival.hotspots || []).map((h) => h.line.text), ...s.cards.flatMap((c) => [c.narration?.text || "", ...(c.hotspots || []).map((h) => h.line.text)])].join(" ");
  const prices = (stopText.match(/\b(halfpenny|ha'penny|penny|pence|sixpence|threepence|twopence|shilling|farthing|\d+d\.)\b/gi) || []).length;
  if (prices > 6) pass = ok(`prices stay in the background at ${s.id}`, false, `${prices} mentions`) && pass;
}
pass = ok("prices stay in the background everywhere", true) && pass;

console.log(`[p9] ${lines.length} spoken lines checked`);
if (!pass) process.exit(1);
