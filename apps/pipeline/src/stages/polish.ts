/**
 * Grounding and voice pass: after the stills exist, her lines are rewritten by
 * a model that is LOOKING at the actual images, in her narrator-host voice.
 * Nothing visual regenerates; only the words (and therefore their audio and
 * lip-synced faces) change.
 */
import fs from "node:fs/promises";
import { z } from "zod";
import type { Recipe } from "@timetravel/schema";
import type { Llm } from "../llm.ts";
import type { Asset } from "../providers/types.ts";
import type { CompanionDossier, StopDossier, StopScript } from "../shapes.ts";
import type { StopMedia } from "./media.ts";

export const PolishedStop = z.object({
  stopId: z.string(),
  arrivalLine: z.string(),
  cards: z.array(z.object({ id: z.string(), narration: z.string(), invite: z.boolean() })),
  transitionLine: z.string(),
});
export type PolishedStop = z.infer<typeof PolishedStop>;

export const POLISHED_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["stopId", "arrivalLine", "cards", "transitionLine"],
  properties: {
    stopId: { type: "string" },
    arrivalLine: { type: "string", description: "Her spoken arrival line, under 40 words (the first stop may run to 55 to welcome the whole tour)." },
    cards: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "narration", "invite"],
        properties: {
          id: { type: "string" },
          narration: { type: "string", description: "Her spoken line for this image, under 45 words, describing only what is visible plus dossier facts. Empty string keeps the card silent." },
          invite: { type: "boolean", description: "True on exactly one card per stop: its narration naturally invites touching a white point, freshly worded." },
        },
      },
    },
    transitionLine: { type: "string", description: "Her walking-on line, under 25 words; the last stop's is her goodbye, under 30." },
  },
} as const;

async function toDataUrl(asset: Asset | undefined): Promise<string | undefined> {
  if (!asset) return undefined;
  if (asset.localPath) {
    const buf = await fs.readFile(asset.localPath);
    return `data:${asset.mime};base64,${buf.toString("base64")}`;
  }
  return asset.remoteUrl;
}

const VOICE_SPEC = `HER VOICE: she is the tour's host and narrator - the warmth and momentum of the best broadcast presenter of a guided walk, yet entirely a woman of 1850 London. Only the vocabulary, measures and ideas of her time. She addresses the visitor directly, varies how her sentences begin, and always hands the listener forward to what comes next. Endearments such as "love": at most once in this whole stop, ideally none. No lecturing, no lists; she points at things and tells their story.
GROUNDING: you are looking at the actual pictures. Never assert weather, light, colours or details that contradict what is visible. Grey smoke-hung sky stays grey. If the old line contradicts the image, replace the claim with what is truly there. Prices and numbers only from the dossier.`;

export async function polishStop(
  recipe: Recipe,
  script: StopScript,
  dossier: StopDossier,
  companion: CompanionDossier,
  media: StopMedia,
  llm: Llm,
  opts: { stopIndex: number; stopCount: number },
): Promise<PolishedStop> {
  const images: string[] = [];
  const labels: string[] = [];
  const heroUrl = await toDataUrl(media.hero);
  if (heroUrl) {
    images.push(heroUrl);
    labels.push("IMAGE 1: the arrival view her arrivalLine plays over.");
  }
  const visualCards = script.cards.filter((c) => c.kind === "image" || c.kind === "thenNow");
  for (const sc of visualCards) {
    const cm = media.cards.find((c) => c.id === sc.id);
    const still = await toDataUrl(sc.kind === "thenNow" ? cm?.then : cm?.image);
    if (still) {
      images.push(still);
      labels.push(`IMAGE ${images.length}: card ${sc.id}.`);
    }
  }
  const first = opts.stopIndex === 0;
  const last = opts.stopIndex === opts.stopCount - 1;
  const user = `Stop ${opts.stopIndex + 1} of ${opts.stopCount}: ${script.stopId}. Tour: "${recipe.title}", ${recipe.cityName} ${recipe.year}.
${labels.join("\n")}

CURRENT LINES (rewrite all of them in her narrator voice, grounded in the pictures):
arrivalLine: "${script.arrivalLine}"
${visualCards.map((c) => `card ${c.id}: "${c.narration}"`).join("\n")}
transitionLine: "${script.transitionLine}"

DOSSIER FACTS (the only permitted numbers and claims):
${dossier.facts.map((f) => `- ${f.text}`).join("\n")}
Prices: ${dossier.prices.map((p) => `${p.item}: ${p.price}`).join("; ")}

HOW SHE SPEAKS (persona): ${companion.speechNotes}

${first ? `THIS IS THE TOUR'S OPENING. The arrivalLine must welcome the visitor to the whole walk by name ("${recipe.title}" in her own words), sketch where it goes (Ludgate Hill down to the river), and ONCE, in period idiom with no modern words, tell them two things: where they spy a small white mark on a scene they may touch it and she will say more of that very thing; and that holding the green disc lets them speak with her and ask what they please. Then arrive at this first view.` : ""}
${last ? "THIS IS THE LAST STOP: transitionLine is her goodbye." : ""}
INVITES: set invite=true on EXACTLY ONE card of this stop; that card's narration ends by naturally inviting the visitor to touch one of the white points, naming one of the things in that picture, worded freshly (never the same formula as other stops). All other cards invite=false and contain no such invitation.
Return every card id listed above. Set stopId to "${script.stopId}".`;

  return llm.structured({
    name: "polished_stop",
    jsonSchema: POLISHED_SCHEMA as unknown as Record<string, unknown>,
    zod: PolishedStop,
    system: VOICE_SPEC,
    user,
    images,
    webSearch: false,
    effort: "medium",
    stage: "polish",
    note: `polish ${script.stopId}`,
  });
}

/** Applies the polished lines onto a script, leaving prompts and structure untouched. */
export function applyPolish(script: StopScript, polished: PolishedStop): StopScript {
  return {
    ...script,
    arrivalLine: polished.arrivalLine,
    transitionLine: polished.transitionLine,
    cards: script.cards.map((c) => {
      const p = polished.cards.find((x) => x.id === c.id);
      return p ? { ...c, narration: p.narration } : c;
    }),
  };
}
