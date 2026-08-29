/**
 * Points of interest inside the finished stills. The locator looks at the
 * image that was actually generated, names two or three things worth tapping,
 * gives their position, and writes her one-line reaction to each; the lines
 * are then recorded in her voice. Runs after media so it can never describe
 * something that is not in the picture.
 */
import fs from "node:fs/promises";
import type { Recipe } from "@timetravel/schema";
import type { Quality } from "../env.ts";
import type { Llm } from "../llm.ts";
import type { MediaProvider, Asset } from "../providers/types.ts";
import { HOTSPOT_PLAN_SCHEMA, HotspotPlan, type CompanionDossier, type StopDossier, type StopScript } from "../shapes.ts";
import type { StopMedia } from "./media.ts";

export interface StopHotspots {
  stopId: string;
  arrival?: Array<{ id: string; x: number; y: number; label: string; text: string; audio?: Asset }>;
  cards: Array<{
    cardId: string;
    points: Array<{ id: string; x: number; y: number; label: string; text: string; audio?: Asset }>;
  }>;
}

async function toDataUrl(asset: Asset): Promise<string | undefined> {
  if (asset.localPath) {
    const buf = await fs.readFile(asset.localPath);
    return `data:${asset.mime};base64,${buf.toString("base64")}`;
  }
  return asset.remoteUrl;
}

export async function makeStopHotspots(
  recipe: Recipe,
  script: StopScript,
  dossier: StopDossier,
  companion: CompanionDossier,
  media: StopMedia,
  llm: Llm,
  provider: MediaProvider,
  quality: Quality,
): Promise<StopHotspots> {
  const out: StopHotspots = { stopId: script.stopId, cards: [] };
  // Points for the visuals of this stop: the arrival hero first, then the cards.
  const targets: Array<{ id: string; kind: "arrival" | "card"; narration: string; still: Asset | undefined }> = [
    { id: "arrival", kind: "arrival", narration: script.arrivalLine, still: media.hero },
  ];
  for (const sc of script.cards) {
    // Both plain image screens and the year-view of a then/now pair are
    // full-bleed stills in the player, so both get points of interest.
    if (sc.kind !== "image" && sc.kind !== "thenNow") continue;
    const cm = media.cards.find((c) => c.id === sc.id);
    targets.push({ id: sc.id, kind: "card", narration: sc.narration, still: sc.kind === "thenNow" ? cm?.then : cm?.image });
  }
  for (const target of targets) {
    if (!target.still) continue;
    const imageUrl = await toDataUrl(target.still);
    if (!imageUrl) continue;
    const sc = { id: target.id, narration: target.narration };

    let plan: HotspotPlan;
    try {
      plan = await llm.structured({
        name: "hotspot_plan",
        jsonSchema: HOTSPOT_PLAN_SCHEMA as unknown as Record<string, unknown>,
        zod: HotspotPlan,
        system:
          "You are a picture researcher for an immersive history tour. You are shown one reconstruction image. Find the two or three most interesting, clearly visible things in it that a visitor might tap: a person, a vehicle, a shop sign, a building detail. Positions must be accurate: give the centre of the thing as fractions of the image width and height. Then write what the guide says about each in her exact voice, grounded in the dossier facts. Never invent facts; if the dossier has nothing about a thing, she reacts to it in character without inventing numbers. Skip anything you cannot place confidently.",
        user: `The guide is ${recipe.companion.name}, ${recipe.companion.role}, ${recipe.cityName} ${recipe.year}.
How she talks: ${companion.speechNotes}
Sample phrases: ${companion.samplePhrases.join(" | ")}

Dossier for this place:
${dossier.setting.slice(0, 500)}
Facts: ${dossier.facts.map((f) => f.text).join(" | ").slice(0, 900)}
Prices: ${dossier.prices.map((p) => `${p.item}: ${p.price}`).join("; ")}

The card she is narrating: "${sc.narration}"
Return two or three points for this image.`,
        images: [imageUrl],
        webSearch: false,
        effort: "low",
        stage: "hotspots",
        note: `locate ${sc.id}`,
      });
    } catch (err) {
      console.warn(`[hotspots] locate ${sc.id} failed: ${(err as Error).message}`);
      continue;
    }

    const points = plan.points
      .filter((p) => p.confidence !== "low" && p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1)
      .slice(0, 3);
    const cardOut: StopHotspots["cards"][number] = { cardId: sc.id, points: [] };
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      let audio: Asset | undefined;
      try {
        audio = await provider.tts({ text: p.line, voice: recipe.companion.narrationVoice, stage: "hotspots", note: `poi ${sc.id}/${i + 1} ${p.label}` });
      } catch (err) {
        console.warn(`[hotspots] tts ${sc.id}/${p.label} failed: ${(err as Error).message}`);
      }
      cardOut.points.push({
        id: `${script.stopId}_${sc.id}_p${i + 1}`,
        // Clamp toward the frame so a marker never sits under the HUD edges.
        x: Math.min(0.94, Math.max(0.06, p.x)),
        y: Math.min(0.86, Math.max(0.12, p.y)),
        label: p.label,
        text: p.line,
        audio,
      });
    }
    if (cardOut.points.length) {
      if (target.kind === "arrival") out.arrival = cardOut.points;
      else out.cards.push(cardOut);
    }
    void quality;
  }
  return out;
}
