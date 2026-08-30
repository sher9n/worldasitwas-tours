/**
 * The guide's presence loop: the clip that plays in her circle throughout a
 * walk.
 *
 * Two things decide whether she reads as a person or as a picture.
 *
 * The first is length. A ten second loop comes round often enough that a
 * traveller learns it, and once you can predict a movement it stops being
 * alive. Thirty to forty seconds is long enough that the repeat is not
 * noticed. No video model will give that in one call, so the performance is
 * built in segments, each generated FROM the last frame of the one before, so
 * she carries on rather than starting again.
 *
 * The second is that nothing in the prompt asks her to hold still. Pinning the
 * last frame to the first is the obvious way to make a clip loop, and it is
 * why an earlier version of this barely moved: told to end exactly where she
 * began, the model does as little as possible in between. The loop is closed
 * afterwards instead, in ffmpeg, by dissolving the end back into the start
 * (see loopJoin), which leaves the performance alone.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { joinClips, lastFrame, loopJoin } from "../ffmpeg.ts";
import type { MediaProvider } from "../providers/types.ts";
import type { Quality } from "../env.ts";

/** Where a guide stands and what their hands do when they are not busy. */
export interface PresenceSetting {
  /** Where they are, and what is behind them. "at her stall in Campo de' Fiori, …" */
  standing: string;
  /** Their own idle gesture, in their own world. "wipes her hands on her apron" */
  gesture: string;
}

/** How long one generated segment runs. The most any current model will give in one call. */
const SEGMENT_SEC = 10;
/** Four of them, so the finished loop is comfortably past half a minute. */
const SEGMENTS = 4;
/** The dissolve that closes the loop. Long enough to hide a change of pose. */
const DISSOLVE_SEC = 1;

/**
 * The performance, as beats.
 *
 * Restlessness is what makes her look alive: her attention goes somewhere
 * else and comes back. A guide who only ever stares out of the frame looks
 * like she is waiting to be used. Each beat ends facing the traveller so the
 * segments join cleanly, and the last returns her to her opening stance so
 * the dissolve at the loop has little to hide.
 */
function beats(name: string, s: PresenceSetting): string[] {
  return [
    `${name} stands ${s.standing}. They shift their weight from one foot to the other and glance away to the side at something happening out of shot, watching it for a moment with mild interest, then turn back to the camera and settle.`,
    `${name} looks down at their hands, ${s.gesture}, then lifts their head, breathes out, rolls their shoulders once and looks back at the camera with a small private smile.`,
    `${name} follows someone passing with their eyes, turning their head to watch them go, then looks back at the camera, tilts their head slightly and raises their eyebrows a little, as if still listening.`,
    `${name} ${s.gesture}, takes a breath, and settles back into the stance they began in: squarely facing the camera, hands where they were at the start, calm and watching.`,
  ];
}

/**
 * True of every segment. The camera never moves, because the circle is a
 * window onto her and a drifting window reads as a mistake. Her mouth stays
 * closed because the voice in a walk is a recording: a mouth moving out of
 * step with it is worse than a mouth at rest.
 */
const CONSTANTS =
  "The camera is fixed on a tripod: it does not pan, zoom or drift, and the framing never changes. " +
  "They stay within the frame throughout. Their mouth stays closed and relaxed; they are not speaking. " +
  "Behind them the world carries on gently and always forwards: people passing at a distance, cloth or smoke stirring.";

/**
 * Builds the loop and writes it to `out`.
 *
 * Segments are generated one after another because each needs the picture the
 * previous one ended on. Everything the provider returns is cached against its
 * exact request, so a re-run costs nothing.
 */
export async function buildPresenceLoop(opts: {
  name: string;
  setting: PresenceSetting;
  portraitUrl: string;
  provider: MediaProvider;
  quality: Quality;
  workDir: string;
  out: string;
  segments?: number;
}): Promise<{ segments: number; seconds: number }> {
  const count = opts.segments ?? SEGMENTS;
  const script = beats(opts.name, opts.setting);
  await fs.mkdir(opts.workDir, { recursive: true });

  const clips: string[] = [];
  let from = opts.portraitUrl;

  for (let i = 0; i < count; i++) {
    const clip = await opts.provider.video({
      prompt: `${script[i % script.length]} ${CONSTANTS}`,
      imageUrl: from,
      durationSec: SEGMENT_SEC,
      quality: opts.quality,
      audio: false,
      stage: "reel",
      note: `presence ${i + 1}/${count}`,
    });
    if (!clip.localPath) throw new Error(`presence segment ${i + 1} came back without a file`);
    clips.push(clip.localPath);

    if (i < count - 1) {
      // The next segment starts from the picture this one ended on, which is
      // what makes the join a continuation rather than a cut.
      const seed = path.join(opts.workDir, `seed-${i + 1}.jpg`);
      await lastFrame(clip.localPath, seed);
      from = await opts.provider.publish(seed, "image/jpeg");
    }
  }

  const joined = path.join(opts.workDir, "joined.mp4");
  await joinClips(clips, joined, 720);
  await loopJoin(joined, opts.out, DISSOLVE_SEC);
  const seconds = count * SEGMENT_SEC - DISSOLVE_SEC;
  return { segments: count, seconds };
}
