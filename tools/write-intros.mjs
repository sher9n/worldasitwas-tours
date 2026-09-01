/**
 * Give every published walk a guide-card intro, and take the footnotes out of
 * the bio it was cut from.
 *
 * The research stage returns a dossier: prose with markdown citations, bare
 * URLs and source names attached. That is correct for research and wrong in
 * both places the text is actually used. The card showed it to travellers, a
 * wall of researchgate.net links; the prompt handed the guide her own
 * footnotes, which is part of why she answered like a literature review.
 *
 * This backfills what the pipeline now writes on its own: a short intro (three
 * sentences, under 400 characters) and a bio with the citations stripped. It is
 * safe to re-run: a walk that already has an intro is left alone unless --force.
 *
 *   set -a && source .env && set +a && npx tsx tools/write-intros.mjs [--force] [tour_id...]
 */
import { readFile, writeFile } from "node:fs/promises";
import { readdir } from "node:fs/promises";
import path from "node:path";
import OpenAI from "openai";
import { stripCitations } from "@timetravel/schema";

const ROOT = path.join(import.meta.dirname, "..");
const TOURS = path.join(ROOT, "content", "tours");
const MODEL = process.env.RESEARCH_MODEL || "gpt-5.4";
const force = process.argv.includes("--force");
const only = process.argv.slice(2).filter((a) => a.startsWith("tour_"));

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/** Three sentences a traveller reads before they start walking. */
async function writeIntro(tour) {
  const c = tour.companion;
  const res = await client.responses.create({
    model: MODEL,
    input: [
      {
        role: "system",
        content:
          "You write the short introduction shown on a guide's card in a history walking app, just before someone starts the walk. " +
          "Three sentences at most and under 380 characters in total. Present tense, warm, plain modern English, written ABOUT the guide in the third person. " +
          "Sentence one: who she or he is and where. Sentence two: what this particular walk shows you. Sentence three (optional): one concrete, human detail from the research that makes the person real. " +
          "No citations, no URLs, no source names, no lists, no quotation marks around the whole thing, no markdown.",
      },
      {
        role: "user",
        content: `Guide: ${c.name}, ${c.role}
City and year: ${tour.city}, ${tour.year}
Walk title: ${tour.title}
Walk summary: ${tour.summary}

Research on the guide (for facts only, do not copy its register or its citations):
${stripCitations(c.bio).slice(0, 6000)}`,
      },
    ],
  });
  return stripCitations(res.output_text || "").replace(/\s+/g, " ").trim();
}

const ids = only.length ? only : (await readdir(TOURS)).filter((d) => d.startsWith("tour_"));
for (const id of ids) {
  const file = path.join(TOURS, id, "manifest.json");
  let tour;
  try {
    tour = JSON.parse(await readFile(file, "utf8"));
  } catch {
    continue;
  }
  const cleanedBio = stripCitations(tour.companion.bio);
  const needsIntro = force || !tour.companion.intro;
  const intro = needsIntro ? await writeIntro(tour) : tour.companion.intro;
  if (intro.length > 420) {
    console.log(`${id}: intro came back at ${intro.length} chars, too long; leaving it out`);
    continue;
  }
  const before = tour.companion.bio.length;
  tour.companion = { ...tour.companion, intro, bio: cleanedBio };
  await writeFile(file, `${JSON.stringify(tour, null, 2)}\n`);
  console.log(`${id}\n  bio ${before} -> ${cleanedBio.length} chars\n  intro (${intro.length}): ${intro}\n`);
}
