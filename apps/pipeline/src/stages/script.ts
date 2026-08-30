import type { Recipe, RecipeStop } from "@timetravel/schema";
import type { Llm } from "../llm.ts";
import { STOP_SCRIPT_SCHEMA, StopScript, type CompanionDossier, type StopDossier } from "../shapes.ts";

const WRITER = `You write immersive, spoken-word history for a vertical phone experience: a companion from the period walks a visitor through a real place, one stop at a time. You write her lines the way she would actually talk, with the vocabulary, rhythm and concerns of her time, never a lecture. Every card is one picture and one or two sentences on screen, plus what she says. You must only state facts that appear in the dossier, and every factual claim you make on a card is listed in its claims with the dossier's sourceTitle. Sensory detail first, then the fact. No modern idiom, no anachronisms, no real named people speaking.`;

export async function scriptStop(
  recipe: Recipe,
  stop: RecipeStop,
  dossier: StopDossier,
  companion: CompanionDossier,
  llm: Llm,
  opts: { hasNowPhoto: boolean; hasArchive: boolean; stopIndex: number; stopCount: number },
): Promise<StopScript> {
  const facts = dossier.facts.map((f, i) => `${i + 1}. ${f.text} [${f.confidence}] (source: ${f.sourceTitle})`).join("\n");
  const prices = dossier.prices.map((p) => `- ${p.item}: ${p.price}${p.note ? " (" + p.note + ")" : ""} (source: ${p.sourceTitle})`).join("\n");
  const cardPlan = [
    `Card 1: kind "image". The wide scene: who is in the street and what is happening. She narrates.`,
    opts.hasNowPhoto
      ? `Card 2: kind "thenNow". Same viewpoint, ${recipe.year} against today. imagePrompt describes the ${recipe.year} view from exactly this camera position. The caption points at one thing that changed.`
      : `Card 2: kind "image". A close detail: a shop, a cart, a face, a price chalked on a board.`,
    opts.hasArchive
      ? `Card 3: kind "archive". A real period picture will be shown; write the caption in her voice reacting to it, and narration. No imagePrompt.`
      : `Card 3: kind "text". A short price list or a quote from a source, in textBody, under 40 words.`,
    `Card 4: kind "image" or "text": the human moment, what she thinks or hopes, tied to the mustCover items not yet covered.`,
    // Short beats need more screens, or the visitor stares at one picture for a
    // minute. These three are closer looks at things she actually names.
    `Card 5: kind "image". A closer look at one thing in this place she can point at: a face, a load, a sign, a tool, a doorway. Not the wide view again.`,
    `Card 6: kind "image". A second closer look, at something different in kind from card 5: if that was a person, make this an object or a surface.`,
    `Card 7: kind "image". The detail a visitor would miss: what is underfoot, what is written up, what is worn out, what is being carried past.`,
  ].join("\n");
  const user = `Tour: ${recipe.title} (${recipe.cityName}, ${recipe.year}). Theme: ${recipe.theme}
Companion: ${recipe.companion.name}, ${recipe.companion.role}.
How she speaks: ${companion.speechNotes}
Sample phrases: ${companion.samplePhrases.join(" | ")}

This is stop ${opts.stopIndex + 1} of ${opts.stopCount}: ${stop.title} (id ${stop.id}). Must cover: ${stop.mustCover.join("; ")}.

DOSSIER
Setting: ${dossier.setting}
Sight: ${dossier.senses.sight}
Sound: ${dossier.senses.sound}
Smell: ${dossier.senses.smell}
Facts:
${facts}
Prices:
${prices}
People: ${dossier.people.map((p) => `${p.who} ${p.doing}`).join("; ")}
Events: ${dossier.events.map((e) => `${e.what} (${e.when})`).join("; ")}
Never show or mention: ${dossier.anachronismsToAvoid.join("; ")}

VISUAL DIRECTION for every imagePrompt and the heroImagePrompt: ${recipe.style.look} Avoid: ${recipe.style.avoid}. Describe the scene, the people, the light and the camera position from the pavement. Do not mention the companion unless includesCompanion is true; if she appears, describe her as "the flower seller" with her basket, not by name.

WRITE
- arrivalLine: her first words on arriving here. ${opts.stopIndex === 0 ? "This is the first stop: she has just met the visitor; use or adapt this greeting: " + companion.greeting : "The visitor has just walked here with her."}
- heroImagePrompt and heroMotionPrompt for the arrival scene.
- ambiencePrompt: the continuous sound here.
- cards, exactly seven, following this plan:
${cardPlan}
Card ids must be "${stop.id}_c1" to "${stop.id}_c4".
- transitionLine: ${opts.stopIndex === opts.stopCount - 1 ? "her goodbye, under 30 words." : "what she says as you walk to the next stop, under 25 words."}
Set stopId to "${stop.id}".`;
  return llm.structured({
    name: "stop_script",
    jsonSchema: STOP_SCRIPT_SCHEMA as unknown as Record<string, unknown>,
    zod: StopScript,
    system: WRITER,
    user,
    webSearch: false,
    effort: "medium",
    stage: "script",
    note: `script ${stop.id}`,
  });
}
