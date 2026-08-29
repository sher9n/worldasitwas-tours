/**
 * Mock provider: produces placeholder files locally so the whole pipeline and
 * the player can be exercised without spending. Images are SVG cards that show
 * the prompt; video and audio use ffmpeg when it is installed, else are omitted.
 */
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Ledger } from "../ledger.ts";
import type { Asset, MediaProvider } from "./types.ts";

const run = promisify(execFile);

async function hasFfmpeg(): Promise<boolean> {
  try {
    await run("ffmpeg", ["-version"]);
    return true;
  } catch {
    return false;
  }
}

const DIMS: Record<string, [number, number]> = { "9:16": [1080, 1920], "1:1": [1080, 1080], "16:9": [1920, 1080] };

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function wrap(text: string, width: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    if ((cur + " " + w).trim().length > width) {
      lines.push(cur.trim());
      cur = w;
    } else cur = cur + " " + w;
    if (lines.length >= 14) break;
  }
  if (cur.trim() && lines.length < 14) lines.push(cur.trim());
  return lines;
}

export class MockProvider implements MediaProvider {
  readonly name = "mock" as const;
  private ffmpeg: Promise<boolean>;

  constructor(
    private workDir: string,
    private ledger: Ledger,
  ) {
    this.ffmpeg = hasFfmpeg();
  }

  private async file(ext: string): Promise<string> {
    await fs.mkdir(this.workDir, { recursive: true });
    return path.join(this.workDir, `mock-${crypto.randomBytes(5).toString("hex")}.${ext}`);
  }

  private async svg(label: string, prompt: string, aspect: string, hue: number, stage: string, note: string): Promise<Asset> {
    const [w, h] = DIMS[aspect] ?? DIMS["9:16"];
    const lines = wrap(prompt, Math.floor(w / 26));
    const body = lines.map((l, i) => `<text x="60" y="${Math.round(h * 0.42) + i * 40}" font-size="30" fill="#fff" font-family="Helvetica, Arial, sans-serif">${esc(l)}</text>`).join("");
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="hsl(${hue},30%,28%)"/><stop offset="1" stop-color="hsl(${hue},40%,12%)"/></linearGradient></defs>
<rect width="100%" height="100%" fill="url(#g)"/>
<text x="60" y="${Math.round(h * 0.3)}" font-size="54" font-weight="bold" fill="#fff" font-family="Helvetica, Arial, sans-serif">${esc(label)}</text>
${body}
<text x="60" y="${h - 60}" font-size="26" fill="#ccc" font-family="Helvetica, Arial, sans-serif">MOCK MEDIA (no model was called)</text>
</svg>`;
    const p = await this.file("svg");
    await fs.writeFile(p, svg);
    await this.ledger.add({ stage, provider: "mock", endpoint: "mock.image", note, units: 1, unitType: "image", rateUsd: 0, estimated: false, ms: 1, output: p });
    return { localPath: p, mime: "image/svg+xml", width: w, height: h };
  }

  image(o: { prompt: string; aspect: string; quality: string; stage: string; note: string }) {
    return this.svg("Reconstruction", o.prompt, o.aspect, 25, o.stage, o.note);
  }
  imageWithRefs(o: { prompt: string; refs: string[]; aspect: string; quality: string; stage: string; note: string }) {
    return this.svg("Reconstruction (with refs)", o.prompt, o.aspect, 200, o.stage, o.note);
  }
  editImage(o: { prompt: string; source: string; aspect: string; quality: string; stage: string; note: string }) {
    return this.svg("Then (edited from now)", o.prompt, o.aspect, 35, o.stage, o.note);
  }

  async video(o: { prompt: string; imageUrl: string; durationSec: number; quality: string; audio: boolean; stage: string; note: string }): Promise<Asset> {
    const dur = Math.max(4, Math.round(o.durationSec));
    if (!(await this.ffmpeg)) {
      await this.ledger.add({ stage: o.stage, provider: "mock", endpoint: "mock.video", note: o.note + " (ffmpeg missing, no file)", units: dur, unitType: "seconds", rateUsd: 0, estimated: false, ms: 1 });
      return { mime: "video/mp4", durationSec: dur };
    }
    const p = await this.file("mp4");
    const args = ["-y", "-f", "lavfi", "-i", `color=c=0x2b3a44:s=480x864:d=${dur}:r=24`];
    if (o.audio) args.push("-f", "lavfi", "-i", `sine=frequency=110:duration=${dur}`, "-c:a", "aac", "-shortest");
    args.push("-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", p);
    await run("ffmpeg", args);
    await this.ledger.add({ stage: o.stage, provider: "mock", endpoint: "mock.video", note: o.note, units: dur, unitType: "seconds", rateUsd: 0, estimated: false, ms: 1, output: p });
    return { localPath: p, mime: "video/mp4", durationSec: dur };
  }

  async talkingPortrait(o: { imageUrl: string; audioUrl: string; quality: string; stage: string; note: string }): Promise<Asset> {
    return this.video({ prompt: "talking portrait", imageUrl: o.imageUrl, durationSec: 6, quality: o.quality, audio: true, stage: o.stage, note: o.note });
  }

  private async tone(dur: number, freq: number, stage: string, note: string, endpoint: string): Promise<Asset> {
    if (!(await this.ffmpeg)) {
      await this.ledger.add({ stage, provider: "mock", endpoint, note: note + " (ffmpeg missing, no file)", units: dur, unitType: "seconds", rateUsd: 0, estimated: false, ms: 1 });
      return { mime: "audio/mp4", durationSec: dur };
    }
    const p = await this.file("m4a");
    await run("ffmpeg", ["-y", "-f", "lavfi", "-i", `sine=frequency=${freq}:duration=${dur}`, "-af", "volume=0.15", "-c:a", "aac", p]);
    await this.ledger.add({ stage, provider: "mock", endpoint, note, units: dur, unitType: "seconds", rateUsd: 0, estimated: false, ms: 1, output: p });
    return { localPath: p, mime: "audio/mp4", durationSec: dur };
  }

  tts(o: { text: string; voice: string; stage: string; note: string }) {
    const dur = Math.max(2, Math.round(o.text.length / 15));
    return this.tone(dur, 330, o.stage, o.note, "mock.tts");
  }
  sfx(o: { text: string; durationSec: number; loop: boolean; stage: string; note: string }) {
    return this.tone(Math.min(22, o.durationSec), 80, o.stage, o.note, "mock.sfx");
  }

  async publish(localPath: string): Promise<string> {
    return "file://" + localPath;
  }
}
