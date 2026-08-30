/**
 * The console and the player share one stylesheet and one document.
 *
 * The player's classes are written for a full-bleed phone screen — several are
 * absolutely positioned layers with dark scrims over `inset: 0`. When a shell
 * class accidentally matches one of them the result is not a small visual bug:
 * `.walk` once turned every row of the walk chooser into a full-page overlay
 * and the entire console went black. Nothing failed; it just rendered wrong.
 *
 * So the two vocabularies are kept disjoint, and this proves it.
 */
const fs = require("fs");
const path = require("path");

const file = path.resolve(__dirname, "../apps/playground/src/styles.css");
const css = fs.readFileSync(file, "utf8").split("\n");

const at = (needle) => css.findIndex((l) => l.includes(needle));
const playerStart = css.findIndex((l) => l.trim() === "/* player */");
const playerEnd = at("integration tabs");

if (playerStart < 0 || playerEnd < 0 || playerEnd < playerStart) {
  console.error("[css] FAIL cannot find the player section markers in styles.css");
  process.exit(1);
}

// Comments are stripped first: this file's own prose names the classes it is
// warning about, and a checker that trips on its own documentation is useless.
const strip = (text) => text.replace(/\/\*[\s\S]*?\*\//g, " ");
const classesIn = (text) => new Set([...strip(text).matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1]));
const player = classesIn(css.slice(playerStart, playerEnd).join("\n"));
const shell = classesIn([...css.slice(0, playerStart), ...css.slice(playerEnd)].join("\n"));

/**
 * Shared on purpose. `on` is only ever a modifier on an already-scoped
 * selector on both sides, and `player` is how the shell sizes the player.
 */
const ALLOWED = new Set(["on", "player"]);

const clash = [...player].filter((c) => shell.has(c) && !ALLOWED.has(c)).sort();

if (clash.length === 0) {
  console.log(`[css] PASS the console and the player share no class names (${player.size} player, ${shell.size} shell)`);
  process.exit(0);
}
console.error("[css] FAIL these class names are used by BOTH the player and the console shell:");
for (const c of clash) console.error(`         .${c}`);
console.error("         Rename the console's copy. The player owns its vocabulary.");
process.exit(1);
