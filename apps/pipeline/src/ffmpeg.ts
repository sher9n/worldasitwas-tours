import path from "node:path";
import fs from "node:fs/promises";
/**
 * ffmpeg and ffprobe binaries. Prefers the static builds shipped with the
 * repo's dependencies (identical on a laptop and inside a Railway container),
 * falls back to whatever is on PATH.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";

const run = promisify(execFile);
const require = createRequire(import.meta.url);

function staticPath(pkg: string, field?: string): string | undefined {
  try {
    const mod = require(pkg) as unknown;
    if (typeof mod === "string") return mod;
    if (mod && typeof mod === "object" && field && typeof (mod as Record<string, unknown>)[field] === "string") {
      return (mod as Record<string, string>)[field];
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export const FFMPEG = process.env.FFMPEG_PATH || staticPath("ffmpeg-static") || "ffmpeg";
export const FFPROBE = process.env.FFPROBE_PATH || staticPath("ffprobe-static", "path") || "ffprobe";

let available: Promise<boolean> | undefined;
export function ffmpegAvailable(): Promise<boolean> {
  if (!available) {
    available = run(FFMPEG, ["-version"])
      .then(() => true)
      .catch(() => false);
  }
  return available;
}

export async function ffmpeg(args: string[]): Promise<void> {
  await run(FFMPEG, args, { maxBuffer: 16 * 1024 * 1024 });
}

/** Media duration in seconds, or undefined if ffprobe cannot read the file. */
export async function probeDuration(file: string): Promise<number | undefined> {
  try {
    const { stdout } = await run(FFPROBE, ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file]);
    const n = Number(stdout.trim());
    return Number.isFinite(n) && n > 0 ? Math.round(n * 10) / 10 : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Brings one recording to a fixed loudness, so nothing in a walk is louder or
 * quieter than anything else, with the peak held clear of clipping.
 */
export async function levelAudio(file: string, targetLufs: number): Promise<void> {
  const tmp = file.replace(/\.(\w+)$/, ".level.$1");
  const run = (args: string[]): Promise<string> =>
    new Promise((ok, bad) => {
      execFile(FFMPEG, args, (err, _out, stderr) => (err ? bad(err) : ok(String(stderr))));
    });
  const shaped = file.replace(/\.(\w+)$/, ".shaped.$1");
  try {
    // Most publishes re-copy recordings that were levelled the last time round.
    // One measurement is far cheaper than compressing and re-encoding a file
    // that is already where it should be.
    const already = await run(["-i", file, "-af", "ebur128=framelog=quiet", "-f", "null", "-"]);
    const level = Number(already.match(/I:\s+(-?\d+(?:\.\d+)?) LUFS/)?.[1]);
    if (Number.isFinite(level) && Math.abs(level - targetLufs) <= 0.4) return;
    // Compress first, because it changes the loudness; then measure what came
    // out; then apply exactly the gain that brings THAT to the target. Measuring
    // before compressing computes the gain for a signal that no longer exists,
    // and lines land two decibels apart, which on a phone is heard as the voice
    // rising and falling between sentences for no reason.
    // Light compression evens a line out on a phone speaker; the limiter holds
    // the peak below clipping, which is what turns a crackle into a bang.
    await run(["-y", "-i", file, "-af", "acompressor=threshold=-18dB:ratio=3:attack=5:release=120", "-ar", "44100", "-b:a", "128k", shaped]);
    const report = await run(["-i", shaped, "-af", "ebur128=framelog=quiet", "-f", "null", "-"]);
    const measured = Number(report.match(/I:\s+(-?\d+(?:\.\d+)?) LUFS/)?.[1]);
    if (!Number.isFinite(measured)) throw new Error("could not measure loudness");
    await run(["-y", "-i", shaped, "-af", `volume=${(targetLufs - measured).toFixed(2)}dB,alimiter=limit=0.9`, "-ar", "44100", "-b:a", "128k", tmp]);
    await fs.rm(shaped, { force: true });
    await fs.rename(tmp, file);
  } catch (err) {
    await fs.rm(shaped, { force: true });
    await fs.rm(tmp, { force: true });
    console.warn(`[assemble] could not level ${path.basename(file)}: ${(err as Error).message}`);
  }
}

/**
 * Cuts a uniform light border off a picture and squares what is left.
 *
 * The image model occasionally returns a tall photograph centred on a square
 * canvas, padded with white. Left alone, that shows as white bars beside the
 * guide inside her round frame, and any clip made from the picture inherits
 * them. Nothing happens to a picture that has no border.
 */
export async function trimBorder(file: string): Promise<boolean> {
  const run = (args: string[]): Promise<string> =>
    new Promise((ok, bad) => {
      execFile(FFMPEG, args, (err, _out, stderr) => (err ? bad(err) : ok(String(stderr))));
    });
  try {
    // cropdetect looks for a dark border, so the picture is inverted first and
    // the box it finds is the box of the real content.
    const report = await run(["-i", file, "-vf", "negate,cropdetect=limit=24:round=2:reset=1", "-frames:v", "3", "-f", "null", "-"]);
    const found = [...report.matchAll(/crop=(\d+):(\d+):(\d+):(\d+)/g)].pop();
    if (!found) return false;
    const [w, h, x, y] = found.slice(1).map(Number);
    const probe = await run(["-i", file, "-f", "null", "-"]);
    const size = probe.match(/, (\d+)x(\d+)/);
    if (!size) return false;
    const [full, fw, fh] = [size[0], Number(size[1]), Number(size[2])];
    void full;
    // A border of a few pixels is not worth touching, and neither is a crop
    // that would throw away most of the picture.
    if ((fw - w < 8 && fh - h < 8) || w < fw * 0.4 || h < fh * 0.4) return false;
    const side = Math.min(w, h);
    const cx = x + Math.round((w - side) / 2);
    const cy = y + Math.round((h - side) / 2);
    const tmp = file.replace(/\.(\w+)$/, ".trim.$1");
    await run(["-y", "-i", file, "-vf", `crop=${side}:${side}:${cx}:${cy}`, "-q:v", "2", tmp]);
    await fs.rename(tmp, file);
    console.log(`[media] trimmed a ${fw - w}px border off ${path.basename(file)}`);
    return true;
  } catch {
    // an untrimmed picture is still a picture
    return false;
  }
}

/** The last decoded frame of a clip, written as a JPEG. Seeds the next segment. */
export async function lastFrame(video: string, out: string): Promise<void> {
  const secs = (await probeDuration(video)) ?? 0;
  // sseof seeks from the end, so this does not depend on knowing the frame rate.
  await ffmpeg(["-y", "-sseof", "-0.2", "-i", video, "-update", "1", "-frames:v", "1", "-q:v", "2", out]);
  if (!secs) return;
}

/**
 * Joins segments that already run on from one another.
 *
 * Each segment after the first was generated FROM the last frame of the one
 * before, so that frame is present at both ends of the join. The duplicate is
 * dropped, otherwise the picture holds still for two frames every ten seconds
 * and reads as a stutter.
 */
export async function joinClips(files: string[], out: string, size: number): Promise<void> {
  const parts = files.map((_, i) => `[${i}:v]scale=${size}:${size},setsar=1${i ? ",trim=start_frame=1" : ""},setpts=PTS-STARTPTS[v${i}]`);
  const chain = files.map((_, i) => `[v${i}]`).join("");
  await ffmpeg([
    "-y",
    ...files.flatMap((f) => ["-i", f]),
    "-filter_complex", `${parts.join(";")};${chain}concat=n=${files.length}:v=1[out]`,
    "-map", "[out]", "-an",
    // An intermediate: loopJoin encodes it again, so this stays near-lossless
    // and the compression budget is spent once, at the end.
    "-c:v", "libx264", "-crf", "18", "-preset", "veryfast", "-pix_fmt", "yuv420p",
    out,
  ]);
}

/**
 * Turns any clip into one that loops without a visible join.
 *
 *   head = [0,d)   mid = [d,T-d)   tail = [T-d,T)
 *   out  = crossfade(tail -> head) ++ mid
 *
 * The result ends on the frame at T-d and begins on the frame at T-d, so
 * going round again is an ordinary step from one frame to the next.
 *
 * This is why nothing upstream has to hold still. Asking a video model to end
 * in the pose it started in is a heavy instruction: under it the model plays
 * safe and the guide barely moves, which is exactly the stiffness this
 * replaces. Let her perform, and close the loop here instead.
 */
export async function loopJoin(file: string, out: string, dissolveSec = 1, size = 540): Promise<void> {
  const T = await probeDuration(file);
  if (!T || T <= dissolveSec * 3) {
    await fs.copyFile(file, out);
    return;
  }
  const d = dissolveSec;
  await ffmpeg([
    "-y", "-i", file,
    "-filter_complex",
    // Scaled here rather than in joinClips, so the join works on the full
    // picture and only the delivered file is reduced.
    `[0:v]scale=${size}:${size}[s];[s]split=3[h][m][t];` +
      `[h]trim=0:${d},setpts=PTS-STARTPTS[head];` +
      `[m]trim=${d}:${T - d},setpts=PTS-STARTPTS[mid];` +
      `[t]trim=${T - d}:${T},setpts=PTS-STARTPTS[tail];` +
      `[tail][head]xfade=transition=fade:duration=${d}:offset=0[bl];` +
      `[bl][mid]concat=n=2:v=1[out]`,
    "-map", "[out]", "-an",
    // This file is fetched at the start of every walk and plays inside a circle
    // that is never wider than 132px, so it is encoded for that rather than for
    // a full screen: 540 square covers even a 3x display with room to spare,
    // and the download is a third of what 720 costs. A keyframe every second
    // because looping seeks back to zero, and on a clip whose only keyframe is
    // at the start that seek can drop a frame.
    "-c:v", "libx264", "-crf", "28", "-preset", "slow", "-pix_fmt", "yuv420p",
    "-g", "24", "-keyint_min", "24", "-movflags", "+faststart",
    out,
  ]);
}
