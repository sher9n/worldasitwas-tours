import type { Quality } from "../env.ts";

/** A generated or fetched file. Exactly one of remoteUrl or localPath is set. */
export interface Asset {
  remoteUrl?: string;
  localPath?: string;
  mime: string;
  width?: number;
  height?: number;
  durationSec?: number;
}

export type Aspect = "9:16" | "1:1" | "16:9";

export interface MediaProvider {
  readonly name: "fal" | "mock";
  /** Distinguishes configurations of the same provider (e.g. the image model) for caching. */
  readonly variant?: string;
  /** Text to image. */
  image(opts: { prompt: string; aspect: Aspect; quality: Quality; stage: string; note: string }): Promise<Asset>;
  /** Image guided by reference images (character consistency). */
  imageWithRefs(opts: { prompt: string; refs: string[]; aspect: Aspect; quality: Quality; stage: string; note: string }): Promise<Asset>;
  /** Edit an existing image while keeping its framing (then from now). */
  editImage(opts: { prompt: string; source: string; aspect: Aspect; quality: Quality; stage: string; note: string }): Promise<Asset>;
  /** Animate a still, optionally landing on an end frame. */
  video(opts: {
    prompt: string;
    imageUrl: string;
    endImageUrl?: string;
    durationSec: number;
    quality: Quality;
    audio: boolean;
    stage: string;
    note: string;
  }): Promise<Asset>;
  /** Lip-synced talking portrait from one image and one audio file. */
  talkingPortrait(opts: { imageUrl: string; audioUrl: string; prompt?: string; quality: Quality; stage: string; note: string }): Promise<Asset>;
  /** Pre-recorded speech. */
  tts(opts: { text: string; voice: string; stage: string; note: string }): Promise<Asset>;
  /** Seamless ambience loop. */
  sfx(opts: { text: string; durationSec: number; loop: boolean; stage: string; note: string }): Promise<Asset>;
  /** Make a local file reachable by the provider (returns a URL the provider accepts). */
  publish(localPath: string, mime: string): Promise<string>;
  /**
   * Re-host an external image where the provider can reliably fetch it.
   * Wikimedia and many archives block model providers' downloaders, which
   * surfaces as bogus generation errors. Optional; identity when absent.
   */
  mirrorUrl?(url: string, mime?: string): Promise<string>;
}
