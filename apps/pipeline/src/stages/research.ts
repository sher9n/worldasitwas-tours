import type { Recipe, RecipeStop } from "@timetravel/schema";
import type { Llm } from "../llm.ts";
import { COMPANION_DOSSIER_SCHEMA, CompanionDossier, STOP_DOSSIER_SCHEMA, StopDossier } from "../shapes.ts";

const RESEARCHER = `You are a meticulous social historian preparing a location dossier for an immersive history experience. You work from primary sources and reputable secondary sources, search the web to verify, and you separate what is known from what is likely and what is interpretation. Write for a scriptwriter: concrete, sensory, specific. Use the money, measures and vocabulary of the period. Every fact carries a source title and a URL you actually found. Give at least ten facts and at least six prices. Never invent a citation.`;

export async function researchStop(recipe: Recipe, stop: RecipeStop, llm: Llm): Promise<StopDossier> {
  const seeds = recipe.seedSources.map((s) => `- ${s.title} (${s.url})${s.note ? ": " + s.note : ""}`).join("\n");
  const user = `City: ${recipe.cityName}. Year: ${recipe.year} (acceptable range ${recipe.yearRange[0]} to ${recipe.yearRange[1]}).
Tour theme: ${recipe.theme}
Stop: ${stop.title} (id ${stop.id}) at ${stop.geo.lat}, ${stop.geo.lng}${stop.geo.bearing !== undefined ? `, facing bearing ${stop.geo.bearing}` : ""}.
What this stop is about: ${stop.brief}
The script must cover: ${stop.mustCover.join("; ") || "(open)"}.
Start from these sources and search for more:
${seeds}

Return the dossier for this stop. Set stopId to "${stop.id}". For nowPhotoQuery, give a Wikimedia Commons search phrase that would find a present-day photograph taken from roughly this viewpoint.`;
  return llm.structured({
    name: "stop_dossier",
    jsonSchema: STOP_DOSSIER_SCHEMA as unknown as Record<string, unknown>,
    zod: StopDossier,
    system: RESEARCHER,
    user,
    webSearch: true,
    effort: "medium",
    stage: "research",
    note: `dossier ${stop.id}`,
  });
}

export async function researchCompanion(recipe: Recipe, dossiers: StopDossier[], llm: Llm): Promise<CompanionDossier> {
  const facts = dossiers
    .flatMap((d) => d.facts.slice(0, 6).map((f) => `- (${d.stopId}) ${f.text}`))
    .join("\n");
  const prices = dossiers.flatMap((d) => d.prices.slice(0, 4).map((p) => `- ${p.item}: ${p.price}`)).join("\n");
  const user = `Build the companion character for a ${recipe.cityName} ${recipe.year} walking tour.
Name: ${recipe.companion.name}. Role: ${recipe.companion.role}.
Brief from the producer: ${recipe.companion.brief}

Facts already researched for the stops:
${facts}

Prices:
${prices}

Search the primary sources named in the brief for how such a person actually spoke (recorded interviews, court testimony, letters) and give speechNotes with real phrases. She must be fictional but built from records of people like her. knowledgeLimits must state plainly what she cannot know (anything after ${recipe.yearRange[1]}, places she has not been, literacy). The greeting is her first line to a visitor from the future who has just appeared beside her, under 30 words, in her voice. portraitPrompt describes her for a photographic portrait: age, face, dress, setting, light. No resemblance to a real person.`;
  return llm.structured({
    name: "companion_dossier",
    jsonSchema: COMPANION_DOSSIER_SCHEMA as unknown as Record<string, unknown>,
    zod: CompanionDossier,
    system: RESEARCHER,
    user,
    webSearch: true,
    effort: "medium",
    stage: "research",
    note: "companion dossier",
  });
}

export function companionMarkdown(recipe: Recipe, d: CompanionDossier, dossiers: StopDossier[]): string {
  const byStop = dossiers
    .map(
      (s) =>
        `### ${s.stopId}\n${s.setting}\n\nSight: ${s.senses.sight}\nSound: ${s.senses.sound}\nSmell: ${s.senses.smell}\n\nFacts:\n${s.facts
          .map((f) => `- ${f.text} [${f.confidence}; ${f.sourceTitle}]`)
          .join("\n")}\n\nPrices:\n${s.prices.map((p) => `- ${p.item}: ${p.price}${p.note ? " (" + p.note + ")" : ""}`).join("\n")}\n\nPeople here: ${s.people
          .map((p) => `${p.who} ${p.doing}`)
          .join("; ")}\n\nDo not mention (anachronisms): ${s.anachronismsToAvoid.join("; ")}`,
    )
    .join("\n\n");
  return `# ${recipe.companion.name}, ${recipe.companion.role}

## Who she is
${d.bio}

## How she speaks
${d.speechNotes}

Sample phrases: ${d.samplePhrases.map((p) => `"${p}"`).join(", ")}

## How she sees the world
${d.worldview}

## What she cannot know
${d.knowledgeLimits}

## What she knows about each stop
${byStop}
`;
}
