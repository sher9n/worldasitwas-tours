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

export class FalProvider implements MediaProvider {
  readonly name = "fal" as const;

  constructor(
    key: string,
    private ledger: Ledger,
  ) {
    if (!key) throw new Error("FAL_KEY is not set");
    fal.config({ credentials: key });
  }

  private async run<T>(endpoint: string, input: Record<string, unknown>): Promise<T> {
    const res = await fal.subscribe(endpoint, { input, logs: false });
    return res.data as T;
  }

  async image(o: { prompt: string; aspect: string; quality: string; stage: string; note: string }): Promise<Asset> {
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
        result: { remoteUrl: img.url, mime: img.content_type ?? "image/jpeg", width: img.width, height: img.height },
        units: 1,
        unitType: "image",
        rateUsd: RATES.gptImage2[q] * mult,
        output: img.url,
      };
    });
  }

  async imageWithRefs(o: { prompt: string; refs: string[]; aspect: string; quality: string; stage: string; note: string }): Promise<Asset> {
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
        result: { remoteUrl: img.url, mime: img.content_type ?? "image/jpeg", width: img.width, height: img.height },
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
        result: { remoteUrl: img.url, mime: img.content_type ?? "image/jpeg", width: img.width, height: img.height },
        units: 1,
        unitType: "image",
        rateUsd: RATES.nanoBananaPro[resolution],
        output: img.url,
      };
    });
  }

  async video(o: { prompt: string; imageUrl: string; endImageUrl?: string; durationSec: number; quality: string; audio: boolean; stage: string; note: string }): Promise<Asset> {
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

  async tts(o: { text: string; voice: string; stage: string; note: string }): Promise<Asset> {
    return metered(this.ledger, { stage: o.stage, provider: "fal", endpoint: "fal-ai/elevenlabs/tts/eleven-v3", note: o.note }, async () => {
      const data = await this.run<{ audio: { url: string; content_type?: string; duration?: number } }>("fal-ai/elevenlabs/tts/eleven-v3", {
        text: o.text,
        voice: o.voice,
        stability: 0.5,
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
