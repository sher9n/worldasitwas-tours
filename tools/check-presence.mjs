/**
 * Checks every guide's presence loop.
 *
 *   node tools/check-presence.mjs
 *
 * Three things decide whether a loop is good, and all three can be measured:
 *
 *   length   it must be long enough that a traveller does not learn it
 *   motion   it must actually move; the first attempt at this looked stiff and
 *            the number said so (0.07 against 4.26) long before anyone did
 *   seam     going round again must change the picture no more than an
 *            ordinary step between neighbouring frames does
 *
 * Motion and seam are both the mean brightness of the difference between two
 * pictures, so they are directly comparable: that is the whole point of
 * measuring the seam against the clip's own typical frame step rather than
 * against a fixed number, because a lively clip moves more between every pair
 * of frames and a fixed threshold would fail it for being alive.
 */
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MIN_SECONDS = 30;
const MIN_MOTION = 1.0;
const SEAM_ALLOWANCE = 2.2;

const run = (bin, args) =>
  new Promise((ok) => execFile(bin, args, (err, stdout, stderr) => ok(String(stdout) + String(stderr))));

const yavg = (report) => [...report.matchAll(/YAVG=([\d.]+)/g)].map((m) => Number(m[1]));

async function seconds(file) {
  const out = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]);
  return Number(out.trim());
}

/** Mean change from each frame to the next, over the whole clip. */
async function motion(file) {
  const v = yavg(
    await run("ffmpeg", ["-hide_banner", "-loglevel", "info", "-i", file, "-vf",
      "scale=160:160,tblend=all_mode=difference,signalstats,metadata=print:key=lavfi.signalstats.YAVG", "-f", "null", "-"]),
  );
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0;
}

async function difference(a, b) {
  const v = yavg(
    await run("ffmpeg", ["-hide_banner", "-loglevel", "info", "-i", a, "-i", b, "-filter_complex",
      "[0][1]blend=all_mode=difference,signalstats,metadata=print:key=lavfi.signalstats.YAVG", "-f", "null", "-"]),
  );
  return v.length ? v[0] : Number.NaN;
}

/** The loop join, and the clip's own typical frame step to judge it against. */
async function seam(file) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tt-seam-"));
  await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", file, "-vf", "scale=160:160",
    "-fps_mode", "passthrough", path.join(dir, "%04d.png"), "-y"]);
  const f = (await fs.readdir(dir)).sort().map((x) => path.join(dir, x));
  const join = await difference(f[f.length - 1], f[0]);
  const steps = [];
  for (let i = 0; i < f.length - 1; i += Math.max(1, Math.floor(f.length / 12))) steps.push(await difference(f[i], f[i + 1]));
  steps.sort((a, b) => a - b);
  await fs.rm(dir, { recursive: true, force: true });
  return { join, typical: steps[Math.floor(steps.length / 2)] };
}

const recipes = (await fs.readdir(path.join(root, "content/recipes"))).filter((f) => f.endsWith(".json")).sort();
let good = 0;
let bad = 0;
// console.log has no width specifiers, so the columns are padded by hand.
const row = (a, b, c, d, e, f) =>
  console.log(`${a.padEnd(19)}${b.padStart(8)}${c.padStart(9)}${d.padStart(8)}${e.padStart(9)}  ${f}`);
row("guide", "seconds", "motion", "seam", "typical", "verdict");

for (const file of recipes) {
  const recipe = JSON.parse(await fs.readFile(path.join(root, "content/recipes", file), "utf8"));
  const slug = recipe.companion.name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const loop = path.join(root, "content/companions", slug, "reel/presence.mp4");
  try {
    await fs.access(loop);
  } catch {
    row(slug, "-", "-", "-", "-", "FAIL: no presence loop");
    bad++;
    continue;
  }
  const [secs, move, join] = [await seconds(loop), await motion(loop), await seam(loop)];
  const problems = [];
  if (secs < MIN_SECONDS) problems.push(`only ${secs.toFixed(1)}s`);
  if (move < MIN_MOTION) problems.push(`barely moves (${move.toFixed(2)})`);
  if (join.join > join.typical * SEAM_ALLOWANCE) problems.push("visible loop join");
  problems.length ? bad++ : good++;
  row(
    slug, secs.toFixed(1), move.toFixed(2), join.join.toFixed(2), join.typical.toFixed(2),
    problems.length ? `FAIL: ${problems.join(", ")}` : "ok",
  );
}

console.log(`\n${good}/${recipes.length} loops good`);
process.exit(bad ? 1 : 0);
