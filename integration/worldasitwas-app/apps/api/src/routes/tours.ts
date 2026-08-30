/**
 * The tour boundary, on our side of it.
 *
 * The mobile app never talks to the tour service directly. It asks this route
 * which walk to open, and gets back a player URL that carries no credential.
 * That is the whole reason this file exists: the platform key is a server-side
 * secret, and anything in an EXPO_PUBLIC_ variable ships inside the .ipa where
 * it can be read straight out.
 *
 * Register it in app.ts beside the others:
 *
 *   import { registerTourRoutes } from "./routes/tours.js";
 *   registerTourRoutes(app, getPoolLazy);
 *
 * The client is vendored at ../tours/timetravel.ts rather than installed: it
 * has no dependencies, and there is no published package yet. When there is,
 * delete the file and import "@timetravel/client" instead.
 */
import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { createClient, TimeTravelError, type TimeTravelClient } from "../tours/timetravel.js";
import { upsertUser } from "../repos/users.js";
import { entitlementsFor } from "../entitlements.js";

/** What the app needs to open a walk. Deliberately small. */
export interface ResolvedTour {
  tourId: string;
  title: string;
  companion: string;
  stopCount: number;
  durationMin: number;
  /** Ready for a WebView. Built here, so it carries no key. */
  playerUrl: string;
}

export function registerTourRoutes(
  app: FastifyInstance,
  poolOrGetter: pg.Pool | (() => pg.Pool),
  /** Injected by tests, the same way buildApp takes a pool, geo and analytics. */
  client?: TimeTravelClient,
): void {
  const getPool = typeof poolOrGetter === "function" ? poolOrGetter : () => poolOrGetter;

  const tours =
    client ??
    createClient({
      baseUrl: process.env.TOURS_API_URL ?? "https://tours.worldasitwas.com",
      apiKey: process.env.TOURS_PLATFORM_KEY ?? "",
      playerUrl: process.env.TOURS_PLAYER_URL ?? process.env.TOURS_API_URL ?? "https://tours.worldasitwas.com",
      // Signs the short-lived token the player presents instead of a key.
      playerSecret: process.env.TOURS_PLAYER_SECRET ?? "",
    });

  app.get<{ Params: { id: string; year: string } }>(
    "/places/:id/eras/:year/tour",
    { preHandler: app.requireAuth },
    async (req, reply): Promise<ResolvedTour | undefined> => {
      const year = Number(req.params.year);
      if (!Number.isInteger(year)) return reply.code(400).send({ error: "bad_year" });

      const sub = (req.user as { sub: string }).sub;
      const user = await upsertUser(getPool(), sub);

      // Entitlement is ours to decide, not the tour service's: it knows what
      // exists, we know who may open it. During the free launch period every
      // signed-in user holds a launch grant, so this is a formality that
      // becomes load-bearing the day the paywall lands.
      const held = await entitlementsFor(getPool(), user.id);
      const era = await eraFor(getPool(), req.params.id, year);
      if (!era) return reply.code(404).send({ error: "era_not_found" });
      if (era.status !== "ready") return reply.code(404).send({ error: "tour_not_found" });
      if (!era.free && !covers(held, req.params.id, year)) return reply.code(402).send({ error: "payment_required" });

      let found;
      try {
        found = await tours.resolve({ city: req.params.id, year });
      } catch (err) {
        // A tour service that is down must read as "not right now", never as a
        // 500 from our own API — the app has a screen for one and not the other.
        req.log.error({ err }, "tour lookup failed");
        const code = err instanceof TimeTravelError ? err.code : "unknown";
        return reply.code(503).send({ error: "tours_unavailable", code });
      }
      if (!found) return reply.code(404).send({ error: "tour_not_found" });

      return {
        tourId: found.id,
        title: found.title,
        companion: found.companion.name,
        stopCount: found.stopCount,
        durationMin: found.durationMin,
        // Our own opaque user id, never the Auth0 sub and never an email: it
        // leaves our system, and all the tour service needs it for is counting
        // companion sessions per traveller.
        playerUrl: await tours.signedPlayerUrl(found.id, { travellerId: String(user.id) }),
      };
    },
  );
}

/** "all", or "london:1850" for a single purchase. */
function covers(held: { scope: string }[], placeId: string, year: number): boolean {
  return held.some((e) => e.scope === "all" || e.scope === `${placeId}:${year}`);
}

async function eraFor(pool: pg.Pool, placeId: string, year: number) {
  const { rows } = await pool.query<{ status: string; free: boolean }>(
    "select status, free from eras where place_id = $1 and year = $2",
    [placeId, year],
  );
  return rows[0];
}
