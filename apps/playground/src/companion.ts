/**
 * Browser side of the live companion: WebRTC to OpenAI Realtime with a client
 * secret minted by our API. Push-to-talk (no server voice detection), card
 * context pushed as conversation items, tool calls surfaced to the player.
 */
import type { CompanionContext } from "@timetravel/schema";
import { api, travellerId } from "./api.ts";

export type CompanionState = "idle" | "connecting" | "ready" | "listening" | "thinking" | "speaking" | "error" | "closed";

export interface CompanionEvents {
  onState: (s: CompanionState, detail?: string) => void;
  onTranscript: (who: "you" | "companion", text: string, final: boolean) => void;
  onTool: (name: string, args: Record<string, unknown>) => void;
  onEvent?: (name: string, payload: Record<string, unknown>) => void;
}

/**
 * The walk declares its iOS audio session as "playback" so narration survives
 * the ring/silent switch. But playback is an output-only category, and iOS
 * refuses a microphone under it: "audio session category is not compatible
 * with audio capture". So for exactly as long as an ask session holds the
 * mic, the session runs as "play-and-record", which captures and still
 * ignores the silent switch, and it goes back to "playback" when the mic is
 * released. Browsers without the API skip all of this.
 */
function setAudioSessionType(type: "playback" | "play-and-record"): void {
  try {
    const session = (navigator as unknown as { audioSession?: { type: string } }).audioSession;
    if (session) session.type = type;
  } catch {
    // an unsupported session type is not worth breaking the ask over
  }
}

async function imageToDataUrl(url: string, maxSide = 640): Promise<string | undefined> {
  try {
    const img = new Image();
    img.crossOrigin = "anonymous";
    await new Promise<void>((ok, bad) => {
      img.onload = () => ok();
      img.onerror = () => bad(new Error("image load failed"));
      img.src = url;
    });
    const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(img.naturalWidth * scale);
    canvas.height = Math.round(img.naturalHeight * scale);
    canvas.getContext("2d")!.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.8);
  } catch {
    return undefined;
  }
}

type SessionInfo = Awaited<ReturnType<typeof api.session>>;

/**
 * Listens to her live voice as it plays and reports whether sound is coming out
 * right now. A short tail keeps the breath between words from reading as silence.
 */
class VoiceMeter {
  private analyser?: AnalyserNode;
  private data?: Uint8Array<ArrayBuffer>;
  private lastLoud = 0;

  attach(stream: MediaStream): void {
    try {
      const ctx = new AudioContext();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      ctx.createMediaStreamSource(stream).connect(analyser);
      this.analyser = analyser;
      this.data = new Uint8Array(new ArrayBuffer(analyser.frequencyBinCount));
    } catch {
      // no meter available; the call's own signal will have to do
    }
  }

  /** True while her voice is audible, or was within the last breath. */
  audible(): boolean {
    if (!this.analyser || !this.data) return true;
    this.analyser.getByteTimeDomainData(this.data);
    let peak = 0;
    for (const v of this.data) peak = Math.max(peak, Math.abs(v - 128));
    if (peak > 3) this.lastLoud = Date.now();
    return Date.now() - this.lastLoud < 320;
  }
}

/**
 * Her live answers arrive as her own voice over the call, the same voice the
 * tour is recorded in, so nothing has to be synthesized a second time.
 */
export class CompanionSession {
  private pc?: RTCPeerConnection;
  private dc?: RTCDataChannel;
  private mic?: MediaStream;
  /** The audio sender negotiated up front; the mic is attached to it on first hold. */
  private sender?: RTCRtpSender;
  /** The connect in flight, so a hold during it waits rather than no-ops. */
  private connectPromise?: Promise<void>;
  /** True from pointer-down to pointer-up; a mic prompt outlives a short hold. */
  private holding = false;
  private audioEl: HTMLAudioElement;
  private pendingContext?: CompanionContext;
  private turns = 0;
  private startedAt = 0;
  private answerText = "";
  private responseActive = false;
  private meter = new VoiceMeter();
  private sounding = false;
  /** Sentences of the current answer, spoken in order in the tour's own voice. */
  private toSay: string[] = [];
  private saying = false;
  private buffer = "";
  state: CompanionState = "idle";
  sessionId = "";
  /** A minted credential that no call has consumed yet, kept for the next attempt. */
  private spare: { session: SessionInfo; expiresAt: number } | null = null;

  constructor(
    private tourId: string,
    private ev: CompanionEvents,
  ) {
    this.audioEl = document.createElement("audio");
    this.audioEl.autoplay = true;
    document.body.appendChild(this.audioEl);
  }

  private setState(s: CompanionState, detail?: string) {
    this.state = s;
    this.ev.onState(s, detail);
  }

  private send(msg: Record<string, unknown>) {
    if (this.dc?.readyState === "open") this.dc.send(JSON.stringify(msg));
  }

  async connect(stopId?: string, cardId?: string): Promise<void> {
    // A second caller while a connect is in flight (holding during the
    // preconnect, most of the time) waits for the same attempt instead of
    // being silently dropped, which is exactly how the button went dead.
    if (this.dc?.readyState === "open") return;
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = this.doConnect(stopId, cardId).finally(() => {
      this.connectPromise = undefined;
    });
    return this.connectPromise;
  }

  private async doConnect(stopId?: string, cardId?: string): Promise<void> {
    if (this.pc) return;
    this.setState("connecting");
    try {
      // Reuse an unconsumed credential rather than minting another: a reload or a
      // torn-down preconnect otherwise spends one every time, and the traveller
      // runs out of them without ever having spoken.
      const spare = this.spare && this.spare.expiresAt - Date.now() > 60_000 ? this.spare.session : null;
      const session = spare ?? (await this.mint(stopId, cardId));
      this.spare = { session, expiresAt: Date.parse(session.expiresAt) || Date.now() + 600_000 };
      this.sessionId = session.sessionId;
      const pc = new RTCPeerConnection();
      this.pc = pc;
      pc.ontrack = (e) => {
        this.audioEl.srcObject = e.streams[0];
        this.meter.attach(e.streams[0]);
      };
      // No microphone here, on purpose. connect runs at page-load preconnect
      // and after awaiting the network, both places where iOS refuses a mic
      // request (no fresh user gesture) and then REMEMBERS the refusal, which
      // left the button dead for the whole visit. The call is negotiated with
      // an empty audio sender instead, and the mic is attached to it inside
      // the first hold, the one moment a mic request is unquestionably wanted.
      this.sender = pc.addTransceiver("audio", { direction: "sendrecv" }).sender;
      const dc = pc.createDataChannel("oai-events");
      this.dc = dc;
      dc.onmessage = (m) => this.handle(JSON.parse(m.data));
      dc.onclose = () => this.setState("closed");
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      const res = await fetch(`${session.realtime.connectUrl}?model=${encodeURIComponent(session.realtime.model)}`, {
        method: "POST",
        body: offer.sdp,
        headers: { Authorization: `Bearer ${session.realtime.clientSecret}`, "Content-Type": "application/sdp" },
      });
      if (!res.ok) throw new Error(`realtime connect ${res.status}: ${(await res.text()).slice(0, 200)}`);
      await pc.setRemoteDescription({ type: "answer", sdp: await res.text() });
      await new Promise<void>((ok, bad) => {
        if (dc.readyState === "open") return ok();
        dc.onopen = () => ok();
        setTimeout(() => bad(new Error("data channel timeout")), 10000);
      });
      this.spare = null; // consumed by this call
      this.startedAt = Date.now();
      this.setState("ready");
      this.ev.onEvent?.("ask_session_started", { sessionId: this.sessionId, model: session.realtime.model, voice: session.realtime.voice });
      if (this.pendingContext) this.sendContext(this.pendingContext);
    } catch (err) {
      this.setState("error", (err as Error).message);
      this.close();
      throw err;
    }
  }

  /** Queue one sentence to be spoken in the tour's voice. */
  private enqueue(sentence: string): void {
    if (!sentence) return;
    this.toSay.push(sentence);
    void this.drain();
  }

  /** Speak what is queued, in order, never two at once. */
  private async drain(): Promise<void> {
    if (this.saying) return;
    this.saying = true;
    try {
      while (this.toSay.length) {
        const text = this.toSay.shift()!;
        let url = "";
        try {
          const res = await fetch(`/v1/tours/${encodeURIComponent(this.tourId)}/companion/say`, {
            method: "POST",
            credentials: "same-origin",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${localStorage.getItem("tt.key") || "dev"}` },
            body: JSON.stringify({ text }),
          });
          if (!res.ok) throw new Error(`say ${res.status}`);
          url = URL.createObjectURL(await res.blob());
        } catch {
          continue;
        }
        this.sounding = true;
        if (this.state !== "speaking") this.setState("speaking");
        await new Promise<void>((done) => {
          this.audioEl.onended = () => done();
          this.audioEl.onerror = () => done();
          this.audioEl.src = url;
          void this.audioEl.play().catch(() => done());
        });
        URL.revokeObjectURL(url);
      }
    } finally {
      this.saying = false;
      this.sounding = false;
      if (this.state === "speaking") this.setState("ready");
    }
  }

  /** Mints a realtime credential, waiting once if the budget asks us to. */
  private async mint(stopId?: string, cardId?: string): Promise<SessionInfo> {
    const ask = () => api.session(this.tourId, { travellerId: travellerId(), stopId, cardId, locale: navigator.language });
    try {
      return await ask();
    } catch (err) {
      const e = err as Error & { status?: number; retryAfterSec?: number };
      // A short wait is worth sitting through silently; a long one is honest to surface.
      if (e.status === 429 && e.retryAfterSec && e.retryAfterSec <= 20) {
        await new Promise((ok) => setTimeout(ok, e.retryAfterSec! * 1000 + 250));
        return await ask();
      }
      throw err;
    }
  }

  /** Tell her what is on screen. Safe to call before connect; the last one is replayed. */
  async sendContext(ctx: CompanionContext): Promise<void> {
    this.pendingContext = ctx;
    if (this.dc?.readyState !== "open") return;
    const content: Record<string, unknown>[] = [{ type: "input_text", text: `[Context, do not reply] The visitor's screen now shows: ${ctx.text}` }];
    if (ctx.image) {
      const dataUrl = await imageToDataUrl(ctx.image);
      if (dataUrl) content.push({ type: "input_image", image_url: dataUrl });
    }
    this.send({ type: "conversation.item.create", item: { type: "message", role: "user", content } });
  }

  async pttStart(): Promise<void> {
    this.holding = true;
    // A hold that lands while the session is still connecting waits for it;
    // releasing during the wait simply means nothing starts.
    if (this.connectPromise) {
      try {
        await this.connectPromise;
      } catch {
        return;
      }
    }
    if (!this.holding) return;
    if (this.state !== "ready" && this.state !== "speaking") return;
    if (!this.mic) {
      // First hold: ask for the microphone now, inside the gesture. On the
      // devices that cannot give one at all, say so instead of "hiccup".
      if (!navigator.mediaDevices?.getUserMedia) {
        this.setState("error", "no microphone on this device");
        return;
      }
      setAudioSessionType("play-and-record");
      try {
        const mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
        if (!this.holding) {
          // Released while the permission prompt was up; keep nothing running.
          mic.getTracks().forEach((t) => t.stop());
          setAudioSessionType("playback");
          return;
        }
        const track = mic.getAudioTracks()[0];
        track.enabled = false;
        await this.sender?.replaceTrack(track);
        this.mic = mic;
      } catch (err) {
        // The browser's own words here are famously unhelpful ("Not
        // supported"), so the common refusals get said in ours.
        const name = (err as DOMException).name;
        setAudioSessionType("playback");
        const why =
          name === "NotAllowedError" ? "allow microphone access to ask"
          : name === "NotFoundError" ? "no microphone found"
          : name === "NotSupportedError" || name === "SecurityError" ? "this browser will not share the microphone"
          : (err as Error).message;
        this.setState("error", why);
        return;
      }
    }
    if (!this.holding || (this.state !== "ready" && this.state !== "speaking")) return;
    // Cut her off only if she is actually mid-sentence, then open the mic.
    if (this.responseActive) this.send({ type: "response.cancel" });
    this.send({ type: "output_audio_buffer.clear" });
    this.toSay = [];
    this.buffer = "";
    this.audioEl.pause();
    this.sounding = false;
    this.send({ type: "input_audio_buffer.clear" });
    const track = this.mic?.getAudioTracks()[0];
    if (track) track.enabled = true;
    this.setState("listening");
  }

  /** Stop a live answer mid-sentence (used by the tour's pause). */
  stopSpeaking(): void {
    if (this.responseActive) this.send({ type: "response.cancel" });
    // Whatever has already been sent is sitting in the playback buffer; clearing
    // it is what actually stops the sound.
    this.send({ type: "output_audio_buffer.clear" });
    this.toSay = [];
    this.buffer = "";
    this.audioEl.pause();
    this.sounding = false;
    if (this.state === "speaking" || this.state === "thinking") this.setState("ready");
  }

  pttEnd(): void {
    this.holding = false;
    if (this.state !== "listening") return;
    const track = this.mic?.getAudioTracks()[0];
    if (track) track.enabled = false;
    this.send({ type: "input_audio_buffer.commit" });
    this.send({ type: "response.create" });
    this.turns++;
    this.setState("thinking");
  }



  private handle(ev: { type: string } & Record<string, unknown>): void {
    switch (ev.type) {
      case "response.created":
        this.responseActive = true;
        this.answerText = "";
        break;
      case "response.output_text.delta": {
        const delta = String(ev.delta ?? "");
        this.answerText += delta;
        this.ev.onTranscript("companion", delta, false);
        // Peel off whole sentences as they arrive, so she starts talking a
        // sentence in rather than after the entire answer is written.
        this.buffer += delta;
        let m: RegExpMatchArray | null;
        while ((m = this.buffer.match(/^[\s\S]*?[.!?…]+(?=\s|$)/))) {
          this.enqueue(m[0].trim());
          this.buffer = this.buffer.slice(m[0].length).replace(/^\s+/, "");
        }
        break;
      }
      case "response.output_audio.delta":
      case "output_audio_buffer.started":
        this.sounding = true;
        if (this.state !== "speaking") this.setState("speaking");
        break;
      case "output_audio_buffer.stopped":
      case "output_audio_buffer.cleared":
        this.sounding = false;
        if (this.state === "speaking") this.setState("ready");
        break;
      case "response.output_audio_transcript.delta":
        this.ev.onTranscript("companion", String(ev.delta ?? ""), false);
        break;
      case "response.output_audio_transcript.done":
        this.ev.onTranscript("companion", String(ev.transcript ?? ""), true);
        break;
      case "conversation.item.input_audio_transcription.completed":
        this.ev.onTranscript("you", String(ev.transcript ?? ""), true);
        break;
      case "response.function_call_arguments.done": {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(String(ev.arguments ?? "{}"));
        } catch {
          args = {};
        }
        const name = String(ev.name);
        this.ev.onTool(name, args);
        this.send({ type: "conversation.item.create", item: { type: "function_call_output", call_id: ev.call_id, output: JSON.stringify({ ok: true }) } });
        if (name !== "end_conversation") this.send({ type: "response.create" });
        break;
      }
      case "response.done": {
        this.responseActive = false;
        if (this.buffer.trim()) {
          this.enqueue(this.buffer.trim());
          this.buffer = "";
        }
        if (this.answerText.trim()) this.ev.onTranscript("companion", this.answerText.trim(), true);
        // Her audio keeps playing after the answer is generated, so thinking
        // gives way to ready only when nothing is left to be heard.
        if (!this.sounding && this.state !== "speaking") this.setState("ready");
        break;
      }
      case "error": {
        // Housekeeping notices, not failures: cancelling nothing, committing silence.
        const code = (ev.error as { code?: string } | undefined)?.code ?? "";
        if (/response_cancel_not_active|input_audio_buffer_commit_empty|conversation_already_has_active_response/.test(code)) {
          this.ev.onEvent?.("ask_notice", { code });
          if (this.state === "thinking") this.setState("ready");
          break;
        }
        const msg = (ev.error as { message?: string } | undefined)?.message ?? code;
        this.setState("error", String(msg).slice(0, 80));
        // Tear down so the next hold reconnects cleanly instead of hitting a dead session.
        this.close();
        break;
      }
      default:
        break;
    }
  }

  /** Mute or unmute her live audio without ending the session. */
  setMuted(on: boolean): void {
    this.audioEl.muted = on;
  }

  /** Is her live answer audibly playing right now? Drives her on-screen mouth. */
  isSpeakingAudio(): boolean {
    return this.sounding && !this.audioEl.muted && !this.audioEl.paused;
  }

  close(): void {
    this.sounding = false;
    const seconds = this.startedAt ? Math.round((Date.now() - this.startedAt) / 1000) : 0;
    if (this.startedAt) this.ev.onEvent?.("ask_session_ended", { sessionId: this.sessionId, turns: this.turns, seconds });
    this.dc?.close();
    this.pc?.close();
    this.mic?.getTracks().forEach((t) => t.stop());
    // The mic is gone, so the walk goes back to the category that keeps
    // narration audible with the silent switch on.
    if (this.mic) setAudioSessionType("playback");
    this.pc = undefined;
    this.dc = undefined;
    this.mic = undefined;
    this.sender = undefined;
    this.startedAt = 0;
    if (this.state !== "error") this.setState("closed");
  }
}
