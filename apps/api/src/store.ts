/**
 * Reads published tours from CONTENT_DIR/tours/<tourId>/manifest.json.
 *
 * Manifests are immutable per version, so we cache them in memory and only
 * re-read a file when its mtime changes. That keeps the API fast without a
 * database, which is all a batch-published catalogue needs.
 */
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
};

export class TourStore {
  private cache = new Map<string, StoredTour>();

  constructor(private toursDir: string) {}

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
      tour = parseTour(JSON.parse(raw));
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
    const stored: StoredTour = { tour, etag: `"${tour.id}:${tour.version}"`, mtimeMs: stat.mtimeMs, dir, companionNotes };
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
