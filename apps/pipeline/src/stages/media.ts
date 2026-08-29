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

export type MediaStep = "hero" | "video" | "line" | "ambience" | "portrait" | "cards" | "narration" | "transition";
export const ALL_STEPS: MediaStep[] = ["hero", "video", "line", "ambience", "portrait", "cards", "narration", "transition"];

export interface CardMedia {
  id: string;
  image?: Asset;
  then?: Asset;
  narration?: Asset;
  animated?: Asset;
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

export function styled(recipe: Recipe, prompt: string): string {
  return `${prompt.trim()} ${recipe.style.look} Avoid: ${recipe.style.avoid}`.trim();
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

export async function makeCharacter(recipe: Recipe, companion: CompanionDossier, provider: MediaProvider, quality: Quality, opts: { greeting?: boolean } = {}): Promise<CharacterSheet> {
  const prompt = `Photographic portrait, ${companion.portraitPrompt} ${recipe.style.look} Square framing, head and shoulders, looking at the camera, plain background of a soot-darkened brick wall. Avoid: ${recipe.style.avoid}`;
  const portrait = await provider.image({ prompt, aspect: "1:1", quality, stage: "character", note: `portrait of ${recipe.companion.name}` });
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
  opts: { talkingPortrait: boolean; steps?: Set<MediaStep> },
): Promise<StopMedia> {
  const d = DURATIONS[quality];
  const stage = `media:${script.stopId}`;
  const voice = recipe.companion.narrationVoice;
  const want = (s: MediaStep) => !opts.steps || opts.steps.has(s);

  // Arrival: hero still, then animate it, then her line, then the talking portrait.
  const hero = want("hero") ? await provider.image({ prompt: styled(recipe, script.heroImagePrompt), aspect: "9:16", quality, stage, note: "hero still" }) : undefined;
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
        prompt: "A woman speaks warmly and directly to the viewer, small natural head movements, street background.",
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
        if (card.kind === "image") {
          const prompt = styled(recipe, card.imagePrompt);
          out.image = card.includesCompanion
            ? await provider.imageWithRefs({ prompt: `${prompt} The flower seller in this scene must be the woman in the reference image, same face and dress.`, refs: [character.portraitUrl], aspect: "9:16", quality, stage, note: `image ${card.id}` })
            : await provider.image({ prompt, aspect: "9:16", quality, stage, note: `image ${card.id}` });
        } else if (card.kind === "thenNow") {
          if (archive?.nowPhoto) {
            const prompt = `Re-imagine this exact viewpoint as it looked in ${recipe.year}. Keep the camera position, the street width, the horizon line and the outline of any building that already stood in ${recipe.year} exactly where they are. Replace everything modern with what stood there in ${recipe.year}: ${card.imagePrompt} ${recipe.style.look} Portrait 9:16 crop. Avoid: ${recipe.style.avoid}`;
            out.then = await provider.editImage({ prompt, source: archive.nowPhoto.thumbUrl, aspect: "9:16", quality, stage, note: `then ${card.id}` });
          } else {
            out.image = await provider.image({ prompt: styled(recipe, card.imagePrompt), aspect: "9:16", quality, stage, note: `image (no now photo) ${card.id}` });
          }
        } else if (card.kind === "archive" && archive?.archive && want("video")) {
          out.animated = await provider
            .video({
              prompt: "Bring this historical picture gently to life: the people shift their weight and turn their heads, horses step, smoke drifts, cloth moves in the wind. Keep the composition, palette and drawing style exactly as they are. Subtle, slow, documentary.",
              imageUrl: archive.archive.thumbUrl,
              durationSec: d.archive,
              quality,
              audio: true,
              stage,
              note: `animated archive ${card.id}`,
            })
            .catch(warn(`animated archive ${card.id}`));
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
