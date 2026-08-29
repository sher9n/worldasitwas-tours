/**
 * Picks real pictures for a stop from Wikimedia Commons: one present-day
 * photograph (the "now" half of a then/now card) and one period item (an
 * archive card). Candidates are filtered to reusable licences, then a cheap
 * text call chooses among them by title, description and date.
 */
import type { Recipe, RecipeStop } from "@timetravel/schema";
import { searchCommons, type CommonsCandidate } from "../commons.ts";
import type { Ledger } from "../ledger.ts";
import type { Llm } from "../llm.ts";
import { ARCHIVE_PICK_SCHEMA, ArchivePick, type StopDossier } from "../shapes.ts";

export interface StopArchive {
  stopId: string;
  nowPhoto?: CommonsCandidate;
  archive?: CommonsCandidate & { caption: string };
}

function describe(c: CommonsCandidate, i: number): string {
  return `${i}. "${c.title}" | date: ${c.dateOriginal || "unknown"} | ${c.width}x${c.height} ${c.mime} | licence: ${c.license} | by: ${c.artist || "unknown"} | ${c.description || ""}`;
}

export async function pickArchive(recipe: Recipe, stop: RecipeStop, dossier: StopDossier, llm: Llm, ledger: Ledger): Promise<StopArchive> {
  const seen = new Set<string>();
  const candidates: CommonsCandidate[] = [];
  const queries = [dossier.nowPhotoQuery, ...stop.archiveQueries, `${stop.title} ${recipe.cityName}`];
  for (const q of queries) {
    try {
      for (const c of await searchCommons(q, ledger, 10)) {
        if (seen.has(c.fileUrl)) continue;
        seen.add(c.fileUrl);
        candidates.push(c);
      }
    } catch (err) {
      console.warn(`[archive] commons search failed for "${q}": ${(err as Error).message}`);
    }
    if (candidates.length >= 30) break;
  }
  if (candidates.length === 0) return { stopId: stop.id };

  const pick = await llm.structured({
    name: "archive_pick",
    jsonSchema: ARCHIVE_PICK_SCHEMA as unknown as Record<string, unknown>,
    zod: ArchivePick,
    system:
      "You are a picture researcher. From candidate files you choose (a) the best present-day photograph of a viewpoint and (b) the best period item showing the same place in or near a target year. Judge from titles, descriptions, dates and dimensions. Be strict: a photograph is present-day only if clearly modern (colour, recent date). A period item must depict the place itself, not a map or a portrait, and date from within roughly 30 years of the target. Return -1 when nothing fits.",
    user: `Place: ${stop.title}, ${recipe.cityName}. Target year: ${recipe.year}. The visitor stands at ${stop.geo.lat}, ${stop.geo.lng}${stop.geo.bearing !== undefined ? ` facing bearing ${stop.geo.bearing}` : ""}.
Setting: ${dossier.setting.slice(0, 600)}

Candidates:
${candidates.map(describe).join("\n")}

Write archiveCaption as ${recipe.companion.name}, ${recipe.companion.role}, reacting to the chosen period picture in one or two spoken sentences in her voice (empty if archiveIndex is -1).`,
    webSearch: false,
    effort: "low",
    stage: "archive",
    note: `pick ${stop.id}`,
  });

  const nowPhoto = pick.nowPhotoIndex >= 0 ? candidates[pick.nowPhotoIndex] : undefined;
  const arch = pick.archiveIndex >= 0 ? candidates[pick.archiveIndex] : undefined;
  return {
    stopId: stop.id,
    nowPhoto,
    archive: arch ? { ...arch, caption: pick.archiveCaption } : undefined,
  };
}
