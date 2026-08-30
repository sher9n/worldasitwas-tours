/**
 * Rebuilds a presence loop from segments that already exist.
 *
 * The expensive half of a presence loop is the generated segments; joining them
 * and closing the loop is ffmpeg and costs nothing. This re-does only that half,
 * so encode settings can be changed, or a loop rebuilt after a crash, without
 * paying for the performance again.
 *
 *   tsx src/tools/relink-presence.ts <segments-dir> <out.mp4> [dissolveSec]
 *
 * Segments are taken in filename order and must already run on from one
 * another (each generated from the last frame of the one before).
 */
import fs from "node:fs/promises";
import path from "node:path";
import { joinClips, loopJoin, probeDuration } from "../ffmpeg.ts";

const [dir, out, dissolve] = process.argv.slice(2);
if (!dir || !out) {
  console.error("usage: relink-presence <segments-dir> <out.mp4> [dissolveSec]");
  process.exit(1);
}

// The intermediate and the finished loop must never be mistaken for segments:
// writing the output into the segments directory is the obvious thing to do, and
// without this a second run would fold the previous result back in on itself.
const joined = path.join(dir, "joined.mp4");
const outAbs = path.resolve(out);
const segments = (await fs.readdir(dir))
  .map((f) => path.join(dir, f))
  .filter((f) => f.endsWith(".mp4") && path.resolve(f) !== outAbs && path.resolve(f) !== path.resolve(joined))
  .sort();
if (segments.length === 0) throw new Error(`no .mp4 segments in ${dir}`);

await joinClips(segments, joined, 720);
await loopJoin(joined, out, dissolve ? Number(dissolve) : 1);

const secs = await probeDuration(out);
const { size } = await fs.stat(out);
console.log(
  `${segments.length} segments -> ${secs?.toFixed(1)}s, ${(size / 1024 / 1024).toFixed(1)} MB  ${path.basename(out)}`,
);
