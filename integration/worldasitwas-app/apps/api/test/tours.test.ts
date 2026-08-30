/**
 * The tour boundary.
 *
 * What is being pinned here is not the tour service's behaviour — that is
 * tested in its own repo — but the four decisions this route makes on our side
 * of the line: whether the era may be walked, whether this traveller has paid
 * for it, what an outage looks like to the app, and that no credential leaves
 * the building in the URL we hand back.
 *
 * The tour client is injected, the same way buildApp already takes a pool, a
 * geo db and an analytics client, so none of this needs a network.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import type pg from "pg";
import { resetTestDb } from "./helpers/db.js";
import { seedLondon } from "./helpers/seed.js";
import { createAuthHelper, type AuthHelper } from "./helpers/auth.js";
import { registerAuth } from "../src/auth.js";
import { registerTourRoutes } from "../src/routes/tours.js";
import { TimeTravelError, type TimeTravelClient, type TourSummary } from "../src/tours/timetravel.js";

const WALK: TourSummary = {
  id: "tour_london_1850_flower_seller",
  version: "v2026-08-29.27801",
  title: "A Walk with a Flower Seller",
  summary: "Six stops from Ludgate Hill down to the river.",
  city: "london",
  year: 1850,
  yearRange: [1840, 1860],
  lang: "en",
  durationMin: 14,
  stopCount: 6,
  companion: { name: "Nell Baker", role: "flower seller", portrait: "/media/nell.jpg" },
  cover: { image: "/media/cover.jpg" },
  start: { lat: 51.5138, lng: -0.1029 },
  distanceYears: 0,
};

function stubClient(over: Partial<TimeTravelClient> = {}): TimeTravelClient {
  return {
    catalog: vi.fn(),
    find: vi.fn(),
    resolve: vi.fn(async () => WALK),
    tour: vi.fn(),
    playerUrl: (id, opts) => `https://tours.worldasitwas.com/?tour=${id}&play=1&traveller=${opts?.travellerId ?? ""}`,
    companionSession: vi.fn(),
    ...over,
  } as TimeTravelClient;
}

let pool: pg.Pool;
let auth: AuthHelper;

async function appWith(client: TimeTravelClient): Promise<FastifyInstance> {
  const app = Fastify();
  registerAuth(app, { issuer: auth.issuer, audience: auth.audience });
  registerTourRoutes(app, pool, client);
  await app.ready();
  return app;
}

const asUser = async (sub: string) => ({ authorization: `Bearer ${await auth.token(sub)}` });

beforeAll(async () => {
  pool = await resetTestDb();
  await seedLondon(pool);
  auth = await createAuthHelper();
});
afterAll(async () => {
  await auth.close();
  await pool.end();
});

describe("GET /places/:id/eras/:year/tour", () => {
  it("hands back a walk, and a player URL carrying no credential", async () => {
    const app = await appWith(stubClient());
    const res = await app.inject({ method: "GET", url: "/places/london/eras/1850/tour", headers: await asUser("auth0|traveller") });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ tourId: WALK.id, title: WALK.title, companion: "Nell Baker", stopCount: 6 });

    // The whole reason this route exists: the key stays on this side.
    expect(body.playerUrl).not.toContain(process.env.TOURS_PLATFORM_KEY ?? "TOURS_PLATFORM_KEY");
    expect(body.playerUrl).not.toMatch(/key|secret|bearer/i);
    // And the traveller id is our own opaque user id, never the Auth0 subject.
    expect(body.playerUrl).not.toContain("auth0|");
    expect(body.playerUrl).toMatch(/traveller=\d+$/);

    await app.close();
  });

  it("refuses a caller with no token", async () => {
    const app = await appWith(stubClient());
    const res = await app.inject({ method: "GET", url: "/places/london/eras/1850/tour" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("404s an era we hold but have not reconstructed", async () => {
    // London 1940 is seeded as `archive`: a promise, not a walk.
    const resolve = vi.fn(async () => WALK);
    const app = await appWith(stubClient({ resolve }));
    const res = await app.inject({ method: "GET", url: "/places/london/eras/1940/tour", headers: await asUser("auth0|traveller") });

    expect(res.statusCode).toBe(404);
    // And it never asked the tour service: our own status settles it.
    expect(resolve).not.toHaveBeenCalled();
    await app.close();
  });

  it("404s a year we do not have at all", async () => {
    const app = await appWith(stubClient());
    const res = await app.inject({ method: "GET", url: "/places/london/eras/1523/tour", headers: await asUser("auth0|traveller") });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("404s when the era is ready here but the tour service has nothing", async () => {
    const app = await appWith(stubClient({ resolve: vi.fn(async () => null) }));
    const res = await app.inject({ method: "GET", url: "/places/london/eras/1850/tour", headers: await asUser("auth0|traveller") });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("tour_not_found");
    await app.close();
  });

  it("reads a tour-service outage as 503, not as our own 500", async () => {
    // The app has a screen for "not right now" and none for a crash. A 500
    // here would also make our uptime look like their downtime.
    const app = await appWith(stubClient({ resolve: vi.fn(async () => { throw new TimeTravelError("network", "getaddrinfo ENOTFOUND"); }) }));
    const res = await app.inject({ method: "GET", url: "/places/london/eras/1850/tour", headers: await asUser("auth0|traveller") });

    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ error: "tours_unavailable", code: "network" });
    await app.close();
  });

  it("rejects a year that is not a number before touching the database", async () => {
    const app = await appWith(stubClient());
    const res = await app.inject({ method: "GET", url: "/places/london/eras/soon/tour", headers: await asUser("auth0|traveller") });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});
