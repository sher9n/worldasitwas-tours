/**
 * Turns the script into media through the provider. Every asset is returned
 * with its remote or local location; assemble() later copies everything into
 * the tour folder and rewrites URLs.
 *
 * `steps` limits which kinds of asset are produced so a tour can be built and
 * inspected one piece at a time (hero still first, then the living scene, and
 * so on). With the asset cache in front of the provider, widening the steps on
 * a later run only pays for what is new.
 */
import type { Recipe } from "@timetravel/schema";
import type { Quality } from "../env.ts";
import type { Asset, MediaProvider } from "../providers/types.ts";
import type { CompanionDossier, StopScript } from "../shapes.ts";
import type { StopArchive } from "./archive.ts";
import { landmarkClause, type LandmarkRef } from "./landmarks.ts";
import { trimBorder } from "../ffmpeg.ts";

export type MediaStep = "hero" | "video" | "line" | "ambience" | "portrait" | "cards" | "cardmotion" | "narration" | "faces" | "transition";
/** Every step that exists, including the ones a tour no longer uses. */
export const KNOWN_STEPS: MediaStep[] = ["hero", "video", "line", "ambience", "portrait", "cards", "cardmotion", "narration", "faces", "transition"];
/** Neither card motion nor the arrival clip is part of a tour any more: every
 * screen is a still that drifts. Both steps survive for a deliberate opt-in via
 * --steps, and neither costs anything unless asked for. */
export const ALL_STEPS: MediaStep[] = ["hero", "line", "ambience", "portrait", "cards", "narration", "faces", "transition"];

export interface CardMedia {
  id: string;
  image?: Asset;
  then?: Asset;
  narration?: Asset;
  animated?: Asset;
  motion?: Asset;
}

export interface StopMedia {
  stopId: string;
  hero?: Asset;
  livingScene?: Asset;
  arrivalAudio?: Asset;
  talkingPortrait?: Asset;
  ambience?: Asset;
  cards: CardMedia[];
  transitionAudio?: Asset;
}

export interface CharacterSheet {
  portrait: Asset;
  portraitUrl: string;
  greetingAudio?: Asset;
}

const DURATIONS: Record<Quality, { hero: number; archive: number; sfx: number }> = {
  draft: { hero: 4, archive: 4, sfx: 12 },
  final: { hero: 8, archive: 5, sfx: 20 },
};

/**
 * A frame is one photograph. Said first, because said last it is ignored: a
 * scene describing a train doorway AND the shops beyond it came back as two
 * panels stacked in one picture, with the instruction against exactly that
 * sitting at the end of the avoid list where the model had stopped caring.
 */
const ONE_FRAME = "A single photograph of one continuous scene, shot in one exposure from one camera position. Not a split screen, not a diptych or triptych, not a collage, not a grid, no panels or borders inside the picture.";

export function styled(recipe: Recipe, prompt: string, stopNote = ""): string {
  return `${ONE_FRAME} ${prompt.trim()} ${recipe.style.look}${stopNote ? ` ${stopNote}` : ""} Avoid: ${recipe.style.avoid}`.trim();
}

async function urlOf(provider: MediaProvider, a: Asset): Promise<string> {
  if (a.remoteUrl) return a.remoteUrl;
  if (a.localPath) return provider.publish(a.localPath, a.mime);
  throw new Error("asset has no location");
}

const warn = (what: string) => (err: unknown) => {
  console.warn(`[media] ${what} failed: ${(err as Error).message}`);
  return undefined;
};

/** Motion for a card still: quiet documentary life, no camera moves, plays once. */
const CARD_MOTION_PROMPT =
  "Bring this scene quietly to life for a few seconds: people shift their weight and walk slowly, horses step and nod, fabric, smoke and steam drift, reflections shimmer on wet stone. The camera is locked off. No new people or objects appear; nothing leaves the frame. Subtle, slow, documentary.";

export async function makeCharacter(recipe: Recipe, companion: CompanionDossier, provider: MediaProvider, quality: Quality, opts: { greeting?: boolean } = {}): Promise<CharacterSheet> {
  const prompt = `Photographic portrait, ${companion.portraitPrompt} ${recipe.style.look} Square framing, head and shoulders, looking at the camera, plain background of a soot-darkened brick wall. Avoid: ${recipe.style.avoid}`;
  const portrait = await provider.image({ prompt, aspect: "1:1", quality, stage: "character", note: `portrait of ${recipe.companion.name}` });
  // The image model sometimes composes a tall photograph on a square canvas and
  // pads the sides with white. In a round frame that reads as a cut-out with
  // white bars beside her, and the presence clip made from it inherits them, so
  // the padding is cut off before anything else uses the picture.
  if (portrait.localPath && (await trimBorder(portrait.localPath))) {
    // The hosted copy is still the padded one, and it is what every later call
    // is given: the clip of her, and any scene she appears in. Dropping it makes
    // the trimmed picture the one that gets published and used.
    portrait.remoteUrl = undefined;
  }
  const portraitUrl = await urlOf(provider, portrait);
  let greetingAudio: Asset | undefined;
  if (opts.greeting !== false) {
    greetingAudio = await provider.tts({ text: companion.greeting, voice: recipe.companion.narrationVoice, stage: "character", note: "greeting" }).catch(warn("greeting tts"));
  }
  return { portrait, portraitUrl, greetingAudio };
}

export async function makeStopMedia(
  recipe: Recipe,
  script: StopScript,
  archive: StopArchive | undefined,
  character: CharacterSheet,
  provider: MediaProvider,
  quality: Quality,
  opts: { talkingPortrait: boolean; steps?: Set<MediaStep>; landmarks?: LandmarkRef[]; styleNote?: string },
): Promise<StopMedia> {
  const d = DURATIONS[quality];
  const stage = `media:${script.stopId}`;
  const voice = recipe.companion.narrationVoice;
  // No steps asked for means the steps a tour actually uses, which is not every
  // step that exists: moving pictures are opt-in and cost money.
  const want = (s: MediaStep) => (opts.steps ?? new Set(ALL_STEPS)).has(s);

  // Arrival: hero still, then animate it, then her line, then the talking portrait.
  // The skyline lives in the hero still, so this is where an invented building
  // does the most damage. When the stop names real landmarks, the model is
  // handed photographs of them rather than a description of them.
  const marks = opts.landmarks ?? [];
  const stopNote = opts.styleNote ?? "";
  const markClause = landmarkClause(marks, recipe.year);
  const heroPrompt = `${styled(recipe, script.heroImagePrompt, stopNote)}${markClause}`;
  const hero = want("hero")
    ? marks.length
      ? await provider.imageWithRefs({ prompt: heroPrompt, refs: marks.map((m) => m.refUrl), aspect: "9:16", quality, stage, note: "hero still" })
      : await provider.image({ prompt: heroPrompt, aspect: "9:16", quality, stage, note: "hero still" })
    : undefined;
  const heroUrl = hero ? await urlOf(provider, hero) : undefined;

  const [livingScene, arrivalAudio, ambience] = await Promise.all([
    want("video") && heroUrl
      ? provider.video({ prompt: script.heroMotionPrompt, imageUrl: heroUrl, durationSec: d.hero, quality, audio: true, stage, note: "living scene" }).catch(warn("living scene"))
      : Promise.resolve(undefined),
    want("line") ? provider.tts({ text: script.arrivalLine, voice, stage, note: "arrival line" }).catch(warn("arrival tts")) : Promise.resolve(undefined),
    want("ambience") ? provider.sfx({ text: script.ambiencePrompt, durationSec: d.sfx, loop: true, stage, note: "ambience" }).catch(warn("ambience")) : Promise.resolve(undefined),
  ]);

  let talkingPortrait: Asset | undefined;
  if (opts.talkingPortrait && want("portrait") && arrivalAudio) {
    try {
      const audioUrl = await urlOf(provider, arrivalAudio);
      talkingPortrait = await provider.talkingPortrait({
        imageUrl: character.portraitUrl,
        audioUrl,
        // Not "a woman": half the guides are men, and this line was describing
        // whoever it liked regardless of whose portrait it was handed.
        prompt: "The person in this portrait speaks warmly and directly to the viewer, with small natural head movements. The background behind them stays as it is.",
        quality,
        stage,
        note: "talking portrait",
      });
    } catch (err) {
      warn("talking portrait")(err);
    }
  }

  // Cards, in parallel within the stop.
  const cards = await Promise.all(
    script.cards.map(async (card): Promise<CardMedia> => {
      const out: CardMedia = { id: card.id };
      const narrationP =
        want("narration") && card.narration.trim()
          ? provider.tts({ text: card.narration, voice, stage, note: `narration ${card.id}` }).catch(warn(`narration ${card.id}`))
          : Promise.resolve(undefined);
      if (want("cards")) {
        // A refused or failed picture must never sink the stop; assemble falls
        // back per card (thenNow without a then, archive without animation).
        try {
          const mirror = (u: string, m?: string) => (provider.mirrorUrl ? provider.mirrorUrl(u, m) : Promise.resolve(u));
          if (card.kind === "image") {
            const prompt = styled(recipe, card.imagePrompt, stopNote);
            // Not "the flower seller" and not "the woman": that was written for
            // one walk in 1850 London and then said of every guide since.
            const who = `The ${recipe.companion.role.toLowerCase()} in this scene must be the person in the reference photograph of ${recipe.companion.name}: same face, same clothes.`;
            const refs = [...(card.includesCompanion ? [character.portraitUrl] : []), ...marks.map((m) => m.refUrl)];
            out.image = refs.length
              ? await provider.imageWithRefs({
                  prompt: `${prompt}${card.includesCompanion ? ` ${who}` : ""}${markClause}`,
                  refs,
                  aspect: "9:16",
                  quality,
                  stage,
                  note: `image ${card.id}`,
                })
              : await provider.image({ prompt, aspect: "9:16", quality, stage, note: `image ${card.id}` });
          } else if (card.kind === "thenNow") {
            if (archive?.nowPhoto) {
              const source = await mirror(archive.nowPhoto.thumbUrl, archive.nowPhoto.mime);
              const prompt = `Depict this same scene in the year ${recipe.year}. ${card.imagePrompt} Keep the camera position, the street width, the horizon and every building that already stood in ${recipe.year} exactly where they are. ${recipe.style.look} Portrait 9:16 crop. Avoid: ${recipe.style.avoid}`;
              out.then = await provider.editImage({ prompt, source, aspect: "9:16", quality, stage, note: `then ${card.id}` });
            } else {
              out.image = await provider.image({ prompt: styled(recipe, card.imagePrompt), aspect: "9:16", quality, stage, note: `image (no now photo) ${card.id}` });
            }
          } else if (card.kind === "archive" && archive?.archive && want("video")) {
            const source = await mirror(archive.archive.thumbUrl, archive.archive.mime);
            out.animated = await provider
              .video({
                prompt: "Bring this historical picture gently to life: the people shift their weight and turn their heads, horses step, smoke drifts, cloth moves in the wind. Keep the composition, palette and drawing style exactly as they are. Subtle, slow, documentary.",
                imageUrl: source,
                durationSec: d.archive,
                quality,
                audio: true,
                stage,
                note: `animated archive ${card.id}`,
              })
              .catch(warn(`animated archive ${card.id}`));
          }
        } catch (err) {
          warn(`card ${card.id}`)(err);
        }
      }
      // One quiet clip of the still, played once in the player then resting.
      if (want("cardmotion")) {
        const still = out.image ?? out.then;
        if (still) {
          try {
            const stillUrl = await urlOf(provider, still);
            out.motion = await provider
              .video({ prompt: CARD_MOTION_PROMPT, imageUrl: stillUrl, durationSec: 5, quality, audio: false, stage, note: `motion ${card.id}` })
              .catch(warn(`motion ${card.id}`));
          } catch (err) {
            warn(`motion ${card.id}`)(err);
          }
        }
      }
      out.narration = await narrationP;
      return out;
    }),
  );

  const transitionAudio =
    want("transition") && script.transitionLine.trim()
      ? await provider.tts({ text: script.transitionLine, voice, stage, note: "transition line" }).catch(warn("transition tts"))
      : undefined;
  return { stopId: script.stopId, hero, livingScene, arrivalAudio, talkingPortrait, ambience, cards, transitionAudio };
}
