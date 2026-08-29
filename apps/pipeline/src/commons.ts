/**
 * Wikimedia Commons lookup for real pictures: present-day photographs for the
 * "now" half of then/now cards, and period engravings or photographs for
 * archive cards. No API key; Wikimedia asks for a descriptive User-Agent.
 */
import type { Ledger } from "./ledger.ts";

export interface CommonsCandidate {
  title: string;
  pageUrl: string;
  fileUrl: string;
  thumbUrl: string;
  width: number;
  height: number;
  mime: string;
  license: string;
  licenseUrl: string;
  artist: string;
  description: string;
  dateOriginal: string;
}

const UA = "TimeTravelTours/0.1 (tour engine prototype; https://github.com/timetravel-tours) node-fetch";

function stripHtml(s: string | undefined): string {
  return (s ?? "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

const REUSABLE = /public domain|cc0|cc by(?!-nc)|cc-by(?!-nc)|attribution(?!.*non)|no restrictions|pd-/i;

export function isReusable(license: string): boolean {
  return REUSABLE.test(license) && !/non-?commercial|nc\b|nd\b/i.test(license);
}

export async function searchCommons(query: string, ledger: Ledger, limit = 12): Promise<CommonsCandidate[]> {
  const params = new URLSearchParams({
    action: "query",
    generator: "search",
    gsrsearch: query,
    gsrnamespace: "6",
    gsrlimit: String(limit),
    prop: "imageinfo",
    iiprop: "url|extmetadata|size|mime",
    iiurlwidth: "1280",
    format: "json",
    origin: "*",
  });
  const t0 = Date.now();
  const res = await fetch(`https://commons.wikimedia.org/w/api.php?${params}`, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`commons search ${res.status}`);
  const json = (await res.json()) as {
    query?: { pages?: Record<string, { title: string; imageinfo?: Array<Record<string, unknown>> }> };
  };
  const pages = Object.values(json.query?.pages ?? {});
  const out: CommonsCandidate[] = [];
  for (const p of pages) {
    const ii = p.imageinfo?.[0];
    if (!ii) continue;
    const meta = (ii.extmetadata ?? {}) as Record<string, { value?: string }>;
    const mime = String(ii.mime ?? "");
    if (!/^image\/(jpeg|png|tiff|webp)$/.test(mime)) continue;
    out.push({
      title: p.title.replace(/^File:/, ""),
      pageUrl: String(ii.descriptionurl ?? ""),
      fileUrl: String(ii.url ?? ""),
      thumbUrl: String(ii.thumburl ?? ii.url ?? ""),
      width: Number(ii.width ?? 0),
      height: Number(ii.height ?? 0),
      mime,
      license: stripHtml(meta.LicenseShortName?.value) || stripHtml(meta.License?.value),
      licenseUrl: stripHtml(meta.LicenseUrl?.value),
      artist: stripHtml(meta.Artist?.value).slice(0, 120),
      description: stripHtml(meta.ImageDescription?.value).slice(0, 400),
      dateOriginal: stripHtml(meta.DateTimeOriginal?.value).slice(0, 60),
    });
  }
  await ledger.add({ stage: "archive", provider: "wikimedia", endpoint: "commons.search", note: query, units: out.length, unitType: "results", rateUsd: 0, estimated: false, ms: Date.now() - t0 });
  return out.filter((c) => isReusable(c.license));
}
