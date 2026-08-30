import type { Catalog, Tour, TourSummary } from "@timetravel/schema";

const KEY = import.meta.env.VITE_PLATFORM_KEY || "dev";
const headers = { Authorization: `Bearer ${KEY}` };

async function get<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body?.error?.message || `${res.status} ${url}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  catalog: () => get<Catalog>("/v1/catalog"),
  tours: (city: string, year: number) => get<{ matches: TourSummary[]; nearest: TourSummary[] }>(`/v1/tours?city=${encodeURIComponent(city)}&year=${year}`),
  /** Every published tour, for the gallery: one call per city, flattened. */
  allTours: async (cities: { id: string; years: number[] }[]) => {
    const seen = new Map<string, TourSummary>();
    for (const c of cities) {
      for (const y of c.years) {
        const r = await get<{ matches: TourSummary[]; nearest: TourSummary[] }>(`/v1/tours?city=${encodeURIComponent(c.id)}&year=${y}`);
        for (const t of [...r.matches, ...r.nearest]) if (!seen.has(t.id)) seen.set(t.id, t);
      }
    }
    return [...seen.values()].sort((a, b) => (a.city === b.city ? a.year - b.year : a.city.localeCompare(b.city)));
  },
  tour: (id: string) => get<Tour>(`/v1/tours/${encodeURIComponent(id)}`),
  ledger: (id: string) => get<{ totalUsd: number; byProvider: Record<string, number>; entries: unknown[] }>(`/dev/tours/${encodeURIComponent(id)}/ledger`),
  session: async (tourId: string, body: { travellerId: string; stopId?: string; cardId?: string; locale?: string }) => {
    const res = await fetch(`/v1/tours/${encodeURIComponent(tourId)}/companion/session`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      const err = new Error(j?.error?.message || `session ${res.status}`) as Error & { status?: number; retryAfterSec?: number };
      err.status = res.status;
      const ra = Number(res.headers.get("Retry-After"));
      if (Number.isFinite(ra) && ra > 0) err.retryAfterSec = ra;
      throw err;
    }
    return res.json() as Promise<{
      sessionId: string;
      expiresAt: string;
      realtime: { provider: string; model: string; voice: string; clientSecret: string; connectUrl: string };
      limits: { maxMinutes: number; maxTurns: number };
    }>;
  },
};

export function travellerId(): string {
  // A host embedding the player owns the identity: it knows the signed-in
  // traveller across devices, and the companion's rate limit counts per
  // traveller, so a WebView minting a fresh localStorage id on every install
  // would hand the same person a new budget each time.
  try {
    const fromHost = new URLSearchParams(location.search).get("traveller");
    if (fromHost) return fromHost;
  } catch {
    // no location (SSR, a worker); fall through to the local id
  }
  try {
    let id = localStorage.getItem("tt.travellerId");
    if (!id) {
      id = "t_" + Math.random().toString(36).slice(2, 12);
      localStorage.setItem("tt.travellerId", id);
    }
    return id;
  } catch {
    return "t_anon";
  }
}
