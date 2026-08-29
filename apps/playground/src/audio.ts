/**
 * Two persistent audio channels for the whole tour: her voice and the street.
 * Both elements are unlocked inside the Travel tap (the one guaranteed user
 * gesture), after which swapping src and calling play() keeps working on
 * desktop and phones. Every <video> in the player stays muted forever, so
 * autoplay policy can never freeze the picture again.
 */

// One second of silence; playing this inside the tap unlocks the element.
const SILENCE =
  "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAIlYAAESsAAACABAAZGF0YQAAAAA=";

function dbToGain(db: number): number {
  return Math.max(0, Math.min(1, Math.pow(10, db / 20)));
}

export class AudioEngine {
  private voice = new Audio();
  private ambience = new Audio();
  private bedGain = dbToGain(-14);
  private ducked = false;
  private fadeTimer: number | null = null;
  private voiceToken = 0;
  unlocked = false;

  constructor() {
    this.ambience.loop = true;
    this.voice.preload = "auto";
    // Attached (hidden) so devtools and tests can observe playback state.
    for (const [el, name] of [[this.voice, "voice"], [this.ambience, "ambience"]] as const) {
      el.dataset.channel = name;
      el.hidden = true;
      document.body.appendChild(el);
    }
  }

  /** Call synchronously inside a user gesture (the Travel tap). */
  unlock(): void {
    if (this.unlocked) return;
    this.unlocked = true;
    for (const el of [this.voice, this.ambience]) {
      el.src = SILENCE;
      el.play().then(() => el.pause()).catch(() => undefined);
    }
  }

  /**
   * Play one spoken line. Resolves with "ended" when she finishes, "failed"
   * when the file cannot load or play; the caller falls back to a timer.
   */
  playVoice(url: string): { done: Promise<"ended" | "failed">; stop: () => void } {
    const token = ++this.voiceToken;
    const el = this.voice;
    this.duck(true);
    const done = new Promise<"ended" | "failed">((resolve) => {
      const cleanup = (result: "ended" | "failed") => {
        el.onended = null;
        el.onerror = null;
        if (token === this.voiceToken) this.duck(false);
        resolve(result);
      };
      el.onended = () => cleanup("ended");
      el.onerror = () => cleanup("failed");
      el.src = url;
      el.play().catch(() => cleanup("failed"));
    });
    return {
      done,
      stop: () => {
        if (token !== this.voiceToken) return;
        el.pause();
        el.onended = null;
        el.onerror = null;
        this.duck(false);
      },
    };
  }

  pauseVoice(): void {
    if (!this.voice.paused) this.voice.pause();
  }

  /** Is her recorded voice audibly playing right now? */
  isVoicePlaying(): boolean {
    return !this.voice.paused && !this.voice.ended && this.voice.currentTime > 0;
  }

  /** Skip gracefully: her line fades over ~180ms instead of chopping. */
  fadeStopVoice(): void {
    const el = this.voice;
    if (el.paused) return;
    const token = ++this.voiceToken;
    el.onended = null;
    el.onerror = null;
    this.duck(false);
    const start = el.volume;
    const t0 = performance.now();
    const step = () => {
      if (token !== this.voiceToken) return;
      const k = Math.min(1, (performance.now() - t0) / 180);
      el.volume = start * (1 - k);
      if (k >= 1) {
        el.pause();
        el.volume = start;
      } else requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }
  resumeVoice(): void {
    if (this.voice.paused && this.voice.src && !this.voice.ended) this.voice.play().catch(() => undefined);
  }

  /** Swap the street bed. Same URL is left running untouched. */
  setAmbience(url: string | undefined, gainDb: number): void {
    this.bedGain = dbToGain(gainDb);
    if (!url) {
      this.ambience.pause();
      return;
    }
    const absolute = new URL(url, location.href).href;
    if (this.ambience.src === absolute && !this.ambience.paused) {
      this.applyBed();
      return;
    }
    this.ambience.src = absolute;
    this.ambience.volume = 0;
    this.ambience.play().catch(() => undefined);
    this.fadeTo(this.targetBed(), 700);
  }

  /** The bed dips while she speaks and swells back after. */
  duck(on: boolean): void {
    if (this.ducked === on) return;
    this.ducked = on;
    this.fadeTo(this.targetBed(), 350);
  }

  private targetBed(): number {
    return this.ducked ? this.bedGain * 0.3 : this.bedGain;
  }
  private applyBed(): void {
    this.fadeTo(this.targetBed(), 350);
  }

  private fadeTo(target: number, ms: number): void {
    if (this.fadeTimer) window.clearInterval(this.fadeTimer);
    const el = this.ambience;
    const start = el.volume;
    const t0 = performance.now();
    this.fadeTimer = window.setInterval(() => {
      const k = Math.min(1, (performance.now() - t0) / ms);
      el.volume = start + (target - start) * k;
      if (k >= 1 && this.fadeTimer) {
        window.clearInterval(this.fadeTimer);
        this.fadeTimer = null;
      }
    }, 40);
  }

  /** Hold-to-pause: her voice waits, the street keeps breathing quietly. */
  holdAll(): void {
    this.pauseVoice();
    this.duck(false);
  }

  stop(): void {
    this.voiceToken++;
    this.voice.pause();
    this.ambience.pause();
    if (this.fadeTimer) window.clearInterval(this.fadeTimer);
  }
}
