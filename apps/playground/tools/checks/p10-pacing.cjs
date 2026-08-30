/**
 * How long a picture holds the screen. A tour is a sequence of short looks, not
 * a few long speeches over a still image: when a line runs a minute, the visitor
 * stares at one picture for a minute and the walk stops feeling alive.
 */
const fs = require("fs");
const TOUR = process.env.TOUR || "tour_london_1850_flower_seller";
const m = JSON.parse(fs.readFileSync(`/Applications/MAMP/htdocs/timetravel/content/tours/${TOUR}/manifest.json`, "utf8"));
const ok = (n, c, d = "") => console.log(`[p10] ${c ? "PASS" : "FAIL"} ${n}${d ? " · " + d : ""}`) || c;

const screens = [];
for (const s of m.stops) {
  screens.push({ id: `${s.id}/arrival`, sec: s.arrival.line.durationSec || 0 });
  for (const c of s.cards) {
    if (c.kind !== "image" && c.kind !== "thenNow") continue;
    screens.push({ id: c.id, sec: (c.narration && c.narration.durationSec) || 0 });
  }
  if (s.transitionOut) screens.push({ id: `${s.id}/walking`, sec: s.transitionOut.durationSec || 0, walk: true });
}
const spoken = screens.filter((x) => x.sec > 0);
const total = spoken.reduce((a, x) => a + x.sec, 0);
const avg = total / Math.max(1, spoken.length);
// The farewell is allowed to run on; it is the one moment nobody wants hurried.
const held = spoken.filter((x) => x.sec > 13 && x.id !== `${m.stops[m.stops.length - 1].id}/walking`);

let pass = true;
pass = ok("a picture changes at least every 13 seconds", held.length === 0, held.slice(0, 4).map((x) => `${x.id} ${x.sec.toFixed(0)}s`).join(", ")) && pass;
pass = ok("pictures average under 11 seconds", avg <= 11, `${avg.toFixed(1)}s across ${spoken.length} screens`) && pass;
pass = ok("the tour has enough to look at", spoken.length >= m.stops.length * 5, `${spoken.length} screens for ${m.stops.length} stops`) && pass;
console.log(`[p10] ${spoken.length} screens, ${(total / 60).toFixed(1)} min, longest ${Math.max(...spoken.map((x) => x.sec)).toFixed(0)}s`);
if (!pass) process.exit(1);
