/**
 * Public rate cards, checked 29 Aug 2026. Providers do not return the charge
 * per call, so these are estimates; the ledger marks them as such.
 */
export const RATES = {
  /** fal openai/gpt-image-2, per 1024x1024 image by quality. Portrait sizes cost about 1.5x. */
  gptImage2: { low: 0.02, medium: 0.07, high: 0.21 } as Record<string, number>,
  /** fal fal-ai/gemini-3-pro-image-preview (Nano Banana Pro), per image. */
  nanoBananaPro: { "1K": 0.15, "2K": 0.15, "4K": 0.3 } as Record<string, number>,
  /** fal bytedance/seedance-2.5: (w*h*duration*24)/1024 tokens at $0.0214 per 1000 tokens. */
  seedanceTokenUsdPer1k: 0.0214,
  /** fal fal-ai/bytedance/omnihuman/v1.5, per second of output video. */
  omnihumanPerSec: 0.16,
  /** fal fal-ai/elevenlabs/tts/eleven-v3, per character (estimate from ElevenLabs API rates). */
  elevenTtsPerChar: 0.0001,
  /** fal fal-ai/elevenlabs/sound-effects/v2, per second. */
  elevenSfxPerSec: 0.002,
  /** OpenAI gpt-5.4 via Responses API, per token. Estimate; billed by OpenAI directly. */
  gpt54: { inputPerTok: 2.5 / 1_000_000, outputPerTok: 15 / 1_000_000 },
};

export const VIDEO_DIMENSIONS: Record<string, { width: number; height: number }> = {
  "480p": { width: 480, height: 864 },
  "720p": { width: 720, height: 1280 },
  "1080p": { width: 1080, height: 1920 },
};

export function seedanceCost(resolution: string, durationSec: number): { tokens: number; usd: number } {
  const d = VIDEO_DIMENSIONS[resolution] ?? VIDEO_DIMENSIONS["720p"];
  const tokens = (d.width * d.height * durationSec * 24) / 1024;
  return { tokens: Math.round(tokens), usd: (tokens / 1000) * RATES.seedanceTokenUsdPer1k };
}
