import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { fal } from "@fal-ai/client";
import type { Ledger } from "../ledger.ts";
import { metered } from "../ledger.ts";
import { RATES, seedanceCost } from "../prices.ts";
import type { Asset, MediaProvider } from "./types.ts";

interface FalImage {
  url: string;
  width?: number;
  height?: number;
  content_type?: string;
}

const ASPECT_TO_GPT_SIZE: Record<string, string> = {
  "9:16": "portrait_16_9",
  "1:1": "square_hd",
  "16:9": "landscape_16_9",
};

export type ImageModel = "gpt-image-2" | "nano-banana-pro";

export class FalProvider implements MediaProvider {
  readonly name = "fal" as const;
  readonly variant: string;
  private imageModel: ImageModel;

  constructor(
    key: string,
    private ledger: Ledger,
    opts: { imageModel?: ImageModel } = {},
  ) {
    if (!key) throw new Error("FAL_KEY is not set");
    fal.config({ credentials: key });
    this.imageModel = opts.imageModel ?? "gpt-image-2";
    this.variant = `fal:${this.imageModel}`;
  }

  /**
   * How many calls may be in flight. The old limit of three was set when fal's
   * balance lock flickered under bursts; with speech now the whole cost of a
   * rebuild, waiting one call at a time is the difference between a two minute
   * job and a ten minute one. Retries still cover a transient lock.
   */
  private static readonly IN_FLIGHT = 8;
  private inFlight = 0;
  private waiters: Array<() => void> = [];
  private async slot<T>(fn: () => Promise<T>): Promise<T> {
    if (this.inFlight >= FalProvider.IN_FLIGHT) await new Promise<void>((ok) => this.waiters.push(ok));
    this.inFlight++;
    try {
      return await fn();
    } finally {
      this.inFlight--;
      this.waiters.shift()?.();
    }
  }

  private async run<T>(endpoint: string, input: Record<string, unknown>): Promise<T> {
    let lastErr: Error | undefined;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        return await this.slot(async () => {
          const res = await fal.subscribe(endpoint, { input, logs: false });
          return res.data as T;
        });
      } catch (err) {
        // fal's ApiError carries the validation detail in body; surface it so the ledger says why.
        const e = err as Error & { status?: number; body?: unknown };
        const detail = e.body ? JSON.stringify(e.body).slice(0, 400) : "";
        lastErr = new Error(`${endpoint} ${e.status ?? ""} ${e.message}${detail ? ": " + detail : ""}`.trim());
        const transient = e.status === 429 || (e.status ?? 0) >= 500 || (e.status === 403 && /TOP_UP/.test(detail));
        if (transient && attempt < 3) {
          await new Promise((ok) => setTimeout(ok, 5000 * (attempt + 1)));
          continue;
        }
        throw lastErr;
      }
    }
    throw lastErr;
  }

  /** Nano Banana Pro text-to-image (and reference-guided edit when refs are given). */
  private async nanoImage(o: { prompt: string; refs?: string[]; aspect: string; quality: string; stage: string; note: string }): Promise<Asset> {
    const resolution = o.quality === "final" ? "2K" : "1K";
    const endpoint = o.refs?.length ? "fal-ai/gemini-3-pro-image-preview/edit" : "fal-ai/gemini-3-pro-image-preview";
    return metered(this.ledger, { stage: o.stage, provider: "fal", endpoint, note: o.note }, async () => {
      const input: Record<string, unknown> = { prompt: o.prompt, resolution, aspect_ratio: o.aspect, output_format: "jpeg", num_images: 1 };
      if (o.refs?.length) input.image_urls = o.refs.slice(0, 14);
      const data = await this.run<{ images: FalImage[] }>(endpoint, input);
      const img = data.images[0];
      return {
        result: { remoteUrl: img.url, mime: img.content_type ?? "image/jpeg", width: img.width ?? undefined, height: img.height ?? undefined },
        units: 1,
        unitType: "image",
        rateUsd: RATES.nanoBananaPro[resolution],
        output: img.url,
      };
    });
  }

  async image(o: { prompt: string; aspect: string; quality: string; stage: string; note: string }): Promise<Asset> {
    if (this.imageModel === "nano-banana-pro") return this.nanoImage(o);
    const q = o.quality === "final" ? "high" : "low";
    return metered(this.ledger, { stage: o.stage, provider: "fal", endpoint: "openai/gpt-image-2", note: o.note }, async () => {
      const data = await this.run<{ images: FalImage[] }>("openai/gpt-image-2", {
        prompt: o.prompt,
        quality: q,
        image_size: ASPECT_TO_GPT_SIZE[o.aspect] ?? "portrait_16_9",
        output_format: "jpeg",
        num_images: 1,
      });
      const img = data.images[0];
      const mult = o.aspect === "1:1" ? 1 : 1.5;
      return {
        result: { remoteUrl: img.url, mime: img.content_type ?? "image/jpeg", width: img.width ?? undefined, height: img.height ?? undefined },
        units: 1,
        unitType: "image",
        rateUsd: RATES.gptImage2[q] * mult,
        output: img.url,
      };
    });
  }

  async imageWithRefs(o: { prompt: string; refs: string[]; aspect: string; quality: string; stage: string; note: string }): Promise<Asset> {
    if (this.imageModel === "nano-banana-pro") return this.nanoImage(o);
    const q = o.quality === "final" ? "high" : "low";
    return metered(this.ledger, { stage: o.stage, provider: "fal", endpoint: "openai/gpt-image-2/edit", note: o.note }, async () => {
      const data = await this.run<{ images: FalImage[] }>("openai/gpt-image-2/edit", {
        prompt: o.prompt,
        image_urls: o.refs.slice(0, 16),
        quality: q,
        image_size: ASPECT_TO_GPT_SIZE[o.aspect] ?? "portrait_16_9",
        output_format: "jpeg",
        num_images: 1,
      });
      const img = data.images[0];
      // Reference inputs are billed at high-fidelity input rates on top of the output.
      const inputSurcharge = 0.008 * o.refs.length;
      const mult = o.aspect === "1:1" ? 1 : 1.5;
      return {
        result: { remoteUrl: img.url, mime: img.content_type ?? "image/jpeg", width: img.width ?? undefined, height: img.height ?? undefined },
        units: 1,
        unitType: "image",
        rateUsd: RATES.gptImage2[q] * mult + inputSurcharge,
        output: img.url,
      };
    });
  }

  async editImage(o: { prompt: string; source: string; aspect: string; quality: string; stage: string; note: string }): Promise<Asset> {
    const resolution = o.quality === "final" ? "2K" : "1K";
    return metered(this.ledger, { stage: o.stage, provider: "fal", endpoint: "fal-ai/gemini-3-pro-image-preview/edit", note: o.note }, async () => {
      const data = await this.run<{ images: FalImage[] }>("fal-ai/gemini-3-pro-image-preview/edit", {
        prompt: o.prompt,
        image_urls: [o.source],
        resolution,
        aspect_ratio: o.aspect,
        output_format: "jpeg",
        num_images: 1,
      });
      const img = data.images[0];
      return {
        result: { remoteUrl: img.url, mime: img.content_type ?? "image/jpeg", width: img.width ?? undefined, height: img.height ?? undefined },
        units: 1,
        unitType: "image",
        rateUsd: RATES.nanoBananaPro[resolution],
        output: img.url,
      };
    });
  }

  async video(o: { prompt: string; imageUrl: string; endImageUrl?: string; durationSec: number; quality: string; audio: boolean; stage: string; note: string }): Promise<Asset> {
    // Seedance 2.5 first (the chosen video model). Its partner policy refuses
    // photoreal images containing recognisable people, which most of our street
    // scenes are, so a policy rejection falls back to Kling 3.0 standard.
    try {
      return await this.seedanceVideo(o);
    } catch (err) {
      if (!/content_policy_violation|partner_validation/i.test((err as Error).message)) throw err;
      console.warn(`[fal] seedance refused ${o.note} (people likeness policy); using kling 3.0`);
      return this.klingVideo(o);
    }
  }

  private async seedanceVideo(o: { prompt: string; imageUrl: string; endImageUrl?: string; durationSec: number; quality: string; audio: boolean; stage: string; note: string }): Promise<Asset> {
    const resolution = o.quality === "final" ? "720p" : "480p";
    const duration = Math.min(30, Math.max(4, Math.round(o.durationSec)));
    return metered(this.ledger, { stage: o.stage, provider: "fal", endpoint: "bytedance/seedance-2.5/image-to-video", note: o.note }, async () => {
      const data = await this.run<{ video: { url: string; content_type?: string } }>("bytedance/seedance-2.5/image-to-video", {
        prompt: o.prompt,
        image_url: o.imageUrl,
        end_image_url: o.endImageUrl ?? null,
        resolution,
        duration: String(duration),
        generate_audio: o.audio,
        aspect_ratio: "auto",
      });
      const cost = seedanceCost(resolution, duration);
      return {
        result: { remoteUrl: data.video.url, mime: data.video.content_type ?? "video/mp4", durationSec: duration },
        units: cost.tokens,
        unitType: "video-tokens",
        rateUsd: RATES.seedanceTokenUsdPer1k / 1000,
        costUsd: cost.usd,
        output: data.video.url,
      };
    });
  }

  private async klingVideo(o: { prompt: string; imageUrl: string; endImageUrl?: string; durationSec: number; quality: string; stage: string; note: string }): Promise<Asset> {
    // Kling v3 standard accepts 5 or 10 second durations, no native audio at this
    // tier, and takes an end frame as well as a start frame. Giving it the same
    // picture for both is what makes a clip that can loop without a seam.
    const duration = o.durationSec > 7 ? "10" : "5";
    return metered(this.ledger, { stage: o.stage, provider: "fal", endpoint: "fal-ai/kling-video/v3/standard/image-to-video", note: o.note }, async () => {
      const input: Record<string, unknown> = { prompt: o.prompt, start_image_url: o.imageUrl, image_url: o.imageUrl, duration };
      if (o.endImageUrl) input.end_image_url = o.endImageUrl;
      const data = await this.run<{ video: { url: string; content_type?: string } }>("fal-ai/kling-video/v3/standard/image-to-video", input);
      const secs = Number(duration);
      return {
        result: { remoteUrl: data.video.url, mime: data.video.content_type ?? "video/mp4", durationSec: secs },
        units: secs,
        unitType: "seconds",
        rateUsd: 0.084,
        output: data.video.url,
      };
    });
  }

  async talkingPortrait(o: { imageUrl: string; audioUrl: string; prompt?: string; quality: string; stage: string; note: string }): Promise<Asset> {
    return metered(this.ledger, { stage: o.stage, provider: "fal", endpoint: "fal-ai/bytedance/omnihuman/v1.5", note: o.note }, async () => {
      const data = await this.run<{ video: { url: string; content_type?: string }; duration?: number }>("fal-ai/bytedance/omnihuman/v1.5", {
        image_url: o.imageUrl,
        audio_url: o.audioUrl,
        prompt: o.prompt ?? null,
        resolution: "720p",
        turbo_mode: o.quality !== "final",
      });
      const dur = data.duration ?? 10;
      return {
        result: { remoteUrl: data.video.url, mime: data.video.content_type ?? "video/mp4", durationSec: dur },
        units: dur,
        unitType: "seconds",
        rateUsd: RATES.omnihumanPerSec,
        output: data.video.url,
      };
    });
  }

  /**
   * How each kind of line is performed. The v3 voice acts on these tags rather
   * than reading them, which is the only way to direct delivery on this model.
   */
  private static readonly DIRECTION: Record<string, string> = {
    arrival: "[warmly]",
    narration: "[warmly]",
    hotspots: "[confiding]",
    transition: "[gently]",
    character: "[warmly]",
  };
  /** Freedom to vary: enough to act the direction, not enough to overplay it. */
  private static readonly STABILITY = 0.3;

  /** Identity of these recordings: the model, its freedom, and the direction. */
  get voiceVariant(): string {
    const scheme = Object.entries(FalProvider.DIRECTION).map(([k, v]) => `${k}${v}`).join("");
    return `fal:eleven-v3:${FalProvider.STABILITY}:${createHash("sha1").update(scheme).digest("hex").slice(0, 8)}`;
  }

  async tts(o: { text: string; voice: string; stage: string; note: string }): Promise<Asset> {
    const direction = FalProvider.DIRECTION[o.stage] ?? "[warmly]";
    const text = /^\s*\[/.test(o.text) ? o.text : `${direction} ${o.text}`;
    return metered(this.ledger, { stage: o.stage, provider: "fal", endpoint: "fal-ai/elevenlabs/tts/eleven-v3", note: o.note }, async () => {
      const data = await this.run<{ audio: { url: string; content_type?: string; duration?: number } }>("fal-ai/elevenlabs/tts/eleven-v3", {
        text,
        voice: o.voice,
        stability: FalProvider.STABILITY,
        language_code: "en",
      });
      return {
        result: { remoteUrl: data.audio.url, mime: data.audio.content_type ?? "audio/mpeg", durationSec: data.audio.duration },
        units: o.text.length,
        unitType: "characters",
        rateUsd: RATES.elevenTtsPerChar,
        output: data.audio.url,
      };
    });
  }

  async sfx(o: { text: string; durationSec: number; loop: boolean; stage: string; note: string }): Promise<Asset> {
    const duration = Math.min(22, Math.max(0.5, o.durationSec));
    return metered(this.ledger, { stage: o.stage, provider: "fal", endpoint: "fal-ai/elevenlabs/sound-effects/v2", note: o.note }, async () => {
      const data = await this.run<{ audio: { url: string; content_type?: string } }>("fal-ai/elevenlabs/sound-effects/v2", {
        text: o.text,
        duration_seconds: duration,
        loop: o.loop,
        prompt_influence: 0.4,
        output_format: "mp3_44100_128",
      });
      return {
        result: { remoteUrl: data.audio.url, mime: data.audio.content_type ?? "audio/mpeg", durationSec: duration },
        units: duration,
        unitType: "seconds",
        rateUsd: RATES.elevenSfxPerSec,
        output: data.audio.url,
      };
    });
  }

  async publish(localPath: string, mime: string): Promise<string> {
    const buf = await fs.readFile(localPath);
    const url = await fal.storage.upload(new Blob([buf], { type: mime }));
    await this.ledger.add({ stage: "upload", provider: "fal", endpoint: "storage.upload", note: localPath, units: buf.length, unitType: "bytes", rateUsd: 0, estimated: false, ms: 0, output: url });
    return url;
  }
}
