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
