import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import { z } from "zod";
import { TourStore } from "./store.ts";
import { mintSession } from "./companion.ts";

export interface AppOptions {
  toursDir: string;
  /** Speech for live answers, in the tour's own voice. Never leaves the server. */
  falKey?: string;
  /**
   * Secret for player tokens. Empty means the player has no way to prove
   * itself, and the tour and companion routes then accept only a platform key.
   */
  playerTokenSecret?: string;
  /** Where media is served from. See config.mediaBaseUrl. */
  mediaBaseUrl: string;
  /** Built player to serve at the root. Empty means do not serve one. */
  playerDir?: string;
  platformKeys: string[];
  openaiApiKey: string;
  realtimeModel: string;
  dev: boolean;
  logger?: boolean;
}

const SessionBody = z.object({
  travellerId: z.string().min(1).max(128),
  stopId: z.string().optional(),
  cardId: z.string().optional(),
  locale: z.string().optional(),
});

/**
 * Per-traveller limiter on minting realtime credentials. A minted secret that
 * is never connected costs nothing (the conversation is what costs, and each
 * session carries its own minute and turn caps), while the player mints one on
 * every page load so the first hold listens instantly. The budget is therefore
 * set for a person reloading and exploring, not for a metered resource.
 */
const SESSION_WINDOW_MS = 10 * 60_000;
const SESSION_BUDGET = 30;
class SessionLimiter {
  private hits = new Map<string, number[]>();
  /** Returns how many seconds until a mint is allowed again, or 0 when allowed now. */
  retryAfter(id: string, now = Date.now()): number {
    const arr = (this.hits.get(id) ?? []).filter((t) => now - t < SESSION_WINDOW_MS);
    if (arr.length >= SESSION_BUDGET) {
      this.hits.set(id, arr);
      return Math.max(1, Math.ceil((SESSION_WINDOW_MS - (now - arr[0])) / 1000));
    }
    arr.push(now);
    this.hits.set(id, arr);
    return 0;
  }
}

export async function buildApp(opts: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? false });
  const store = new TourStore(opts.toursDir, opts.mediaBaseUrl);
  const limiter = new SessionLimiter();

  await app.register(cors, { origin: true });
  await fs.mkdir(opts.toursDir, { recursive: true });
  await app.register(fastifyStatic, {
    root: opts.toursDir,
    prefix: "/media/",
    decorateReply: false,
    cacheControl: true,
    maxAge: "365d",
    immutable: true,
  });

  // Read once at boot: a per-request read of the same file on every deep link
  // is a syscall for nothing, and a missing file should fail loudly at start
  // rather than quietly on the first traveller.
  const indexHtml = opts.playerDir ? await fs.readFile(path.join(opts.playerDir, "index.html"), "utf8") : "";

  const sendError = (reply: FastifyReply, status: number, code: string, message: string, extra: Record<string, unknown> = {}) =>
    reply.code(status).send({ error: { code, message, ...extra } });

  const hasPlatformKey = (req: FastifyRequest): boolean => {
    const header = req.headers.authorization || "";
    if (!header.startsWith("Bearer ")) return false;
    const token = header.slice(7).trim();
    // Constant-time, so a wrong key cannot be found one character at a time.
    return opts.platformKeys.some(
      (k) => k.length === token.length && crypto.timingSafeEqual(Buffer.from(k), Buffer.from(token)),
    );
  };

  const requireKey = async (req: FastifyRequest, reply: FastifyReply) => {
    if (opts.platformKeys.length === 0) return; // dev: allow all
    if (!hasPlatformKey(req)) return sendError(reply, 401, "unauthorized", "Missing or invalid platform key");
  };

  /**
   * A player token: `<expiresAt>.<travellerId>.<signature>`, presented as
   * `Authorization: Player …`.
   *
   * It authorises one tour for one traveller until it expires, and nothing
   * else — not the catalogue, not a search, not another walk. That is what
   * lets the hosted player run in a browser without holding the platform key,
   * which anyone who opens the page could read straight out of it.
   */
  const playerTokenGrants = (req: FastifyRequest, tourId: string): boolean => {
    if (!opts.playerTokenSecret) return false;
    const header = req.headers.authorization || "";
    if (!header.startsWith("Player ")) return false;

    const raw = header.slice(7).trim();
    const dot = raw.indexOf(".");
    const lastDot = raw.lastIndexOf(".");
    if (dot < 1 || lastDot <= dot) return false;

    const expiresAt = Number(raw.slice(0, dot));
    const travellerId = decodeURIComponent(raw.slice(dot + 1, lastDot));
    const provided = raw.slice(lastDot + 1);
    if (!Number.isFinite(expiresAt) || expiresAt * 1000 < Date.now()) return false;

    const expected = crypto
      .createHmac("sha256", opts.playerTokenSecret)
      .update(`${tourId}\n${travellerId}\n${expiresAt}`)
      .digest("base64url");
    if (expected.length !== provided.length) return false;
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(provided));
  };

  /**
   * The two routes a player itself needs. Either credential opens them: a
   * platform key for server-to-server, or a token for this exact walk.
   */
  const requireKeyOrPlayerToken = async (req: FastifyRequest, reply: FastifyReply) => {
    if (opts.platformKeys.length === 0) return; // dev: allow all
    const tourId = (req.params as { tourId?: string })?.tourId ?? "";
    if (hasPlatformKey(req) || playerTokenGrants(req, tourId)) return;
    return sendError(reply, 401, "unauthorized", "Missing or invalid platform key or player token");
  };

  // Railway gates a new deployment on this before routing traffic to it, so it
  // must answer only once the catalogue is actually readable — a container that
  // says ok with no tours mounted would take the old one down and serve nothing.
  app.get("/health", async (_req, reply) => {
    try {
      const catalog = await store.catalog();
      return { ok: true, tours: catalog.cities.reduce((n, c) => n + c.tourCount, 0), cities: catalog.cities.length, time: new Date().toISOString() };
    } catch (err) {
      return sendError(reply, 503, "not_ready", (err as Error).message);
    }
  });

  app.get("/v1/catalog", { preHandler: requireKey }, async (_req, reply) => {
    const catalog = await store.catalog();
    reply.header("Cache-Control", "no-cache");
    return catalog;
  });

  /**
   * Everything we have, flattened for a map. Platform key only, like the
   * catalogue: it is a server-to-server read, and a host serves it on to its own
   * clients from its own origin rather than shipping our key to a browser.
   *
   * ETagged over the manifests it contains rather than over the response body,
   * which carries a timestamp and would therefore never match twice. A host can
   * poll this every few minutes for the cost of a 304.
   */
  app.get("/v1/feed", { preHandler: requireKey }, async (req, reply) => {
    const etag = await store.feedEtag();
    if (req.headers["if-none-match"] === etag) return reply.code(304).send();
    reply.header("ETag", etag);
    reply.header("Cache-Control", "no-cache");
    return store.feed();
  });

  app.get("/v1/tours", { preHandler: requireKey }, async (req, reply) => {
    const q = z
      .object({ city: z.string().min(1), year: z.coerce.number().int(), lang: z.string().optional() })
      .safeParse(req.query);
    if (!q.success) return sendError(reply, 400, "bad_request", "city and integer year are required");
    const catalog = await store.catalog();
    if (!catalog.cities.some((c) => c.id === q.data.city)) {
      return sendError(reply, 404, "city_not_found", `Unknown city "${q.data.city}"; use ids from /v1/catalog`);
    }
    const { matches, nearest } = await store.forCityYear(q.data.city, q.data.year, q.data.lang);
    reply.header("Cache-Control", "no-cache");
    return { city: q.data.city, year: q.data.year, matches, nearest };
  });

  app.get<{ Params: { tourId: string } }>("/v1/tours/:tourId", { preHandler: requireKeyOrPlayerToken }, async (req, reply) => {
    const stored = await store.get(req.params.tourId);
    if (!stored) return sendError(reply, 404, "tour_not_found", "Unknown or unpublished tour");
    if (req.headers["if-none-match"] === stored.etag) return reply.code(304).send();
    reply.header("ETag", stored.etag);
    // A republish must reach a player that already has the tour open. The ETag
    // makes revalidation free (304, no body); a max-age would hand back a stale
    // manifest, narration and all, for as long as it lasted.
    reply.header("Cache-Control", "no-cache");
    return stored.tour;
  });

  app.post<{ Params: { tourId: string } }>("/v1/tours/:tourId/companion/session", { preHandler: requireKeyOrPlayerToken }, async (req, reply) => {
    const stored = await store.get(req.params.tourId);
    if (!stored) return sendError(reply, 404, "tour_not_found", "Unknown or unpublished tour");
    const body = SessionBody.safeParse(req.body ?? {});
    if (!body.success) return sendError(reply, 400, "bad_request", "travellerId is required");
    const wait = limiter.retryAfter(body.data.travellerId);
    if (wait > 0) {
      reply.header("Retry-After", String(wait));
      return sendError(reply, 429, "session_limit", `Her voice is resting; try again in ${wait} second${wait === 1 ? "" : "s"}`);
    }
    if (!opts.openaiApiKey) return sendError(reply, 503, "companion_unavailable", "Voice provider not configured");
    try {
      const session = await mintSession({
        apiKey: opts.openaiApiKey,
        model: opts.realtimeModel,
        tour: stored.tour,
        companionNotes: stored.companionNotes,
        request: body.data,
      });
      return session;
    } catch (err) {
      req.log.error(err);
      return sendError(reply, 503, "companion_unavailable", "Voice provider is not reachable right now");
    }
  });

  /**
   * The player, served from the same origin as the API.
   *
   * One origin means one domain to point a WebView at, no CORS between the
   * page and the manifest it is rendering, and no second deployment to keep in
   * step with this one. The hashed asset filenames Vite emits are immutable;
   * index.html must not be, or a deploy never reaches a browser that has been
   * here before.
   */
  if (opts.playerDir) {
    await app.register(fastifyStatic, {
      root: opts.playerDir,
      prefix: "/",
      decorateReply: false,
      index: ["index.html"],
      // Off, so setHeaders below is the only thing writing this header. Left on,
      // @fastify/static's own default wins and every fingerprinted asset comes
      // back as max-age=0 — a full re-download of the player on every open.
      cacheControl: false,
      // Vite fingerprints everything under /assets; index.html is the one file
      // whose name never changes, so it revalidates on every load.
      setHeaders: (res, filePath) => {
        const immutable = filePath.includes(`${path.sep}assets${path.sep}`);
        res.setHeader("Cache-Control", immutable ? "public, max-age=31536000, immutable" : "no-cache");
      },
    });

    // The player is a single page: a deep link like /?tour=…&play=1 is already
    // the root, but anything else that is not an API route still has to land on
    // it rather than on a 404 from Fastify.
    app.setNotFoundHandler((req, reply) => {
      if (req.method !== "GET" || req.url.startsWith("/v1/") || req.url.startsWith("/media/") || req.url.startsWith("/dev/")) {
        return sendError(reply, 404, "not_found", `No route for ${req.method} ${req.url}`);
      }
      return reply.type("text/html").header("Cache-Control", "no-cache").send(indexHtml);
    });
  }

  // One sentence of a live answer, spoken in the voice this tour is recorded in.
  // The player sends text as it streams, so she starts talking a sentence in
  // rather than after the whole answer.
  // A player token is exactly the right credential here: the hosted player holds
  // one, and speaking an answer belongs to the same walk the token authorises.
  app.post<{ Params: { tourId: string } }>("/v1/tours/:tourId/companion/say", { preHandler: requireKeyOrPlayerToken }, async (req, reply) => {
    const stored = await store.get(req.params.tourId);
    if (!stored) return sendError(reply, 404, "tour_not_found", "Unknown or unpublished tour");
    const body = z.object({ text: z.string().min(1).max(600) }).safeParse(req.body ?? {});
    if (!body.success) return sendError(reply, 400, "bad_request", "text (<=600 chars) is required");
    if (!opts.falKey) return sendError(reply, 503, "companion_unavailable", "Speech is not configured");
    const voice = stored.tour.companion.narrationVoice;
    try {
      const res = await fetch("https://fal.run/fal-ai/elevenlabs/tts/eleven-v3", {
        method: "POST",
        headers: { Authorization: `Key ${opts.falKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ text: `[warmly] ${body.data.text}`, voice, stability: 0.3, language_code: "en" }),
      });
      if (!res.ok) throw new Error(`fal tts ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const json = (await res.json()) as { audio: { url: string } };
      const audio = await fetch(json.audio.url);
      if (!audio.ok) throw new Error(`fal tts fetch ${audio.status}`);
      reply.header("Content-Type", "audio/mpeg");
      reply.header("Cache-Control", "no-store");
      return reply.send(Buffer.from(await audio.arrayBuffer()));
    } catch (err) {
      req.log.error(err);
      return sendError(reply, 503, "companion_unavailable", "Speech failed");
    }
  });

  if (opts.dev) {
    // Playground helpers: not part of the platform contract.
    app.get<{ Params: { tourId: string } }>("/dev/tours/:tourId/ledger", async (req, reply) => {
      const stored = await store.get(req.params.tourId);
      if (!stored) return sendError(reply, 404, "tour_not_found", "Unknown tour");
      try {
        const raw = await fs.readFile(path.join(stored.dir, "ledger.json"), "utf8");
        return JSON.parse(raw);
      } catch {
        return { entries: [], totalUsd: 0 };
      }
    });
  }

  return app;
}
