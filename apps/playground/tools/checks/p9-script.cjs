/**
 * The script as a guided walk, not a pile of facts. Reads the published tour
 * and holds it to the rules the writing was done under: she introduces herself,
 * the interface is explained once and not in the same breath as the welcome,
 * she says goodbye, no fact is told twice, and no tap echoes the scene it sits on.
 */
const fs = require("fs");
const TOUR = `/Applications/MAMP/htdocs/timetravel/content/tours/${process.env.TOUR || "tour_london_1850_flower_seller"}/manifest.json`;
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

// 1. The guide introduces themselves before anything else: who they are, what
//    they do, and what the walk is. Worded their own way, so this looks for the
//    substance rather than for any particular phrasing.
const name = m.companion.name.split(" ")[0].toLowerCase();
const openingWords = words(first);
pass = ok("gives their name in the opening", openingWords.includes(name), first.slice(0, 60) + "...") && pass;
const trade = words(m.companion.role).filter((w) => w.length > 3 && !STOP_WORDS.has(w));
const saidTrade = trade.filter((t) => openingWords.includes(t) || openingWords.includes(t.replace(/s$/, "")));
pass = ok("says what they do for a living", saidTrade.length > 0, `role words found: ${saidTrade.join(", ") || "none"} (role: ${m.companion.role})`) && pass;
pass = ok("says what the walk is", /\b(walk|round|stops?)\b/i.test(first) && /\b(\d+|one|two|three|four|five|six|seven|eight)\b/i.test(first), first.slice(0, 90)) && pass;
// 2. How to look and how to ask, explained once, and after the introduction.
const lower = first.toLowerCase();
const askAt = lower.indexOf("green button");
const touchAt = Math.max(lower.indexOf("touch"), lower.indexOf("tap"));
const nameAt = lower.indexOf(name);
pass = ok("how to look and ask is explained, after they introduce themselves", askAt > nameAt && touchAt > nameAt && askAt > 0 && touchAt > 0, `name ${nameAt}, touch ${touchAt}, ask ${askAt}`) && pass;
const invites = (JSON.stringify(m).match(/green (disc|button)/gi) || []).length;
pass = ok("the interface is explained once in the whole tour", invites === 1, `${invites} mentions`) && pass;
// 3. She closes the walk.
pass = ok("says goodbye at the end", /thank you|bye\b|farewell|walking with me|good rest|god keep|good day to you|safe home|mind how you go/i.test(last), last.slice(-60)) && pass;

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

// Every spoken line must have a recording: a point with none looks tappable and
// does nothing, which is worse than not being there at all.
const silent = [];
for (const s of m.stops) {
  if (!s.arrival.line.audio) silent.push(`${s.id}/arrival`);
  if (s.transitionOut && !s.transitionOut.audio) silent.push(`${s.id}/walking`);
  for (const h of s.arrival.hotspots || []) if (!h.line.audio) silent.push(`${s.id}/arrival/${h.label}`);
  for (const c of s.cards) {
    if (c.kind !== "image" && c.kind !== "thenNow") continue;
    if (c.narration && !c.narration.audio) silent.push(c.id);
    for (const h of c.hotspots || []) if (!h.line.audio) silent.push(`${c.id}/${h.label}`);
  }
}
pass = ok("every line has a recording", silent.length === 0, silent.slice(0, 4).join(", ")) && pass;

console.log(`[p9] ${lines.length} spoken lines checked`);
if (!pass) process.exit(1);
