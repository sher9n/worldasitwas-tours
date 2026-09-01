/**
 * Tour manifest schema, version "tour/1".
 *
 * This is the contract between the batch pipeline (which writes manifests),
 * the API (which serves them) and any player (which renders them). The shapes
 * here mirror the integration brief shared with the platform team.
 */
import { z } from "zod";

export const SCHEMA_VERSION = "tour/1" as const;

/** How sure we are about a claim. Rendered as a chip on the card. */
export const Confidence = z.enum(["known", "likely", "interpretation"]);
export type Confidence = z.infer<typeof Confidence>;

/** Where a picture comes from. Reconstructions must carry a visible badge. */
export const Origin = z.enum(["reconstruction", "archive", "photograph"]);
export type Origin = z.infer<typeof Origin>;

const url = z.string().min(1);

export const GeoPoint = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  bearing: z.number().min(0).max(360).optional(),
});
export type GeoPoint = z.infer<typeof GeoPoint>;

export const Credit = z.object({
  title: z.string().min(1),
  holder: z.string().min(1),
  license: z.string().min(1),
  url: url,
});
export type Credit = z.infer<typeof Credit>;

export const ImageAsset = z.object({
  image: url,
  origin: Origin,
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  alt: z.string().optional(),
  /** Required in practice for archive items and licensed photographs. */
  credit: Credit.optional(),
});
export type ImageAsset = z.infer<typeof ImageAsset>;

export const VideoAsset = z.object({
  video: url,
  poster: url.optional(),
  durationSec: z.number().positive(),
  hasAudio: z.boolean().default(false),
  origin: Origin.optional(),
});
export type VideoAsset = z.infer<typeof VideoAsset>;

export const SpokenLine = z.object({
  text: z.string().min(1),
  audio: url.optional(),
  durationSec: z.number().positive().optional(),
  /** Her face saying exactly this line (lip-synced talking portrait). */
  face: VideoAsset.optional(),
});
export type SpokenLine = z.infer<typeof SpokenLine>;

export const Ambience = z.object({
  audio: url,
  loop: z.boolean().default(true),
  /** How far under narration the loop sits. Negative decibels. */
  gainDb: z.number().max(0).default(-14),
});
export type Ambience = z.infer<typeof Ambience>;

export const Claim = z.object({
  text: z.string().min(1),
  confidence: Confidence,
  sourceId: z.string().min(1),
});
export type Claim = z.infer<typeof Claim>;

/** What the live companion is told when this card is on screen. Sent verbatim. */
export const CompanionContext = z.object({
  text: z.string().min(1),
  image: url.optional(),
});
export type CompanionContext = z.infer<typeof CompanionContext>;

/** A tappable point of interest inside a still: she turns her voice to it. */
export const Hotspot = z.object({
  id: z.string().min(1),
  /** Position in the image, 0..1 from the top-left. */
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  label: z.string().min(1).max(40),
  line: SpokenLine,
});
export type Hotspot = z.infer<typeof Hotspot>;

const CardBase = z.object({
  id: z.string().min(1),
  caption: z.string().max(280).optional(),
  narration: SpokenLine.optional(),
  claims: z.array(Claim).default([]),
  companionContext: CompanionContext.optional(),
  hotspots: z.array(Hotspot).default([]),
});

export const ImageCard = CardBase.extend({
  kind: z.literal("image"),
  media: ImageAsset,
  /** One clip of this scene, played once then resting on its final frame. */
  motion: VideoAsset.optional(),
});
export const VideoCard = CardBase.extend({
  kind: z.literal("video"),
  media: VideoAsset,
});
export const ThenNowCard = CardBase.extend({
  kind: z.literal("thenNow"),
  then: ImageAsset,
  now: ImageAsset,
  /** One clip of the year-view, played once then resting on its final frame. */
  motion: VideoAsset.optional(),
});
export const ArchiveCard = CardBase.extend({
  kind: z.literal("archive"),
  media: ImageAsset,
  /** The real picture, brought to life. Optional. */
  animated: VideoAsset.optional(),
  credit: Credit,
});
export const TextCard = CardBase.extend({
  kind: z.literal("text"),
  text: z.string().min(1).max(320),
});

export const Card = z.discriminatedUnion("kind", [ImageCard, VideoCard, ThenNowCard, ArchiveCard, TextCard]);
export type Card = z.infer<typeof Card>;
export type CardKind = Card["kind"];

export const Arrival = z.object({
  /** The scene the visitor arrives on. Every screen in the tour is a still. */
  still: ImageAsset.optional(),
  livingScene: VideoAsset.optional(),
  talkingPortrait: VideoAsset.optional(),
  line: SpokenLine,
  ambience: Ambience.optional(),
  /** Points on the arrival view; they fade in as her line winds down. */
  hotspots: z.array(Hotspot).default([]),
});
export type Arrival = z.infer<typeof Arrival>;

export const Transition = z.object({
  text: z.string().min(1),
  video: url.optional(),
  audio: url.optional(),
  durationSec: z.number().positive().optional(),
  /** Her face saying the walking line. */
  face: VideoAsset.optional(),
});
export type Transition = z.infer<typeof Transition>;

export const Stop = z.object({
  id: z.string().min(1),
  order: z.number().int().positive(),
  title: z.string().min(1),
  /**
   * One line about this place, for a map pin or a list. Optional, and every
   * manifest published before it existed is still valid: `stopDescription`
   * falls back to what the stop already says for itself.
   */
  blurb: z.string().max(280).optional(),
  geo: GeoPoint,
  arrival: Arrival,
  cards: z.array(Card).min(1),
  transitionOut: Transition.optional(),
});
export type Stop = z.infer<typeof Stop>;

export const Voice = z.object({
  provider: z.literal("openai-realtime"),
  voice: z.string().min(1),
});

/**
 * Research prose arrives with its citations attached: markdown links, bare
 * URLs, "([researchgate.net])", "Source: ...". That is right for a dossier and
 * wrong everywhere it is actually used, which is a card a traveller reads and a
 * prompt a guide speaks from. A guide handed her own footnotes talks like a
 * literature review; a card handed them shows a wall of URLs.
 */
export function stripCitations(text: string): string {
  return text
    .replace(/\[([^\]]*)\]\((?:https?:\/\/|`)[^)]*\)/g, "$1") // [label](url) keeps the label
    .replace(/\(`?https?:\/\/[^)]*\)/g, "") // (url) and (`url`)
    .replace(/`?https?:\/\/\S+`?/g, "") // anything else that is a bare link
    .replace(/\(\[[^\]]*\]\)/g, "") // ([researchgate.net])
    .replace(/\b(?:Sources?|See also|Citation)\s*:\s*/gi, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/ +([.,;:])/g, "$1")
    .replace(/\(\s*\)/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export const Companion = z.object({
  name: z.string().min(1),
  role: z.string().min(1),
  bio: z.string().min(1),
  /**
   * Three lines at most: who she is and what this walk is, written to be read
   * by a traveller on the guide card. The bio behind it is for the model.
   */
  intro: z.string().max(420).optional(),
  portrait: url,
  greeting: SpokenLine,
  voice: Voice,
  /** The voice the tour is recorded in. A live answer is spoken in it too, so a
   * question is answered by the same person who has been telling the story. */
  narrationVoice: z.string().default(""),
  /** Reusable clips of her talking; the player rotates through them while any
   * of her audio plays and freezes her in silence. Works for live answers. */
  faceReel: z.array(VideoAsset).default([]),
});
export type Companion = z.infer<typeof Companion>;

export const Source = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  url: url,
  license: z.string().min(1),
});
export type Source = z.infer<typeof Source>;

export const Provenance = z.object({
  generatedAt: z.string().datetime(),
  reviewedBy: z.enum(["human", "none"]).default("none"),
  models: z.array(z.string()),
  costUsd: z.number().min(0),
});
export type Provenance = z.infer<typeof Provenance>;

export const Cover = z.object({
  image: url,
  video: url.optional(),
});

export const Tour = z
  .object({
    schema: z.literal(SCHEMA_VERSION),
    id: z.string().regex(/^tour_[a-z0-9_]+$/),
    version: z.string().min(1),
    city: z.string().regex(/^[a-z][a-z0-9-]*$/),
    year: z.number().int(),
    yearRange: z.tuple([z.number().int(), z.number().int()]),
    lang: z.string().min(2).max(5).default("en"),
    title: z.string().min(1),
    summary: z.string().min(1),
    durationMin: z.number().positive(),
    cover: Cover,
    companion: Companion,
    stops: z.array(Stop).min(1),
    sources: z.array(Source),
    provenance: Provenance,
  })
  .superRefine((tour, ctx) => {
    if (tour.yearRange[0] > tour.year || tour.yearRange[1] < tour.year) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "yearRange must contain year", path: ["yearRange"] });
    }
    const sourceIds = new Set(tour.sources.map((s) => s.id));
    const orders = new Set<number>();
    tour.stops.forEach((stop, si) => {
      if (orders.has(stop.order)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate stop order ${stop.order}`, path: ["stops", si, "order"] });
      }
      orders.add(stop.order);
      stop.cards.forEach((card, ci) => {
        card.claims.forEach((claim, ki) => {
          if (!sourceIds.has(claim.sourceId)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `claim references unknown source "${claim.sourceId}"`,
              path: ["stops", si, "cards", ci, "claims", ki, "sourceId"],
            });
          }
        });
        if (card.kind === "archive" && card.media.origin !== "archive") {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: "archive card media must have origin archive", path: ["stops", si, "cards", ci, "media", "origin"] });
        }
        if (card.kind === "thenNow" && card.now.origin === "reconstruction") {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: "the now image of a thenNow card must be a photograph or archive item", path: ["stops", si, "cards", ci, "now", "origin"] });
        }
      });
    });
  });
export type Tour = z.infer<typeof Tour>;

/** What GET /v1/tours returns per tour. Derived from a manifest. */
export const TourSummary = z.object({
  id: z.string(),
  version: z.string(),
  title: z.string(),
  summary: z.string(),
  city: z.string(),
  year: z.number().int(),
  yearRange: z.tuple([z.number().int(), z.number().int()]),
  lang: z.string(),
  durationMin: z.number(),
  stopCount: z.number().int(),
  companion: z.object({ name: z.string(), role: z.string(), portrait: z.string() }),
  cover: Cover,
  start: GeoPoint,
  distanceYears: z.number().int(),
});
export type TourSummary = z.infer<typeof TourSummary>;

export const CatalogCity = z.object({
  id: z.string(),
  name: z.string(),
  country: z.string(),
  anchor: GeoPoint,
  years: z.array(z.number().int()),
  tourCount: z.number().int(),
});
export const Catalog = z.object({
  cities: z.array(CatalogCity),
  updatedAt: z.string().datetime(),
});
export type Catalog = z.infer<typeof Catalog>;

/* ------------------------------------------------------------------------ */
/* The feed: everything needed to draw our walks on somebody else's map.      */
/* ------------------------------------------------------------------------ */

export const FEED_VERSION = "feed/1" as const;

/** One place the walk stops at, as a map pin rather than as a screenplay. */
export const FeedStop = z.object({
  id: z.string(),
  /** 1-based, and already sorted. Joining them in this order draws the route. */
  order: z.number().int().positive(),
  name: z.string(),
  /** One line. Derived when the manifest carries no blurb of its own. */
  description: z.string(),
  lat: z.number(),
  lng: z.number(),
  /** Which way she is facing, where the manifest says. Degrees from north. */
  bearing: z.number().optional(),
});
export type FeedStop = z.infer<typeof FeedStop>;

/**
 * One walk, flattened for plotting.
 *
 * `companion` is the guide: the person who walks you round. It keeps the name it
 * has everywhere else in this API rather than gaining a second one here.
 */
export const FeedTour = z.object({
  id: z.string(),
  version: z.string(),
  title: z.string(),
  summary: z.string(),
  city: z.object({ id: z.string(), name: z.string(), country: z.string() }),
  year: z.number().int(),
  yearRange: z.tuple([z.number().int(), z.number().int()]),
  lang: z.string(),
  durationMin: z.number(),
  stopCount: z.number().int(),
  companion: z.object({ name: z.string(), role: z.string(), portrait: z.string() }),
  cover: Cover,
  /** The first stop. Where to drop the pin for the walk as a whole. */
  start: z.object({ lat: z.number(), lng: z.number() }),
  stops: z.array(FeedStop),
});
export type FeedTour = z.infer<typeof FeedTour>;

export const Feed = z.object({
  schema: z.literal(FEED_VERSION),
  updatedAt: z.string().datetime(),
  cities: z.array(CatalogCity),
  tours: z.array(FeedTour),
});
export type Feed = z.infer<typeof Feed>;

/**
 * A sentence about a stop, whatever the manifest happens to carry.
 *
 * Preference order is deliberate: an explicit blurb was written for exactly this
 * job; a card caption was written to sit under a picture and reads well alone; her
 * arrival line was written to be spoken, so it is the last resort and gets cut at a
 * sentence rather than mid-clause.
 */
export function stopDescription(stop: Stop): string {
  if (stop.blurb) return stop.blurb;
  const caption = stop.cards.find((c) => c.caption)?.caption;
  if (caption) return caption;
  const spoken = stop.arrival.line.text.trim();
  if (spoken.length <= 200) return spoken;
  // Cut at the last sentence end inside the budget, so it never stops mid-clause.
  const cut = spoken.slice(0, 200);
  const stopAt = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
  return stopAt > 60 ? cut.slice(0, stopAt + 1) : `${cut.trimEnd()}...`;
}

export interface FeedCityMeta {
  name: string;
  country: string;
}

/** Flatten one manifest for the feed. */
export function feedTour(tour: Tour, city: FeedCityMeta): FeedTour {
  const stops = [...tour.stops].sort((a, b) => a.order - b.order);
  return {
    id: tour.id,
    version: tour.version,
    title: tour.title,
    summary: tour.summary,
    city: { id: tour.city, name: city.name, country: city.country },
    year: tour.year,
    yearRange: tour.yearRange,
    lang: tour.lang,
    durationMin: tour.durationMin,
    stopCount: tour.stops.length,
    companion: { name: tour.companion.name, role: tour.companion.role, portrait: tour.companion.portrait },
    cover: tour.cover,
    start: { lat: stops[0].geo.lat, lng: stops[0].geo.lng },
    stops: stops.map((s) => ({
      id: s.id,
      order: s.order,
      name: s.title,
      description: stopDescription(s),
      lat: s.geo.lat,
      lng: s.geo.lng,
      ...(s.geo.bearing === undefined ? {} : { bearing: s.geo.bearing }),
    })),
  };
}

export function summarize(tour: Tour, forYear?: number): TourSummary {
  const y = forYear ?? tour.year;
  const [a, b] = tour.yearRange;
  const distanceYears = y >= a && y <= b ? 0 : y < a ? a - y : y - b;
  return {
    id: tour.id,
    version: tour.version,
    title: tour.title,
    summary: tour.summary,
    city: tour.city,
    year: tour.year,
    yearRange: tour.yearRange,
    lang: tour.lang,
    durationMin: tour.durationMin,
    stopCount: tour.stops.length,
    companion: { name: tour.companion.name, role: tour.companion.role, portrait: tour.companion.portrait },
    cover: tour.cover,
    start: tour.stops[0].geo,
    distanceYears,
  };
}

/** Parse and validate a manifest. Throws a ZodError with paths on failure. */
export function parseTour(input: unknown): Tour {
  return Tour.parse(input);
}

/* ------------------------------------------------------------------------ */
/* Recipe: the input to the batch pipeline. One recipe becomes one tour.     */
/* ------------------------------------------------------------------------ */

export const RecipeStop = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  geo: GeoPoint,
  /** What this stop is about, in a sentence or two. The researcher expands it. */
  brief: z.string().min(1),
  /** Things the script must cover here. */
  mustCover: z.array(z.string()).default([]),
  /** Search phrases for finding a present-day photograph and archive items. */
  archiveQueries: z.array(z.string()).default([]),
});

export const Recipe = z.object({
  id: z.string().regex(/^tour_[a-z0-9_]+$/),
  city: z.string().regex(/^[a-z][a-z0-9-]*$/),
  cityName: z.string().min(1),
  country: z.string().length(2),
  year: z.number().int(),
  yearRange: z.tuple([z.number().int(), z.number().int()]),
  lang: z.string().default("en"),
  title: z.string().min(1),
  theme: z.string().min(1),
  companion: z.object({
    name: z.string().min(1),
    role: z.string().min(1),
    /** Who she is, where her voice comes from, what she cares about. */
    brief: z.string().min(1),
    voice: z.string().default("marin"),
    /** ElevenLabs voice name used for pre-recorded narration. */
    narrationVoice: z.string().default("Alice"),
    /**
     * Where this guide stands when nothing is asked of them, and the small
     * thing their hands do while they wait. The presence loop in their circle
     * is written from these two facts, so it is theirs rather than generic.
     */
    presence: z
      .object({
        /** Where they are and what is behind them. */
        standing: z.string().min(1),
        /** Their own idle gesture: "wipes her hands on her apron". */
        gesture: z.string().min(1),
      })
      .optional(),
  }),
  /** Visual direction applied to every reconstruction prompt. */
  style: z.object({
    look: z.string().min(1),
    avoid: z.string().default(""),
  }),
  stops: z.array(RecipeStop).min(1),
  /** Primary sources the researcher should start from. */
  seedSources: z
    .array(z.object({ title: z.string(), url: z.string(), license: z.string(), note: z.string().optional() }))
    .default([]),
});
export type Recipe = z.infer<typeof Recipe>;
export type RecipeStop = z.infer<typeof RecipeStop>;

export function parseRecipe(input: unknown): Recipe {
  return Recipe.parse(input);
}
