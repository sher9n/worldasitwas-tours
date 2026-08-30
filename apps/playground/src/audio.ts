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

  /**
   * Levels go through Web Audio, not through element.volume, because iOS
   * ignores element.volume completely: on a phone the street bed was playing at
   * full level under her voice and the duck did nothing at all. Gain nodes also
   * ramp smoothly, which is what stops a level change clicking.
   */
  private ctx?: AudioContext;
  private voiceGain?: GainNode;
  private bedNode?: GainNode;

  private wire(): void {
    if (this.ctx) return;
    try {
      // On iOS, sound routed through Web Audio is treated as ambient and is
      // silenced by the ring/silent switch, while a plain audio element is not.
      // Declaring the session as playback keeps a walk audible with the switch
      // on, and keeps it running when the phone locks or the tab goes behind.
      const session = (navigator as unknown as { audioSession?: { type: string } }).audioSession;
      if (session) session.type = "playback";
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      const ctx = new Ctor();
      const voiceGain = ctx.createGain();
      const bedNode = ctx.createGain();
      voiceGain.gain.value = 1;
      bedNode.gain.value = 0;
      ctx.createMediaElementSource(this.voice).connect(voiceGain).connect(ctx.destination);
      ctx.createMediaElementSource(this.ambience).connect(bedNode).connect(ctx.destination);
      this.ctx = ctx;
      this.voiceGain = voiceGain;
      this.bedNode = bedNode;
      // Coming back from a locked phone or another tab leaves the context
      // suspended, which is silence that looks like a bug. Wake it on return.
      const wake = () => void ctx.resume().catch(() => undefined);
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") wake();
      });
      document.addEventListener("pointerdown", wake, { passive: true });
    } catch {
      // No Web Audio: element volume is the only lever, and on iOS not even that.
    }
  }

  /** Ramp a channel smoothly; an abrupt change is what makes a click. */
  private ramp(node: GainNode | undefined, to: number, ms: number, el: HTMLAudioElement): void {
    if (node && this.ctx) {
      const t = this.ctx.currentTime;
      node.gain.cancelScheduledValues(t);
      node.gain.setValueAtTime(Math.max(0.0001, node.gain.value), t);
      node.gain.linearRampToValueAtTime(Math.max(0.0001, to), t + ms / 1000);
      return;
    }
    el.volume = Math.max(0, Math.min(1, to));
  }

  private ambiencePlays = 0;
  private ambienceDone = false;

  constructor() {
    // The street plays through at most twice per stop, then rests: a bed that
    // loops forever stops being scenery and starts being noticeable.
    this.ambience.loop = false;
    this.ambience.addEventListener("ended", () => {
      this.ambiencePlays++;
      if (this.ambiencePlays < 2) {
        this.ambience.currentTime = 0;
        this.ambience.play().catch(() => undefined);
      } else {
        this.ambienceDone = true;
      }
    });
    this.voice.preload = "auto";
    // The recordings come from the API on another port. A media element routed
    // through Web Audio outputs SILENCE if its source is cross-origin and the
    // request did not ask for CORS, so this attribute is what makes the mixer
    // audible at all. It must be set before any src is assigned.
    for (const el of [this.voice, this.ambience]) el.crossOrigin = "anonymous";
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
    // Wiring must happen inside the gesture too, or the context stays suspended.
    this.wire();
    void this.ctx?.resume().catch(() => undefined);
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
    const start = 1;
    const t0 = performance.now();
    const step = () => {
      if (token !== this.voiceToken) return;
      const k = Math.min(1, (performance.now() - t0) / 180);
      this.ramp(this.voiceGain, start * (1 - k), 40, el);
      if (k >= 1) {
        el.pause();
        this.ramp(this.voiceGain, 1, 60, el);
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
    if (this.ambience.src === absolute) {
      // Same stop: keep whatever state it is in; a finished bed stays finished.
      if (!this.ambienceDone && !this.ambience.paused) this.applyBed();
      return;
    }
    this.ambiencePlays = 0;
    this.ambienceDone = false;
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
    this.ramp(this.bedNode, target, ms, this.ambience);
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
