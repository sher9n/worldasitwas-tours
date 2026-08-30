/**
 * The presence loop is assembled deterministically, so it can be tested
 * deterministically: these build clips with ffmpeg itself and check the
 * arithmetic and the join, with no provider and no spend.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { FFMPEG, ffmpeg, ffmpegAvailable, joinClips, lastFrame, loopJoin, probeDuration } from "./ffmpeg.ts";

const have = await ffmpegAvailable();

/** Mean brightness of the difference between two pictures: 0 is identical. */
async function difference(a: string, b: string): Promise<number> {
  const report: string = await new Promise((ok) => {
    execFile(
      FFMPEG,
      ["-hide_banner", "-loglevel", "info", "-i", a, "-i", b, "-filter_complex",
        "[0][1]blend=all_mode=difference,signalstats,metadata=print:key=lavfi.signalstats.YAVG", "-f", "null", "-"],
      (_err, _out, stderr) => ok(String(stderr)),
    );
  });
  const m = /YAVG=([\d.]+)/.exec(report);
  return m ? Number(m[1]) : Number.NaN;
}

/** A clip whose picture changes steadily, so a bad join shows up as a jump. */
async function testClip(file: string, seconds: number): Promise<void> {
  await ffmpeg(["-y", "-f", "lavfi", "-i", `testsrc2=size=240x240:rate=24:duration=${seconds}`,
    "-c:v", "libx264", "-crf", "18", "-pix_fmt", "yuv420p", file]);
}

test("joinClips drops the frame the segments share", { skip: !have && "ffmpeg not available" }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tt-join-"));
  const parts = [1, 2, 3].map((n) => path.join(dir, `p${n}.mp4`));
  for (const p of parts) await testClip(p, 3);
  const out = path.join(dir, "joined.mp4");
  await joinClips(parts, out, 240);
  const secs = (await probeDuration(out)) ?? 0;
  // Three three-second parts, less the duplicated first frame of parts two and
  // three (a frame is 1/24s), so a shade under nine seconds.
  assert.ok(secs > 8.8 && secs < 9.0, `expected just under 9s, got ${secs}`);
  await fs.rm(dir, { recursive: true, force: true });
});

test("loopJoin makes the end meet the beginning", { skip: !have && "ffmpeg not available" }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tt-loop-"));
  const src = path.join(dir, "src.mp4");
  const out = path.join(dir, "loop.mp4");
  await testClip(src, 6);
  await loopJoin(src, out, 1);

  const secs = (await probeDuration(out)) ?? 0;
  assert.ok(Math.abs(secs - 5) < 0.15, `expected 6s minus the 1s dissolve, got ${secs}`);

  // The join is only invisible if going round again changes the picture no more
  // than an ordinary step between neighbouring frames does.
  const frames = path.join(dir, "f");
  await fs.mkdir(frames);
  await ffmpeg(["-y", "-i", out, "-fps_mode", "passthrough", path.join(frames, "%04d.png")]);
  const list = (await fs.readdir(frames)).sort().map((f) => path.join(frames, f));
  const seam = await difference(list[list.length - 1], list[0]);
  const step = await difference(list[Math.floor(list.length / 2)], list[Math.floor(list.length / 2) + 1]);
  assert.ok(seam <= step * 2.2, `loop join stands out: seam ${seam} against a normal step of ${step}`);

  // The unjoined clip is the control: without this the test would pass on a
  // source that happened to end where it started.
  const rawFrames = path.join(dir, "r");
  await fs.mkdir(rawFrames);
  await ffmpeg(["-y", "-i", src, "-fps_mode", "passthrough", path.join(rawFrames, "%04d.png")]);
  const raw = (await fs.readdir(rawFrames)).sort().map((f) => path.join(rawFrames, f));
  const rawSeam = await difference(raw[raw.length - 1], raw[0]);
  assert.ok(rawSeam > seam, `the source already looped, so this proves nothing (${rawSeam} vs ${seam})`);

  await fs.rm(dir, { recursive: true, force: true });
});

test("lastFrame reads the picture a clip ends on", { skip: !have && "ffmpeg not available" }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tt-last-"));
  const src = path.join(dir, "src.mp4");
  await testClip(src, 4);
  const got = path.join(dir, "last.jpg");
  await lastFrame(src, got);
  assert.ok((await fs.stat(got)).size > 0, "no picture was written");

  // It must be the END of the clip, not the beginning: seeding the next segment
  // with the wrong frame is how a chained performance turns into a cut.
  const first = path.join(dir, "first.jpg");
  await ffmpeg(["-y", "-i", src, "-frames:v", "1", "-q:v", "2", first]);
  assert.ok(await difference(got, first) > 1, "lastFrame returned the opening frame");
  await fs.rm(dir, { recursive: true, force: true });
});
