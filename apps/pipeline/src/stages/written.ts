/**
 * A hand-written script, spoken verbatim, and the pictures written to match it.
 *
 * When content/scripts/<name>.script.json names this tour it decides three
 * things: what she says on every screen, what each picture must show (so the
 * scene contains the things she talks about), and which points of interest
 * exist. The locator's only remaining job is to find where each named point
 * actually sits in the finished picture. Everything else stays as it was, so a
 * rewrite costs new recordings, and new pictures only when a scene changed.
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { Recipe } from "@timetravel/schema";
import type { MediaProvider } from "../providers/types.ts";
import type { StopScript } from "../shapes.ts";

/** One thing in the picture that can be tapped, and what she says about it. */
export interface WrittenPoint {
  label: string;
  line: string;
}

export interface WrittenScreen {
  /** What she says over this picture. */
  line?: string;
  narration?: string;
  /** What the picture shows. Replaces the generated image prompt. */
  scene?: string;
  points?: WrittenPoint[];
}

export interface WrittenStop {
  arrival?: WrittenScreen;
  transitionOut?: string;
  cards?: Record<string, WrittenScreen>;
}

export interface WrittenScript {
  tourId: string;
  companion?: string;
  note?: string;
  stops: Record<string, WrittenStop>;
}

/** Finds the written script for this tour, if one exists. */
export async function loadWritten(contentDir: string, tourId: string): Promise<WrittenScript | undefined> {
  const dir = path.join(contentDir, "scripts");
  let names: string[];
  try {
    names = (await fs.readdir(dir)).filter((n) => n.endsWith(".script.json"));
  } catch {
    return undefined;
  }
  for (const name of names) {
    try {
      const doc = JSON.parse(await fs.readFile(path.join(dir, name), "utf8")) as WrittenScript;
      if (doc.tourId === tourId && doc.stops) return doc;
    } catch {
      // a malformed script must never take the tour down; the model's words stand
    }
  }
  return undefined;
}

/** The points the script declares for one screen, in the order they are written. */
export function writtenPoints(written: WrittenStop | undefined, screenId: string): WrittenPoint[] | undefined {
  if (!written) return undefined;
  const screen = screenId === "arrival" ? written.arrival : written.cards?.[screenId];
  return screen?.points?.length ? screen.points : undefined;
}

/**
 * Replaces the words and the picture briefs of one stop. Anything the script
 * leaves out keeps whatever was there before.
 */
export function applyWrittenScript(script: StopScript, written: WrittenStop | undefined): StopScript {
  if (!written) return script;
  const arrival = written.arrival;
  return {
    ...script,
    arrivalLine: arrival?.line ?? script.arrivalLine,
    heroImagePrompt: arrival?.scene ?? script.heroImagePrompt,
    transitionLine: written.transitionOut ?? script.transitionLine,
    cards: script.cards.map((c) => {
      const w = written.cards?.[c.id];
      if (!w) return c;
      return { ...c, narration: w.narration ?? c.narration, imagePrompt: w.scene ?? c.imagePrompt };
    }),
  };
}

/** Records one written line in her voice, reusing the recording when the words are unchanged. */
export async function speakWritten(
  text: string,
  note: string,
  recipe: Recipe,
  provider: MediaProvider,
): Promise<Awaited<ReturnType<MediaProvider["tts"]>> | undefined> {
  try {
    return await provider.tts({ text, voice: recipe.companion.narrationVoice, stage: "hotspots", note });
  } catch (err) {
    console.warn(`[written] tts ${note} failed: ${(err as Error).message}`);
    return undefined;
  }
}
