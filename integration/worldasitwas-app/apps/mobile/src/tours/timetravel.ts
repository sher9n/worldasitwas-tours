/**
 * @timetravel/client — the whole integration, in one dependency-free file.
 *
 * Works unchanged in a browser, in React Native and in Node 18+. It imports
 * nothing: no zod, no node builtins, no polyfills. That is deliberate — this
 * file is meant to be either installed as a package or pasted straight into
 * an app, and a copy that drags dependencies behind it is not pasteable.
 *
 * Two ways to use it, and an app can use both:
 *
 *   1. HOSTED PLAYER. Ask for `playerUrl(tourId)` and put it in a WebView or
 *      an iframe. We render the walk, the voice and the companion; you get
 *      typed events back over postMessage. One screen of code, no media
 *      handling, and a new tour needs no app release.
 *
 *   2. NATIVE. Fetch the manifest with `tour(id)` and draw it yourself with
 *      the types below. More work, total control.
 *
 * KEY HANDLING. `apiKey` is a server-side platform key. Do not ship one in a
 * mobile bundle or a web page: anyone can read it out. Either call this from
 * your own backend, or point `baseUrl` at your backend and have it forward to
 * us with the key attached. The hosted player never needs a key in the client
 * at all, which is the other reason to prefer it.
 */

/* ─────────────────────────── the manifest ─────────────────────────── */
/* Hand-written mirrors of the `tour/1` schema in @timetravel/schema. They are
   checked against the real zod types at compile time in client.types.test.ts,
   so they cannot drift silently. */

/** How sure we are of a claim. Render it; do not hide it. */
export type Confidence = "known" | "likely" | "interpretation";

/** Where a picture came from. A reconstruction must carry a visible badge. */
export type Origin = "reconstruction" | "archive" | "photograph";

export interface GeoPoint {
  lat: number;
  lng: number;
  bearing?: number;
}

export interface Credit {
  title: string;
  holder: string;
  license: string;
  url: string;
}

export interface ImageAsset {
  image: string;
  origin: Origin;
  width?: number;
  height?: number;
  alt?: string;
  credit?: Credit;
}

export interface VideoAsset {
  video: string;
  poster?: string;
  durationSec: number;
  hasAudio: boolean;
  origin?: Origin;
}

/** A line she speaks: the words, the recording, and her face saying it. */
export interface SpokenLine {
  text: string;
  audio?: string;
  durationSec?: number;
  face?: VideoAsset;
}

export interface Ambience {
  audio: string;
  loop: boolean;
  /** How far under narration the loop sits. Negative decibels. */
  gainDb: number;
}

export interface Claim {
  text: string;
  confidence: Confidence;
  /** Points at an entry in `tour.sources`. */
  sourceId: string;
}

export interface CompanionContext {
  text: string;
  image?: string;
}

/** A tappable point inside a still. She turns her voice to it. */
export interface Hotspot {
  id: string;
  /** Position in the image, 0..1 from the top-left. */
  x: number;
  y: number;
  label: string;
  line: SpokenLine;
}

interface CardBase {
  id: string;
  caption?: string;
  narration?: SpokenLine;
  claims: Claim[];
  companionContext?: CompanionContext;
  hotspots: Hotspot[];
}

export type Card =
  | (CardBase & { kind: "image"; media: ImageAsset; motion?: VideoAsset })
  | (CardBase & { kind: "video"; media: VideoAsset })
  | (CardBase & { kind: "thenNow"; then: ImageAsset; now: ImageAsset; motion?: VideoAsset })
  | (CardBase & { kind: "archive"; media: ImageAsset; animated?: VideoAsset; credit: Credit })
  | (CardBase & { kind: "text"; text: string });

export type CardKind = Card["kind"];

export interface Arrival {
  still?: ImageAsset;
  livingScene?: VideoAsset;
  talkingPortrait?: VideoAsset;
  line: SpokenLine;
  ambience?: Ambience;
  hotspots: Hotspot[];
}

export interface Transition {
  text: string;
  video?: string;
  audio?: string;
  durationSec?: number;
  face?: VideoAsset;
}

export interface Stop {
  id: string;
  order: number;
  title: string;
  geo: GeoPoint;
  arrival: Arrival;
  cards: Card[];
  transitionOut?: Transition;
}

export interface Companion {
  name: string;
  role: string;
  bio: string;
  portrait: string;
  greeting: SpokenLine;
  voice: { provider: "openai-realtime"; voice: string };
  faceReel: VideoAsset[];
}

export interface Source {
  id: string;
  title: string;
  url: string;
  license: string;
}

export interface Provenance {
  generatedAt: string;
  reviewedBy: "human" | "none";
  models: string[];
  costUsd: number;
}

export interface Cover {
  image: string;
  video?: string;
}

/** A whole walk. Everything a player needs, in one document. */
export interface Tour {
  schema: "tour/1";
  id: string;
  version: string;
  city: string;
  year: number;
  yearRange: [number, number];
  lang: string;
  title: string;
  summary: string;
  durationMin: number;
  cover: Cover;
  companion: Companion;
  stops: Stop[];
  sources: Source[];
  provenance: Provenance;
}

/** What a search returns per tour: enough to draw a card, not the whole walk. */
export interface TourSummary {
  id: string;
  version: string;
  title: string;
  summary: string;
  city: string;
  year: number;
  yearRange: [number, number];
  lang: string;
  durationMin: number;
  stopCount: number;
  companion: { name: string; role: string; portrait: string };
  cover: Cover;
  start: GeoPoint;
  /** 0 when the tour covers the year asked for; otherwise how far off it is. */
  distanceYears: number;
}

export interface CatalogCity {
  id: string;
  name: string;
  country: string;
  anchor: GeoPoint;
  years: number[];
  tourCount: number;
}

export interface Catalog {
  cities: CatalogCity[];
  updatedAt: string;
}

export interface TourMatches {
  city: string;
  year: number;
  /** Tours whose year range contains the year asked for. */
  matches: TourSummary[];
  /** Only when `matches` is empty: the three closest years we do have. */
  nearest: TourSummary[];
}

/** A short-lived credential for talking to the companion. Never cache it. */
export interface CompanionSession {
  sessionId: string;
  expiresAt: string;
  realtime: {
    provider: string;
    model: string;
    voice: string;
    clientSecret: string;
    connectUrl: string;
  };
  limits: { maxMinutes: number; maxTurns: number };
}

/* ─────────────────────────── errors ─────────────────────────── */

/**
 * Every failure arrives as one of these, so a caller can branch on `code`
 * instead of matching strings. `code` is the API's own machine name
 * ("tour_not_found", "session_limit", "unauthorized"…), or "network" when the
 * request never reached us.
 */
export class TimeTravelError extends Error {
  readonly code: string;
  readonly status: number;
  /** Set on a 429. Wait this many seconds before asking again. */
  readonly retryAfterSec?: number;

  constructor(code: string, message: string, status = 0, retryAfterSec?: number) {
    super(message);
    this.name = "TimeTravelError";
    this.code = code;
    this.status = status;
    this.retryAfterSec = retryAfterSec;
  }
}

/* ─────────────────────────── the player bridge ─────────────────────────── */

/** Stamped on every message the hosted player posts, so you can ignore the rest. */
export const PLAYER_MESSAGE_SOURCE = "timetravel" as const;

/**
 * Everything the player will tell you. The list is closed: a name that is not
 * here is not something we send.
 *
 *   ready          the manifest loaded and the cover is on screen
 *   tour_started   they pressed begin
 *   stop_entered   they arrived at a stop
 *   card_viewed    a screen was left behind (carries how long it was held)
 *   hotspot_opened they tapped a point of interest
 *   then_now_used  they dragged the then/now slider
 *   ask_started    they held the Ask button to interrupt her
 *   companion_tool she acted on something they said
 *   tour_completed they reached the end
 *   tour_left      they closed the tour early — POP YOUR SCREEN ON THIS ONE
 *   error          the tour could not be shown; `payload.message` says why
 */
export const TOUR_EVENTS = [
  "ready",
  "tour_started",
  "stop_entered",
  "card_viewed",
  "hotspot_opened",
  "then_now_used",
  "ask_started",
  "companion_tool",
  "tour_completed",
  "tour_left",
  "error",
] as const;

export type TourEventName = (typeof TOUR_EVENTS)[number];

export interface TourEvent {
  source: typeof PLAYER_MESSAGE_SOURCE;
  v: 1;
  type: "event";
  name: TourEventName;
  payload: Record<string, unknown> & { tourId?: string };
  /** When the player sent it. Epoch milliseconds. */
  t: number;
}

/** Things you can tell the player to do. Post one into the WebView or iframe. */
export type TourCommandName = "pause" | "resume" | "exit";

export interface TourCommand {
  source: typeof PLAYER_MESSAGE_SOURCE;
  v: 1;
  type: "command";
  name: TourCommandName;
}

export function tourCommand(name: TourCommandName): TourCommand {
  return { source: PLAYER_MESSAGE_SOURCE, v: 1, type: "command", name };
}

/** Ready to hand to `webView.injectJavaScript(...)`. */
export function tourCommandScript(name: TourCommandName): string {
  return `window.postMessage(${JSON.stringify(JSON.stringify(tourCommand(name)))},"*");true;`;
}

const EVENT_NAMES: ReadonlySet<string> = new Set(TOUR_EVENTS);

/**
 * Turn whatever arrived on the wire into a typed event, or null.
 *
 * Accepts the raw string a React Native WebView hands you
 * (`e.nativeEvent.data`) and the already-parsed object a browser `message`
 * event carries (`e.data`). Anything that is not one of our events — another
 * library's postMessage traffic, a browser extension, malformed JSON — comes
 * back as null rather than throwing, because a host screen must not crash on
 * a stray message it never asked for.
 */
export function parseTourEvent(raw: unknown): TourEvent | null {
  let data: unknown = raw;
  if (typeof data === "string") {
    try {
      data = JSON.parse(data);
    } catch {
      return null;
    }
  }
  if (!data || typeof data !== "object") return null;
  const m = data as Partial<TourEvent>;
  if (m.source !== PLAYER_MESSAGE_SOURCE || m.type !== "event") return null;
  if (typeof m.name !== "string" || !EVENT_NAMES.has(m.name)) return null;
  return {
    source: PLAYER_MESSAGE_SOURCE,
    v: 1,
    type: "event",
    name: m.name as TourEventName,
    payload: (m.payload && typeof m.payload === "object" ? m.payload : {}) as TourEvent["payload"],
    t: typeof m.t === "number" ? m.t : Date.now(),
  };
}

/* ─────────────────────────── the client ─────────────────────────── */

export interface TimeTravelOptions {
  /** Where the tour API lives, e.g. "https://tours.worldasitwas.com". */
  baseUrl: string;
  /**
   * Platform key. Server-side only — see the note at the top of this file.
   * Leave it out when `baseUrl` is your own backend, which attaches its own.
   */
  apiKey?: string;
  /**
   * Where the hosted player is served, when it is not the same origin as the
   * API. Only `playerUrl()` uses it.
   */
  playerUrl?: string;
  /** Swap in your own fetch (tests, a proxy, a timeout wrapper). */
  fetch?: typeof fetch;
}

export interface FindOptions {
  city: string;
  year: number;
  /** BCP-47-ish language tag. Omitted means every language we have. */
  lang?: string;
}

export interface PlayerUrlOptions {
  /**
   * A stable id for this traveller. It is what the companion's rate limit
   * counts, so use the same one across screens and app launches. Never a
   * name, an email or anything else that identifies a person.
   */
  travellerId?: string;
  /** Start at a stop rather than the cover. */
  stopId?: string;
  lang?: string;
}

export interface CompanionSessionOptions {
  travellerId: string;
  /** Where they are in the walk, so she answers in context. */
  stopId?: string;
  cardId?: string;
  locale?: string;
}

export interface TimeTravelClient {
  /** Every city we have walks for, and which years. */
  catalog(): Promise<Catalog>;
  /** Tours for a city and year, with near misses when there is no exact match. */
  find(opts: FindOptions): Promise<TourMatches>;
  /**
   * The one tour to open for a city and year, or null when we have nothing for
   * that city at all. Prefers an exact match and falls back to the closest
   * year — which is what a "Travel" button wants: one answer, or nothing.
   */
  resolve(opts: FindOptions): Promise<TourSummary | null>;
  /** The whole manifest. Only needed if you are drawing the walk yourself. */
  tour(tourId: string): Promise<Tour>;
  /** The URL to put in a WebView or an iframe. No key travels in it. */
  playerUrl(tourId: string, opts?: PlayerUrlOptions): string;
  /** Mint a short-lived credential for the live companion. */
  companionSession(tourId: string, opts: CompanionSessionOptions): Promise<CompanionSession>;
}

function trimSlash(s: string): string {
  return s.replace(/\/+$/, "");
}

/**
 * Query strings are built by hand rather than with URLSearchParams. React
 * Native ships its own partial polyfill for it, and which parts work has
 * changed between releases — a client that is meant to be pasted into a
 * mobile app cannot depend on that. encodeURIComponent is everywhere.
 */
function qs(params: Record<string, string | number | undefined>): string {
  return Object.entries(params)
    .filter((e): e is [string, string | number] => e[1] !== undefined && e[1] !== "")
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join("&");
}

export function createClient(options: TimeTravelOptions): TimeTravelClient {
  const baseUrl = trimSlash(options.baseUrl);
  const playerBase = trimSlash(options.playerUrl ?? options.baseUrl);
  const doFetch = options.fetch ?? globalThis.fetch;
  if (typeof doFetch !== "function") {
    throw new TimeTravelError("no_fetch", "No global fetch; pass one in options.fetch");
  }

  const headers = (): Record<string, string> =>
    options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {};

  async function call<T>(path: string, init?: RequestInit): Promise<T> {
    let res: Response;
    try {
      res = await doFetch(`${baseUrl}${path}`, {
        ...init,
        headers: { ...headers(), ...(init?.headers as Record<string, string> | undefined) },
      });
    } catch (err) {
      // A DNS failure, an aeroplane, a captive portal. Never a bug in the caller.
      throw new TimeTravelError("network", (err as Error)?.message || "Network request failed");
    }
    if (!res.ok) {
      // The API answers errors as { error: { code, message } }. A proxy or a
      // gateway in between may not, so fall back to the status line.
      let code = `http_${res.status}`;
      let message = `${res.status} ${path}`;
      try {
        const body = (await res.json()) as { error?: { code?: string; message?: string } };
        if (body?.error?.code) code = body.error.code;
        if (body?.error?.message) message = body.error.message;
      } catch {
        /* not JSON; the status line stands */
      }
      const ra = Number(res.headers.get("retry-after"));
      throw new TimeTravelError(code, message, res.status, Number.isFinite(ra) && ra > 0 ? ra : undefined);
    }
    return (await res.json()) as T;
  }

  return {
    catalog: () => call<Catalog>("/v1/catalog"),

    find: ({ city, year, lang }) => call<TourMatches>(`/v1/tours?${qs({ city, year, lang })}`),

    async resolve(opts) {
      let r: TourMatches;
      try {
        r = await this.find(opts);
      } catch (err) {
        // "We do not cover that city" is an answer, not a failure: the caller
        // asked whether there is a walk, and there is not. Everything else —
        // a bad key, a dead network — must still reach them.
        if (err instanceof TimeTravelError && err.code === "city_not_found") return null;
        throw err;
      }
      return r.matches[0] ?? r.nearest[0] ?? null;
    },

    tour: (tourId) => call<Tour>(`/v1/tours/${encodeURIComponent(tourId)}`),

    playerUrl(tourId, opts = {}) {
      return `${playerBase}/?${qs({ tour: tourId, play: 1, traveller: opts.travellerId, stop: opts.stopId, lang: opts.lang })}`;
    },

    companionSession: (tourId, body) =>
      call<CompanionSession>(`/v1/tours/${encodeURIComponent(tourId)}/companion/session`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
  };
}
