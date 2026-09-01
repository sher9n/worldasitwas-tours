/**
 * Intermediate shapes between stages, as zod schemas plus the equivalent strict
 * JSON schemas handed to the model. Keep the two in step.
 */
import { z } from "zod";

const confidence = z.enum(["known", "likely", "interpretation"]);

export const StopDossier = z.object({
  stopId: z.string(),
  setting: z.string(),
  senses: z.object({ sight: z.string(), sound: z.string(), smell: z.string() }),
  facts: z.array(z.object({ text: z.string(), confidence, sourceTitle: z.string(), sourceUrl: z.string() })),
  prices: z.array(z.object({ item: z.string(), price: z.string(), note: z.string(), sourceTitle: z.string() })),
  people: z.array(z.object({ who: z.string(), doing: z.string() })),
  events: z.array(z.object({ what: z.string(), when: z.string(), sourceTitle: z.string() })),
  anachronismsToAvoid: z.array(z.string()),
  nowPhotoQuery: z.string(),
});
export type StopDossier = z.infer<typeof StopDossier>;

export const STOP_DOSSIER_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["stopId", "setting", "senses", "facts", "prices", "people", "events", "anachronismsToAvoid", "nowPhotoQuery"],
  properties: {
    stopId: { type: "string" },
    setting: { type: "string", description: "Two or three paragraphs: what this exact spot was like in the target year." },
    senses: {
      type: "object",
      additionalProperties: false,
      required: ["sight", "sound", "smell"],
      properties: { sight: { type: "string" }, sound: { type: "string" }, smell: { type: "string" } },
    },
    facts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["text", "confidence", "sourceTitle", "sourceUrl"],
        properties: {
          text: { type: "string" },
          confidence: { type: "string", enum: ["known", "likely", "interpretation"] },
          sourceTitle: { type: "string" },
          sourceUrl: { type: "string" },
        },
      },
    },
    prices: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["item", "price", "note", "sourceTitle"],
        properties: { item: { type: "string" }, price: { type: "string" }, note: { type: "string" }, sourceTitle: { type: "string" } },
      },
    },
    people: {
      type: "array",
      items: { type: "object", additionalProperties: false, required: ["who", "doing"], properties: { who: { type: "string" }, doing: { type: "string" } } },
    },
    events: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["what", "when", "sourceTitle"],
        properties: { what: { type: "string" }, when: { type: "string" }, sourceTitle: { type: "string" } },
      },
    },
    anachronismsToAvoid: { type: "array", items: { type: "string" } },
    nowPhotoQuery: { type: "string", description: "A Wikimedia Commons search phrase for a present-day photograph from this viewpoint." },
  },
} as const;

export const CompanionDossier = z.object({
  bio: z.string(),
  intro: z.string(),
  speechNotes: z.string(),
  worldview: z.string(),
  knowledgeLimits: z.string(),
  samplePhrases: z.array(z.string()),
  greeting: z.string(),
  portraitPrompt: z.string(),
});
export type CompanionDossier = z.infer<typeof CompanionDossier>;

export const COMPANION_DOSSIER_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["bio", "intro", "speechNotes", "worldview", "knowledgeLimits", "samplePhrases", "greeting", "portraitPrompt"],
  properties: {
    bio: { type: "string", description: "Who she is, as prose the guide speaks from. No URLs, no citation markers, no source names: a person, not a literature review." },
    intro: { type: "string", description: "At most three short sentences, under 400 characters, introducing her and this walk to a traveller who has just opened the card. Warm, plain, present tense, no citations." },
    speechNotes: { type: "string", description: "How she talks: vocabulary, rhythm, phrases, drawn from the primary sources. Concrete examples." },
    worldview: { type: "string" },
    knowledgeLimits: { type: "string" },
    samplePhrases: { type: "array", items: { type: "string" } },
    greeting: { type: "string", description: "Her first spoken line to the visitor, under 30 words." },
    portraitPrompt: { type: "string", description: "A photographic portrait description for generating her face and dress. No real person." },
  },
} as const;

export const ScriptCard = z.object({
  id: z.string(),
  kind: z.enum(["image", "thenNow", "archive", "text"]),
  caption: z.string(),
  narration: z.string(),
  imagePrompt: z.string(),
  textBody: z.string(),
  includesCompanion: z.boolean(),
  claims: z.array(z.object({ text: z.string(), confidence, sourceTitle: z.string() })),
  companionContextText: z.string(),
});

export const StopScript = z.object({
  stopId: z.string(),
  arrivalLine: z.string(),
  heroImagePrompt: z.string(),
  heroMotionPrompt: z.string(),
  ambiencePrompt: z.string(),
  cards: z.array(ScriptCard),
  transitionLine: z.string(),
});
export type StopScript = z.infer<typeof StopScript>;
export type ScriptCard = z.infer<typeof ScriptCard>;

export const STOP_SCRIPT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["stopId", "arrivalLine", "heroImagePrompt", "heroMotionPrompt", "ambiencePrompt", "cards", "transitionLine"],
  properties: {
    stopId: { type: "string" },
    arrivalLine: { type: "string", description: "What the companion says as the visitor arrives. Under 35 words, spoken." },
    heroImagePrompt: { type: "string", description: "Image prompt for the arrival scene from the visitor's eye level. Portrait framing." },
    heroMotionPrompt: { type: "string", description: "What moves in the arrival scene over a few seconds, and what is heard." },
    ambiencePrompt: { type: "string", description: "The continuous background sound of this spot, as a sound-effect prompt." },
    cards: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "kind", "caption", "narration", "imagePrompt", "textBody", "includesCompanion", "claims", "companionContextText"],
        properties: {
          id: { type: "string" },
          kind: { type: "string", enum: ["image", "thenNow", "archive", "text"] },
          caption: { type: "string", description: "One or two sentences on screen. Under 160 characters." },
          narration: { type: "string", description: "What the companion says for this card. Under 45 words. Empty string for none." },
          imagePrompt: { type: "string", description: "For image cards, and the then half of thenNow cards. Empty string otherwise." },
          textBody: { type: "string", description: "For text cards only: a price list, quote or headline under 40 words. Empty string otherwise." },
          includesCompanion: { type: "boolean", description: "True if the companion herself should appear in the image." },
          claims: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["text", "confidence", "sourceTitle"],
              properties: {
                text: { type: "string" },
                confidence: { type: "string", enum: ["known", "likely", "interpretation"] },
                sourceTitle: { type: "string", description: "Must match a sourceTitle from the dossier." },
              },
            },
          },
          companionContextText: { type: "string", description: "One sentence telling the live companion what the visitor is looking at on this card." },
        },
      },
    },
    transitionLine: { type: "string", description: "What she says as you walk to the next stop. Under 25 words." },
  },
} as const;

/** What the picture researcher finds inside one generated still. */
export const HotspotPlan = z.object({
  points: z.array(
    z.object({
      label: z.string(),
      x: z.number(),
      y: z.number(),
      line: z.string(),
      confidence: z.enum(["high", "medium", "low"]),
    }),
  ),
});
export type HotspotPlan = z.infer<typeof HotspotPlan>;

/** Where named things sit in a finished picture. Used when the script names them. */
export const HotspotFind = z.object({
  points: z.array(
    z.object({
      label: z.string(),
      x: z.number(),
      y: z.number(),
      visible: z.boolean(),
    }),
  ),
});
export type HotspotFind = z.infer<typeof HotspotFind>;

export const HOTSPOT_FIND_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["points"],
  properties: {
    points: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["label", "x", "y", "visible"],
        properties: {
          label: { type: "string", description: "Exactly the label you were asked to find, copied verbatim." },
          x: { type: "number", description: "Horizontal centre of that thing, 0 (left) to 1 (right)." },
          y: { type: "number", description: "Vertical centre of that thing, 0 (top) to 1 (bottom)." },
          visible: { type: "boolean", description: "False if the thing genuinely is not in this picture; then x and y are ignored." },
        },
      },
    },
  },
} as const;

export const HOTSPOT_PLAN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["points"],
  properties: {
    points: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["label", "x", "y", "line", "confidence"],
        properties: {
          label: { type: "string", description: "Two or three words naming the thing, e.g. 'the crossing boy'." },
          x: { type: "number", description: "Horizontal centre of the thing in the image, 0 (left) to 1 (right)." },
          y: { type: "number", description: "Vertical centre of the thing in the image, 0 (top) to 1 (bottom)." },
          line: { type: "string", description: "What she says about it when tapped: one or two spoken sentences in her voice, under 35 words, grounded in the dossier." },
          confidence: { type: "string", enum: ["high", "medium", "low"], description: "How sure you are that the thing is at that position." },
        },
      },
    },
  },
} as const;

export const ArchivePick = z.object({
  nowPhotoIndex: z.number().int(),
  archiveIndex: z.number().int(),
  archiveCaption: z.string(),
  reasoning: z.string(),
});
export type ArchivePick = z.infer<typeof ArchivePick>;

export const ARCHIVE_PICK_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["nowPhotoIndex", "archiveIndex", "archiveCaption", "reasoning"],
  properties: {
    nowPhotoIndex: { type: "integer", description: "Index of the best present-day photograph, or -1 if none is suitable." },
    archiveIndex: { type: "integer", description: "Index of the best period item (engraving, painting or photograph of the era), or -1 if none." },
    archiveCaption: { type: "string", description: "A caption for the archive item in the companion's voice, or empty." },
    reasoning: { type: "string" },
  },
} as const;
