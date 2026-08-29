/**
 * Her recorded voice: OpenAI speech, the same Marin voice the live companion
 * answers in, so a recorded line and a spoken answer are one person. The
 * delivery note is what keeps it from reading like an announcer.
 */
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Ledger } from "../ledger.ts";
import { metered } from "../ledger.ts";
import { RATES } from "../prices.ts";
import type { Asset, MediaProvider } from "./types.ts";

export const NARRATION_STYLE = [
  "Voice: Nell Baker, a London flower seller in 1850, mid thirties, quick, warm and glad of the company.",
  "Feeling: delighted to be showing someone her city. Real affection, real mischief, real pride in her patch.",
  "Delivery: animated and alive, the way a person talks when they love the story they are telling. Let the pitch rise and fall freely and never settle into a level line. Lean on the one interesting word in each sentence and let the small words run past it lightly.",
  "Pace: brisk and springy, with genuine variation. Hurry the ordinary parts; slow down and warm up for the thing that matters, then lift again.",
  "Colour: a smile audible through most of it. Confidential and playful in an aside, gentle and hushed when she speaks of the poor or the children, then bright again. Light London warmth without caricature.",
  "Never announce, never read, never drone. This is a person talking, not a recording being made.",
].join(" ");

/** What a recording depends on besides its words: change the note, get new takes. */
export function styleTag(model: string): string {
  return `openai:${model}:${createHash("sha1").update(NARRATION_STYLE).digest("hex").slice(0, 8)}`;
}

export class OpenAiVoice {
  constructor(
    private apiKey: string,
    private ledger: Ledger,
    private model = "gpt-4o-mini-tts-2025-12-15",
  ) {
    if (!apiKey) throw new Error("OPENAI_API_KEY is not set");
  }

  /** Identifies these recordings: the model and the delivery note behind them. */
  get tag(): string {
    return styleTag(this.model);
  }

  async tts(o: { text: string; voice: string; stage: string; note: string }): Promise<Asset> {
    return metered(this.ledger, { stage: o.stage, provider: "openai", endpoint: `${this.model}/speech`, note: o.note }, async () => {
      let lastErr: Error | undefined;
      for (let attempt = 0; attempt < 4; attempt++) {
        const res = await fetch("https://api.openai.com/v1/audio/speech", {
          method: "POST",
          headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ model: this.model, voice: o.voice, input: o.text, instructions: NARRATION_STYLE, response_format: "mp3" }),
        });
        if (res.ok) {
          const buf = Buffer.from(await res.arrayBuffer());
          const file = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "tt-voice-")), "line.mp3");
          await fs.writeFile(file, buf);
          return {
            result: { localPath: file, mime: "audio/mpeg" },
            units: o.text.length,
            unitType: "characters",
            rateUsd: RATES.openaiTtsPerChar,
          };
        }
        const detail = (await res.text()).slice(0, 300);
        lastErr = new Error(`openai speech ${res.status}: ${detail}`);
        if (res.status === 429 || res.status >= 500) {
          await new Promise((ok) => setTimeout(ok, 2000 * (attempt + 1)));
          continue;
        }
        throw lastErr;
      }
      throw lastErr;
    });
  }
}

/**
 * The same provider in every respect but her voice: pictures, video and sound
 * effects still come from the inner provider, speech comes from OpenAI.
 */
export function withVoice(inner: MediaProvider, voice: OpenAiVoice): MediaProvider {
  return new Proxy(inner, {
    get(target, prop) {
      if (prop === "tts") return voice.tts.bind(voice);
      if (prop === "voiceVariant") return voice.tag;
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
