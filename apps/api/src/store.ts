/**
 * Reads published tours from CONTENT_DIR/tours/<tourId>/manifest.json.
 *
 * Manifests are immutable per version, so we cache them in memory and only
 * re-read a file when its mtime changes. That keeps the API fast without a
 * database, which is all a batch-published catalogue needs.
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { parseTour, summarize, type Catalog, type Tour, type TourSummary } from "@timetravel/schema";

export interface StoredTour {
  tour: Tour;
  etag: string;
  mtimeMs: number;
  dir: string;
  /** Optional companion dossier written by the pipeline; feeds the live persona. */
  companionNotes?: string;
}

const CITY_META: Record<string, { name: string; country: string; anchor: { lat: number; lng: number } }> = {
  london: { name: "London", country: "GB", anchor: { lat: 51.5139, lng: -0.1015 } },
  stockholm: { name: "Stockholm", country: "SE", anchor: { lat: 59.3251, lng: 18.0711 } },
  rome: { name: "Rome", country: "IT", anchor: { lat: 41.8986, lng: 12.4769 } },
  colombo: { name: "Colombo", country: "LK", anchor: { lat: 6.9337, lng: 79.8425 } },
};

/**
 * Media URLs are absolute in a manifest, and they are written at publish time
 * by whichever machine ran the pipeline — in practice `http://localhost:4100`.
 * A tour published on a laptop would therefore serve a deployed player a set
 * of links to that laptop.
 *
 * Rather than rewrite history or republish ten walks every time the media
 * moves, the store re-points them as it loads: anything ending up under
 * `/media/` is re-based onto whatever this deployment actually serves media
 * from. The content hash on the query string is part of the path and survives
 * untouched, so caching still works.
 *
 * The pipeline stays as it is, the files on disk stay as they are, and the
 * same tour is correct in dev, in staging and behind a CDN.
 */
const MEDIA_PATH = /^https?:\/\/[^/]+\/media\/(.+)$/;

function rebaseMedia<T>(node: T, mediaBaseUrl: string): T {
  if (typeof node === "string") {
    const m = MEDIA_PATH.exec(node);
    return (m ? `${mediaBaseUrl}/${m[1]}` : node) as unknown as T;
  }
  if (Array.isArray(node)) return node.map((v) => rebaseMedia(v, mediaBaseUrl)) as unknown as T;
  if (node && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) out[k] = rebaseMedia(v, mediaBaseUrl);
    return out as T;
  }
  return node;
}

export class TourStore {
  private cache = new Map<string, StoredTour>();

  /**
   * @param mediaBaseUrl where this deployment serves media from, no trailing
   *   slash. Locally that is the API's own /media mount; in production it is
   *   the bucket or CDN in front of it.
   */
  constructor(
    private toursDir: string,
    private mediaBaseUrl: string,
  ) {}

  async list(): Promise<StoredTour[]> {
    let entries: string[] = [];
    try {
      entries = await fs.readdir(this.toursDir);
    } catch {
      return [];
    }
    const out: StoredTour[] = [];
    for (const name of entries) {
      const stored = await this.load(name);
      if (stored) out.push(stored);
    }
    return out.sort((a, b) => a.tour.year - b.tour.year || a.tour.id.localeCompare(b.tour.id));
  }

  async get(tourId: string): Promise<StoredTour | undefined> {
    if (!/^tour_[a-z0-9_]+$/.test(tourId)) return undefined;
    return this.load(tourId);
  }

  private async load(tourId: string): Promise<StoredTour | undefined> {
    const dir = path.join(this.toursDir, tourId);
    const file = path.join(dir, "manifest.json");
    let stat;
    try {
      stat = await fs.stat(file);
    } catch {
      return undefined;
    }
    const cached = this.cache.get(tourId);
    if (cached && cached.mtimeMs === stat.mtimeMs) return cached;
    const raw = await fs.readFile(file, "utf8");
    let tour: Tour;
    try {
      tour = rebaseMedia(parseTour(JSON.parse(raw)), this.mediaBaseUrl);
    } catch (err) {
      // A broken manifest must not take the catalogue down; skip it loudly.
      console.error(`[store] skipping ${file}: ${(err as Error).message.split("\n")[0]}`);
      return undefined;
    }
    let companionNotes: string | undefined;
    try {
      companionNotes = await fs.readFile(path.join(dir, "companion.md"), "utf8");
    } catch {
      companionNotes = undefined;
    }
    // The media base is part of what is served, so it belongs in the ETag: moving
    // media to a CDN must invalidate a manifest a player already holds. Hashed,
    // not truncated — every candidate base starts "https://", so the first
    // characters of its encoding are identical and would tag them all the same.
    const baseTag = crypto.createHash("sha1").update(this.mediaBaseUrl).digest("base64url").slice(0, 8);
    const stored: StoredTour = { tour, etag: `"${tour.id}:${tour.version}:${baseTag}"`, mtimeMs: stat.mtimeMs, dir, companionNotes };
    this.cache.set(tourId, stored);
    return stored;
  }

  async catalog(): Promise<Catalog> {
    const tours = await this.list();
    const byCity = new Map<string, Tour[]>();
    for (const { tour } of tours) {
      const arr = byCity.get(tour.city) ?? [];
      arr.push(tour);
      byCity.set(tour.city, arr);
    }
    const cities = [...byCity.entries()].map(([id, list]) => {
      const meta = CITY_META[id] ?? { name: id, country: "", anchor: list[0].stops[0].geo };
      return {
        id,
        name: meta.name,
        country: meta.country,
        anchor: { lat: meta.anchor.lat, lng: meta.anchor.lng },
        years: [...new Set(list.map((t) => t.year))].sort((a, b) => a - b),
        tourCount: list.length,
      };
    });
    return { cities, updatedAt: new Date().toISOString() };
  }

  /** Tours for a city and year: exact range matches, else the nearest three. */
  async forCityYear(city: string, year: number, lang?: string): Promise<{ matches: TourSummary[]; nearest: TourSummary[] }> {
    const tours = (await this.list()).map((s) => s.tour).filter((t) => t.city === city && (!lang || t.lang === lang));
    const summaries = tours.map((t) => summarize(t, year));
    const matches = summaries.filter((s) => s.distanceYears === 0);
    const nearest = matches.length ? [] : summaries.sort((a, b) => a.distanceYears - b.distanceYears).slice(0, 3);
    return { matches, nearest };
  }
}
