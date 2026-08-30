/**
 * Writes a whole tour the way the flower seller was written.
 *
 * The lesson from that tour: writing each stop on its own produces a pile of
 * facts, because every stop reaches for the same landmark and the same prices,
 * and the taps end up repeating the scene they sit on. So this writes the tour
 * as one piece. First a plan that fixes the guide, the arc and which fact
 * belongs where; then each stop written against that plan and against
 * everything already said. The output is the same hand-written script format,
 * so it can be read, edited and re-recorded like any other.
 */
import type { Recipe } from "@timetravel/schema";
import type { Llm } from "../llm.ts";
import type { CompanionDossier, StopDossier } from "../shapes.ts";
import { z } from "zod";
import type { WrittenScript, WrittenStop } from "./written.ts";

/* ------------------------------- the plan -------------------------------- */

const TourPlan = z.object({
  arc: z.string(),
  introduction: z.string(),
  farewell: z.string(),
  stops: z.array(z.object({ stopId: z.string(), theme: z.string(), spoken: z.array(z.string()), tapped: z.array(z.string()) })),
});
type TourPlan = z.infer<typeof TourPlan>;

const TOUR_PLAN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["arc", "introduction", "farewell", "stops"],
  properties: {
    arc: { type: "string", description: "In two sentences: the argument the whole walk makes about this city at this moment in time." },
    introduction: { type: "string", description: "What the guide must establish about themselves in the first thirty seconds: name, trade, how long, and why they know this route." },
    farewell: { type: "string", description: "How the walk should end: what it adds up to, and how they say goodbye." },
    stops: {
      type: "array",
      description: "One entry per stop, in order.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["stopId", "theme", "spoken", "tapped"],
        properties: {
          stopId: { type: "string" },
          theme: { type: "string", description: "The single idea this stop carries. One sentence." },
          spoken: { type: "array", items: { type: "string" }, description: "Facts this stop may state out loud in the narration. Each fact belongs to exactly one stop in the whole tour." },
          tapped: { type: "array", items: { type: "string" }, description: "Facts reserved for points of interest here, which the narration must NOT say. Also unique across the whole tour." },
        },
      },
    },
  },
} as const;

/* ------------------------------ one stop --------------------------------- */

const Screen = z.object({
  line: z.string(),
  scene: z.string(),
  points: z.array(z.object({ label: z.string(), line: z.string() })),
});
const StopScreens = z.object({
  arrival: Screen,
  cards: z.array(Screen.extend({ cardId: z.string() })),
  transitionOut: z.string(),
});
type StopScreens = z.infer<typeof StopScreens>;

const STOP_SCREENS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["arrival", "cards", "transitionOut"],
  properties: {
    arrival: {
      type: "object",
      additionalProperties: false,
      required: ["line", "scene", "points"],
      properties: {
        line: { type: "string", description: "What the guide says on arriving: 20 to 30 words. HARD LIMIT 32 words. One thought, not a paragraph." },
        scene: { type: "string", description: "What the picture shows: a single photographic frame described in one paragraph, naming every thing the points below refer to, so they can be found in it." },
        points: {
          type: "array",
          description: "Two or three things in that picture worth tapping.",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["label", "line"],
            properties: {
              label: { type: "string", description: "Two or three plain words naming the thing as it appears in the picture, e.g. 'the crossing boy', 'the coffee stall'. Never a proper name that cannot be read off the picture." },
              line: { type: "string", description: "What the guide says about it: 30 to 55 words, adding something the narration has not said." },
            },
          },
        },
      },
    },
    cards: {
      type: "array",
      description: "One entry per card id you were given, in the same order.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["cardId", "line", "scene", "points"],
        properties: {
          cardId: { type: "string" },
          line: { type: "string", description: "The narration over this picture: 20 to 30 words. HARD LIMIT 32 words. ONE idea, said once." },
          scene: { type: "string", description: "What the picture shows: one photographic frame, naming every thing the points refer to." },
          points: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["label", "line"],
              properties: { label: { type: "string" }, line: { type: "string" } },
            },
          },
        },
      },
    },
    transitionOut: { type: "string", description: "Said while walking to the next stop: 15 to 25 words that hand the listener forward. On the last stop this is the farewell, which may run to 60 words." },
  },
} as const;

/** The register, stated as rules, because this is what took the flagship tour three rewrites to find. */
const VOICE_RULES = `HOW THE WRITING MUST SOUND
- A real person talking to a friend beside them, not a text being read aloud. Joined-up sentences that carry into one another with "and", "so", "because", "which means". Never a string of clipped fragments.
- Say things the way a person says them. "I have been doing it for nine years now", never "Nine years I have been at it". No inverted, literary or costume-drama word order.
- Plain, easy words. Period vocabulary and period facts, modern clarity. If a term needs explaining, she explains it in passing, in her own words.
- Warm, unhurried, with a little dry humour and real affection for the place. She is glad of the company.
- Contractions throughout. Direct address. An occasional aside.
- Concrete before abstract. What can be seen, heard, smelled, carried or paid for, not summaries of what a place means. Never a sentence that could appear in a guidebook.
- Introducing themselves is not reciting a form: no stating an age in years, no listing facts about themselves in a row. A person says what they do, how long they have done it, and one thing that shows they belong here.
- Modern spelling and ordinary words. No archaic spellings, no mock-period flourishes, no words a listener would have to stop and work out.

WHAT EACH KIND OF LINE DOES
- The arrival lines are one continuous story across the whole tour. The first one introduces the guide before anything else: a greeting, their name, their trade, how long they have done it, then what the walk is and how many stops, and only then how to look and how to ask. The last stop's transitionOut is the farewell: what the walk added up to, their name again, and goodbye.
- Every line is short. Twenty to thirty words, never more than thirty-two. Count them. A line of forty words is a picture held for fifteen seconds, which is the thing this tour is being rewritten to stop.
- A scene line carries ONE idea in about eight seconds of speech. A picture holds the screen for exactly as long as its line, so a long line means a still picture the visitor stares at; keep them short and let the pictures change.
- The tour is a sequence of short looks, not a few long speeches. Where a thought needs more than ten seconds, split it across two screens that each show something different.
- A point line adds something neither its scene nor any other point has said. It never repeats what she just said, and never opens with "Look there", "See", "Mind that" or "There now".
- A fact appears exactly once in the whole tour. Prices are rationed: at most one or two in a stop, and only where the price is the point.

WHAT THE PICTURES MUST BE
- Each scene is one photographic frame described in a paragraph: viewpoint, what fills it, and every thing the points name, placed where they would be. Never a collage, never split panels, never a caption.
- Points must name things a person can see and identify in the picture, so a marker can be placed on them. Not "the year 1666", not a person's name on a sign that cannot be read.`;

/* ------------------------------ the writing ------------------------------ */

export async function planTour(
  recipe: Recipe,
  dossiers: StopDossier[],
  companion: CompanionDossier,
  llm: Llm,
): Promise<TourPlan> {
  const stops = recipe.stops
    .map((s, i) => {
      const d = dossiers.find((x) => x.stopId === s.id);
      const facts = (d?.facts ?? []).map((f) => `    - ${f.text}`).join("\n");
      const prices = (d?.prices ?? []).map((p) => `    - ${p.item}: ${p.price}`).join("\n");
      return `${i + 1}. ${s.title} (${s.id})\n  must cover: ${s.mustCover.join("; ")}\n  facts available:\n${facts}${prices ? "\n  prices available:\n" + prices : ""}`;
    })
    .join("\n\n");
  return llm.structured({
    name: "tour_plan",
    jsonSchema: TOUR_PLAN_SCHEMA as unknown as Record<string, unknown>,
    zod: TourPlan,
    system:
      "You are the editor of a walking tour told by one person from the period. Your job here is not to write it but to decide its shape: the argument the walk makes, what the guide must establish about themselves at the start, how it ends, and which fact belongs to which stop. A fact may appear in exactly one place in the whole tour, either spoken in the narration or reserved for a point of interest, never both and never twice. Spread the landmark everyone reaches for across the stops so it is explained once, where it matters most.",
    user: `Tour: ${recipe.title}. ${recipe.cityName}, ${recipe.year}. Theme: ${recipe.theme}
Guide: ${recipe.companion.name}, ${recipe.companion.role}. ${recipe.companion.brief}
How they speak: ${companion.speechNotes}

STOPS
${stops}`,
    webSearch: false,
    effort: "medium",
    stage: "screenplay",
    note: `plan ${recipe.id}`,
  });
}

export async function writeStop(
  recipe: Recipe,
  plan: TourPlan,
  stopIndex: number,
  dossier: StopDossier,
  companion: CompanionDossier,
  cardIds: string[],
  alreadySaid: string[],
  llm: Llm,
): Promise<StopScreens> {
  const stop = recipe.stops[stopIndex];
  const p = plan.stops.find((x) => x.stopId === stop.id) ?? plan.stops[stopIndex];
  const isFirst = stopIndex === 0;
  const isLast = stopIndex === recipe.stops.length - 1;
  const facts = dossier.facts.map((f) => `- ${f.text}`).join("\n");
  const prices = dossier.prices.map((x) => `- ${x.item}: ${x.price}`).join("\n");

  return llm.structured({
    name: "stop_screens",
    jsonSchema: STOP_SCREENS_SCHEMA as unknown as Record<string, unknown>,
    zod: StopScreens,
    system: `You write a walking tour spoken by one person from the period. Everything you write is said out loud by them, in their own voice, and recorded as it stands.

${VOICE_RULES}

GROUNDING
Only state what the dossier supports, or what the guide can plainly see in the scene you are describing. Never invent a number, a name or a date. When they are guessing, they say so.`,
    user: `Tour: ${recipe.title}. ${recipe.cityName}, ${recipe.year}.
The walk as a whole: ${plan.arc}
The guide: ${recipe.companion.name}, ${recipe.companion.role}. ${recipe.companion.brief}
How they speak: ${companion.speechNotes}
Sample phrases: ${companion.samplePhrases.join(" | ")}

${isFirst ? `THIS IS THE FIRST STOP. The arrival line is only the first breath of the introduction: a greeting, their name and what they do, in 30 to 40 words. The rest of the introduction, how long they have done it, what the walk is and how many stops, and how to look and ask, carries on across the first two card screens of this stop, so the picture changes while they are still introducing themselves: ${plan.introduction}\nAfter introducing themselves and saying what the walk is, they explain in their own words, as its own short beat rather than tacked onto a longer sentence, that touching something in the picture will have them talk about it and that holding the green button lets the visitor ask them anything. Use the words "green button", on one of those first card screens rather than in the arrival line.` : `The arrival line picks up from where the last stop left off. Do not re-introduce them.`}
${isLast ? `THIS IS THE LAST STOP. Its transitionOut is the farewell, 60 to 90 words: ${plan.farewell}` : ""}

STOP ${stopIndex + 1} of ${recipe.stops.length}: ${stop.title}
The single idea here: ${p.theme}
Must cover: ${stop.mustCover.join("; ")}
Facts you may state out loud here: ${p.spoken.join(" | ")}
Facts reserved for the points of interest here (the narration must NOT say these): ${p.tapped.join(" | ")}

DOSSIER
${dossier.setting}
Sight: ${dossier.senses.sight}
Sound: ${dossier.senses.sound}
Smell: ${dossier.senses.smell}
Facts:
${facts}
${prices ? "Prices:\n" + prices : ""}

Write the arrival screen and ${cardIds.length} card screens, with these card ids in this order: ${cardIds.join(", ")}.

ALREADY SAID EARLIER IN THIS TOUR, so do not say any of it again:
${alreadySaid.length ? alreadySaid.map((l) => `- ${l}`).join("\n") : "- nothing yet, this is the opening"}`,
    webSearch: false,
    effort: "medium",
    stage: "screenplay",
    note: `write ${stop.id}`,
  });
}

/** Turns what the writer produced into the script format the pipeline speaks. */
export function toWrittenStop(screens: StopScreens): WrittenStop {
  return {
    arrival: { line: screens.arrival.line, scene: screens.arrival.scene, points: screens.arrival.points },
    cards: Object.fromEntries(screens.cards.map((c) => [c.cardId, { narration: c.line, scene: c.scene, points: c.points }])),
    transitionOut: screens.transitionOut,
  };
}

export function emptyScript(recipe: Recipe): WrittenScript {
  return { tourId: recipe.id, companion: recipe.companion.name, note: "Written by the screenplay stage, then spoken verbatim.", stops: {} };
}
