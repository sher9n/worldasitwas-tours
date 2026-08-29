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
  platformKeys: string[];
  openaiApiKey: string;
  falKey?: string;
  realtimeModel: string;
  dev: boolean;
  logger?: boolean;
}

const TtsBody = z.object({
  text: z.string().min(1).max(600),
  voice: z.string().min(1).max(40).default("Alice"),
});

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
  const store = new TourStore(opts.toursDir);
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

  const sendError = (reply: FastifyReply, status: number, code: string, message: string, extra: Record<string, unknown> = {}) =>
    reply.code(status).send({ error: { code, message, ...extra } });

  const requireKey = async (req: FastifyRequest, reply: FastifyReply) => {
    if (opts.platformKeys.length === 0) return; // dev: allow all
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    if (!token || !opts.platformKeys.includes(token)) {
      return sendError(reply, 401, "unauthorized", "Missing or invalid platform key");
    }
  };

  app.get("/health", async () => ({ ok: true, time: new Date().toISOString() }));

  app.get("/v1/catalog", { preHandler: requireKey }, async (_req, reply) => {
    const catalog = await store.catalog();
    reply.header("Cache-Control", "no-cache");
    return catalog;
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

  app.get<{ Params: { tourId: string } }>("/v1/tours/:tourId", { preHandler: requireKey }, async (req, reply) => {
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

  app.post<{ Params: { tourId: string } }>("/v1/tours/:tourId/companion/session", { preHandler: requireKey }, async (req, reply) => {
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

  // Live speech in her own voice: the player sends each sentence of a live
  // answer here; we synthesize via fal's ElevenLabs endpoint (key stays
  // server-side) and stream the audio bytes back.
  app.post<{ Params: { tourId: string } }>("/v1/tours/:tourId/companion/say", { preHandler: requireKey }, async (req, reply) => {
    const stored = await store.get(req.params.tourId);
    if (!stored) return sendError(reply, 404, "tour_not_found", "Unknown or unpublished tour");
    const body = TtsBody.safeParse(req.body ?? {});
    if (!body.success) return sendError(reply, 400, "bad_request", "text (<=600 chars) is required");
    if (!opts.falKey) return sendError(reply, 503, "companion_unavailable", "Speech synthesis not configured");
    try {
      const res = await fetch("https://fal.run/fal-ai/elevenlabs/tts/turbo-v2.5", {
        method: "POST",
        headers: { Authorization: `Key ${opts.falKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ text: body.data.text, voice: body.data.voice, stability: 0.5 }),
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
      return sendError(reply, 503, "companion_unavailable", "Speech synthesis failed");
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
