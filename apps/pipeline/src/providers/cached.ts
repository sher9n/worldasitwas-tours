/**
 * Asset cache in front of a media provider. The key is the exact request
 * (method + arguments, minus bookkeeping fields), so a prompt is paid for once:
 * re-running a stage, or running it step by step, never regenerates an asset
 * that already exists. Remote results are also downloaded so the tour can be
 * assembled even if the provider's URL later expires.
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { Ledger } from "../ledger.ts";
import type { Asset, MediaProvider } from "./types.ts";

type Args = Record<string, unknown>;

function stable(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(stable).join(",") + "]";
  if (value && typeof value === "object") {
    return "{" + Object.keys(value as Args).sort().map((k) => JSON.stringify(k) + ":" + stable((value as Args)[k])).join(",") + "}";
  }
  return JSON.stringify(value);
}

const EXT: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/svg+xml": "svg", "video/mp4": "mp4", "audio/mpeg": "mp3", "audio/mp4": "m4a", "audio/wav": "wav" };

export class CachedProvider implements MediaProvider {
  readonly name: "fal" | "mock";
  hits = 0;
  misses = 0;

  constructor(
    private inner: MediaProvider,
    private dir: string,
    private ledger: Ledger,
  ) {
    this.name = inner.name;
  }

  private async through<A extends Args>(method: string, args: A, fn: (a: A) => Promise<Asset>): Promise<Asset> {
    const { stage, note, ...rest } = args as Args & { stage?: string; note?: string };
    // Image methods depend on which image model is configured; video, speech and sound do not.
    const scope = /^(image|imageWithRefs|editImage)$/.test(method) ? this.inner.variant ?? this.inner.name : this.inner.name;
    const key = crypto.createHash("sha1").update(scope + ":" + method + ":" + stable(rest)).digest("hex").slice(0, 16);
    await fs.mkdir(this.dir, { recursive: true });
    const metaFile = path.join(this.dir, `${key}.json`);
    try {
      const cached = JSON.parse(await fs.readFile(metaFile, "utf8")) as Asset;
      if (cached.localPath) await fs.access(cached.localPath);
      this.hits++;
      await this.ledger.add({ stage: String(stage ?? method), provider: this.inner.name, endpoint: `cache:${method}`, note: `${note ?? ""} (cached ${key})`, units: 1, unitType: "asset", rateUsd: 0, estimated: false, ms: 0, output: cached.localPath ?? cached.remoteUrl });
      return cached;
    } catch {
      // miss
    }
    this.misses++;
    const asset = await fn(args);
    if (asset.remoteUrl && !asset.localPath) {
      try {
        const res = await fetch(asset.remoteUrl);
        if (res.ok) {
          const ext = EXT[asset.mime] ?? "bin";
          const local = path.join(this.dir, `${key}.${ext}`);
          await fs.writeFile(local, Buffer.from(await res.arrayBuffer()));
          asset.localPath = local;
        }
      } catch {
        // keep the remote URL only
      }
    }
    if (asset.localPath || asset.remoteUrl) await fs.writeFile(metaFile, JSON.stringify(asset));
    return asset;
  }

  image(o: Parameters<MediaProvider["image"]>[0]) {
    return this.through("image", o, (a) => this.inner.image(a));
  }
  imageWithRefs(o: Parameters<MediaProvider["imageWithRefs"]>[0]) {
    return this.through("imageWithRefs", o, (a) => this.inner.imageWithRefs(a));
  }
  editImage(o: Parameters<MediaProvider["editImage"]>[0]) {
    return this.through("editImage", o, (a) => this.inner.editImage(a));
  }
  video(o: Parameters<MediaProvider["video"]>[0]) {
    return this.through("video", o, (a) => this.inner.video(a));
  }
  talkingPortrait(o: Parameters<MediaProvider["talkingPortrait"]>[0]) {
    return this.through("talkingPortrait", o, (a) => this.inner.talkingPortrait(a));
  }
  tts(o: Parameters<MediaProvider["tts"]>[0]) {
    return this.through("tts", o, (a) => this.inner.tts(a));
  }
  sfx(o: Parameters<MediaProvider["sfx"]>[0]) {
    return this.through("sfx", o, (a) => this.inner.sfx(a));
  }
  publish(localPath: string, mime: string) {
    return this.inner.publish(localPath, mime);
  }

  /** Download an external image (politely) and re-host it with the provider, once. */
  async mirrorUrl(url: string, mime = "image/jpeg"): Promise<string> {
    const key = crypto.createHash("sha1").update(this.inner.name + ":mirror:" + url).digest("hex").slice(0, 16);
    await fs.mkdir(this.dir, { recursive: true });
    const metaFile = path.join(this.dir, `${key}.json`);
    try {
      const cached = JSON.parse(await fs.readFile(metaFile, "utf8")) as Asset;
      if (cached.remoteUrl) return cached.remoteUrl;
    } catch {
      // miss
    }
    const res = await fetch(url, { headers: { "User-Agent": "TimeTravelTours/0.1 (tour engine prototype) node-fetch" } });
    if (!res.ok) throw new Error(`mirror download ${url}: ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const ext = EXT[mime] ?? "jpg";
    const local = path.join(this.dir, `${key}.${ext}`);
    await fs.writeFile(local, buf);
    const remote = await this.inner.publish(local, mime);
    await fs.writeFile(metaFile, JSON.stringify({ remoteUrl: remote, localPath: local, mime }));
    return remote;
  }
}
