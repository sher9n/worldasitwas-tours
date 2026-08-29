/**
 * A hand-written script, spoken verbatim.
 *
 * When content/scripts/<name>.script.json names this tour, its words replace
 * everything the model would have written: the arrival lines, the narration of
 * each scene, the walking-on lines and the line behind every point of interest.
 * The points keep the positions the locator found in the finished pictures, so
 * a written line still lands on the thing it describes; a point the script does
 * not mention is removed from the tour. Nothing else is affected, so a rewrite
 * costs new recordings and nothing more.
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { Recipe } from "@timetravel/schema";
import type { MediaProvider } from "../providers/types.ts";
import type { StopScript } from "../shapes.ts";
import type { StopHotspots } from "./hotspots.ts";

export interface WrittenStop {
  arrival?: string;
  transitionOut?: string;
  cards?: Record<string, string>;
  hotspots?: Record<string, string>;
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

/** Replaces the spoken text of one stop. Silence in the file means "keep what is there". */
export function applyWrittenScript(script: StopScript, written: WrittenStop | undefined): StopScript {
  if (!written) return script;
  return {
    ...script,
    arrivalLine: written.arrival ?? script.arrivalLine,
    transitionLine: written.transitionOut ?? script.transitionLine,
    cards: script.cards.map((c) => ({ ...c, narration: written.cards?.[c.id] ?? c.narration })),
  };
}

/**
 * Rewrites the points of one stop: written text in, unwritten points out, and a
 * fresh recording for every line whose words changed.
 */
export async function applyWrittenHotspots(
  hot: StopHotspots,
  written: WrittenStop | undefined,
  recipe: Recipe,
  provider: MediaProvider,
): Promise<StopHotspots> {
  const lines = written?.hotspots;
  if (!lines) return hot;

  const speak = async (id: string, text: string, prev: StopHotspots["cards"][number]["points"][number]) => {
    if (prev.text === text && prev.audio) return prev;
    let audio = prev.audio;
    try {
      audio = await provider.tts({ text, voice: recipe.companion.narrationVoice, stage: "hotspots", note: `written poi ${id}` });
    } catch (err) {
      console.warn(`[written] tts ${id} failed: ${(err as Error).message}`);
    }
    return { ...prev, text, audio };
  };

  const arrival = [];
  for (const p of hot.arrival ?? []) {
    const text = lines[p.id];
    if (text) arrival.push(await speak(p.id, text, p));
  }
  const cards: StopHotspots["cards"] = [];
  for (const card of hot.cards) {
    const points = [];
    for (const p of card.points) {
      const text = lines[p.id];
      if (text) points.push(await speak(p.id, text, p));
    }
    if (points.length) cards.push({ ...card, points });
  }
  return { ...hot, arrival: arrival.length ? arrival : undefined, cards };
}
