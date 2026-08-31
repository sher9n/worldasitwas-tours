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
    // Off, so setHeaders below is the only writer of this header.
    cacheControl: false,
    // Tour media is fingerprinted (?v=hash) and safely immutable. Pages and
    // feeds served from under /media (the socials pack, the galleries) are
    // NOT: a browser that cached one for a year kept showing a redone film's
    // old cut for as long as the filename stayed the same. Documents
    // revalidate; media stays put for a year.
    setHeaders: (res, filePath) => {
      const doc = /\.(html|json)$/i.test(filePath);
      res.setHeader("Cache-Control", doc ? "no-cache" : "public, max-age=31536000, immutable");
    },
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

  /**
   * A browsing pass, for opening the catalogue on a phone without carrying a
   * platform key. /bypass sets it; it is signed with the same secret as a player
   * token, HttpOnly so no script can read it back out, and it grants only what a
   * platform key grants on read routes. It is a convenience for whoever runs the
   * service, not a way to hand the whole catalogue to the internet: anyone who
   * knows the path can browse, so treat it as public if you enable it.
   */
  const BYPASS_COOKIE = "tt_pass";
  const bypassValue = (): string =>
    opts.playerTokenSecret ? crypto.createHmac("sha256", opts.playerTokenSecret).update("browse").digest("base64url") : "";
  const hasBypass = (req: FastifyRequest): boolean => {
    const want = bypassValue();
    if (!want) return false;
    const raw = req.headers.cookie || "";
    const got = raw
      .split(";")
      .map((c) => c.trim())
      .find((c) => c.startsWith(`${BYPASS_COOKIE}=`))
      ?.slice(BYPASS_COOKIE.length + 1);
    if (!got || got.length !== want.length) return false;
    return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want));
  };

  const requireKey = async (req: FastifyRequest, reply: FastifyReply) => {
    if (opts.platformKeys.length === 0) return; // dev: allow all
    if (hasPlatformKey(req) || hasBypass(req)) return;
    return sendError(reply, 401, "unauthorized", "Missing or invalid platform key");
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
    if (hasPlatformKey(req) || hasBypass(req) || playerTokenGrants(req, tourId)) return;
    return sendError(reply, 401, "unauthorized", "Missing or invalid platform key or player token");
  };

  // Railway gates a new deployment on this before routing traffic to it, so it
  // must answer only once the catalogue is actually readable — a container that
  // says ok with no tours mounted would take the old one down and serve nothing.
  // Open the player with a browsing pass in place, so nothing has to be typed
  // or pasted and no key ends up in a URL, a history or a screenshot.
  app.get("/bypass", async (_req, reply) => {
    const value = bypassValue();
    if (!value) return sendError(reply, 503, "unavailable", "This service has no player secret configured");
    reply.header("Set-Cookie", `${BYPASS_COOKIE}=${value}; Path=/; Max-Age=${60 * 60 * 24 * 30}; HttpOnly; Secure; SameSite=Lax`);
    return reply.redirect("/");
  });

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

  /**
   * The chat ledger: one JSONL line per completed ask, appended by the player
   * when an answer finishes. It lives under the tours volume in _chats, which
   * the catalogue skips (no manifest.json), so it persists with the media and
   * can never appear as a walk.
   *
   * The realtime call runs browser-to-OpenAI, so the server never sees the
   * words unless the player reports them; this is that report.
   */
  const chatsDir = path.join(opts.toursDir, "_chats");
  await fs.mkdir(chatsDir, { recursive: true });
  const ChatTurn = z.object({
    sessionId: z.string().min(1).max(80),
    travellerId: z.string().min(1).max(80),
    stopId: z.string().max(80).optional(),
    question: z.string().max(4000),
    answer: z.string().max(8000),
    model: z.string().max(80).optional(),
    usage: z
      .object({
        input_tokens: z.number().int().nonnegative().optional(),
        output_tokens: z.number().int().nonnegative().optional(),
        total_tokens: z.number().int().nonnegative().optional(),
      })
      .optional(),
  });
  app.post<{ Params: { tourId: string } }>("/v1/tours/:tourId/companion/chat", { preHandler: requireKeyOrPlayerToken }, async (req, reply) => {
    const stored = await store.get(req.params.tourId);
    if (!stored) return sendError(reply, 404, "tour_not_found", "Unknown or unpublished tour");
    const body = ChatTurn.safeParse(req.body ?? {});
    if (!body.success) return sendError(reply, 400, "bad_request", "not a chat turn");
    const t = body.data;
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      tour: req.params.tourId,
      ...t,
      qChars: t.question.length,
      aChars: t.answer.length,
    });
    const file = path.join(chatsDir, `turns-${new Date().toISOString().slice(0, 10)}.jsonl`);
    await fs.appendFile(file, line + "\n");
    return { ok: true };
  });

  // The operator's view of every conversation, newest first.
  app.get("/v1/chats", { preHandler: requireKey }, async (req) => {
    const limit = Math.min(1000, Math.max(1, Number((req.query as { limit?: string }).limit) || 200));
    let files: string[] = [];
    try {
      files = (await fs.readdir(chatsDir)).filter((f) => f.startsWith("turns-") && f.endsWith(".jsonl")).sort().reverse();
    } catch {
      files = [];
    }
    const turns: unknown[] = [];
    for (const f of files) {
      if (turns.length >= limit) break;
      const lines = (await fs.readFile(path.join(chatsDir, f), "utf8")).trim().split("\n").filter(Boolean).reverse();
      for (const l of lines) {
        if (turns.length >= limit) break;
        try {
          turns.push(JSON.parse(l));
        } catch {
          // one bad line must not hide the rest
        }
      }
    }
    return { turns };
  });

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
    // A walk uploaded before the manifest carried its voice would otherwise ask
    // for an empty one and get silence; a named voice is a better answer than
    // no answer, even if it is not quite the right person.
    const voice = stored.tour.companion.narrationVoice || "Alice";
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
