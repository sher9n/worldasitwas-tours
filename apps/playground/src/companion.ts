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

/**
 * Speaks her live answers in her own recorded voice: sentences stream in as
 * text and come back as audio from the tour API, scheduled gaplessly.
 */
class SentenceSpeaker {
  private ctx?: AudioContext;
  private nextTime = 0;
  private sources: AudioBufferSourceNode[] = [];
  private queue: string[] = [];
  private working = false;
  private cancelled = false;
  playing = 0;

  /** Anything still to be heard: queued, being synthesized, or playing. */
  busy(): boolean {
    return this.queue.length > 0 || this.working || this.playing > 0;
  }

  constructor(
    private say: (text: string) => Promise<ArrayBuffer>,
    private onFirstAudio: () => void,
    private onDrained: () => void,
  ) {}

  enqueue(sentence: string): void {
    const s = sentence.trim();
    if (!s) return;
    this.cancelled = false;
    this.queue.push(s);
    void this.work();
  }

  private async work(): Promise<void> {
    if (this.working) return;
    this.working = true;
    while (this.queue.length && !this.cancelled) {
      const text = this.queue.shift()!;
      try {
        const bytes = await this.say(text);
        if (this.cancelled) break;
        this.ctx = this.ctx ?? new AudioContext();
        await this.ctx.resume().catch(() => undefined);
        const buf = await this.ctx.decodeAudioData(bytes.slice(0));
        const src = this.ctx.createBufferSource();
        src.buffer = buf;
        src.connect(this.ctx.destination);
        this.nextTime = Math.max(this.ctx.currentTime + 0.06, this.nextTime);
        src.start(this.nextTime);
        this.nextTime += buf.duration;
        this.playing++;
        if (this.playing === 1) this.onFirstAudio();
        this.sources.push(src);
        src.onended = () => {
          this.playing--;
          this.sources = this.sources.filter((x) => x !== src);
          if (this.playing === 0 && this.queue.length === 0) this.onDrained();
        };
      } catch {
        // A failed sentence is skipped; the next one still plays.
      }
    }
    this.working = false;
    if (this.playing === 0 && this.queue.length === 0) this.onDrained();
  }

  cancel(): void {
    this.cancelled = true;
    this.queue = [];
    for (const s of this.sources) {
      try {
        s.stop();
      } catch {
        // already stopped
      }
    }
    this.sources = [];
    this.playing = 0;
    this.nextTime = 0;
  }
}

export class CompanionSession {
  private pc?: RTCPeerConnection;
  private dc?: RTCDataChannel;
  private mic?: MediaStream;
  private audioEl: HTMLAudioElement;
  private pendingContext?: CompanionContext;
  private turns = 0;
  private startedAt = 0;
  private textBuf = "";
  private answerText = "";
  private responseActive = false;
  private speaker: SentenceSpeaker;
  state: CompanionState = "idle";
  sessionId = "";

  constructor(
    private tourId: string,
    private ev: CompanionEvents,
  ) {
    this.audioEl = document.createElement("audio");
    this.audioEl.autoplay = true;
    document.body.appendChild(this.audioEl);
    this.speaker = new SentenceSpeaker(
      async (text) => {
        const res = await fetch(`/v1/tours/${encodeURIComponent(this.tourId)}/companion/say`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${localStorage.getItem("tt.key") || "dev"}` },
          body: JSON.stringify({ text }),
        });
        if (!res.ok) throw new Error(`say ${res.status}`);
        return res.arrayBuffer();
      },
      () => this.setState("speaking"),
      () => {
        if (!this.responseActive && !this.speaker.busy() && (this.state === "speaking" || this.state === "thinking")) this.setState("ready");
      },
    );
  }

  private setState(s: CompanionState, detail?: string) {
    this.state = s;
    this.ev.onState(s, detail);
  }

  private send(msg: Record<string, unknown>) {
    if (this.dc?.readyState === "open") this.dc.send(JSON.stringify(msg));
  }

  async connect(stopId?: string, cardId?: string): Promise<void> {
    if (this.pc) return;
    this.setState("connecting");
    try {
      const session = await api.session(this.tourId, { travellerId: travellerId(), stopId, cardId, locale: navigator.language });
      this.sessionId = session.sessionId;
      const pc = new RTCPeerConnection();
      this.pc = pc;
      pc.ontrack = (e) => {
        this.audioEl.srcObject = e.streams[0];
      };
      this.mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      const track = this.mic.getAudioTracks()[0];
      track.enabled = false;
      pc.addTrack(track, this.mic);
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

  pttStart(): void {
    if (this.state !== "ready" && this.state !== "speaking") return;
    // Cut her off only if she is actually mid-sentence, then open the mic.
    if (this.responseActive) this.send({ type: "response.cancel" });
    this.speaker.cancel();
    this.textBuf = "";
    this.send({ type: "input_audio_buffer.clear" });
    const track = this.mic?.getAudioTracks()[0];
    if (track) track.enabled = true;
    this.setState("listening");
  }

  /** Stop a live answer mid-sentence (used by the tour's pause). */
  stopSpeaking(): void {
    if (this.responseActive) this.send({ type: "response.cancel" });
    this.speaker.cancel();
    this.textBuf = "";
    if (this.state === "speaking" || this.state === "thinking") this.setState("ready");
  }

  pttEnd(): void {
    if (this.state !== "listening") return;
    const track = this.mic?.getAudioTracks()[0];
    if (track) track.enabled = false;
    this.send({ type: "input_audio_buffer.commit" });
    this.send({ type: "response.create" });
    this.turns++;
    this.setState("thinking");
  }

  /** Completed sentences peel off the streaming text and go to her voice. */
  private feedText(delta: string): void {
    this.textBuf += delta;
    this.answerText += delta;
    let m: RegExpMatchArray | null;
    while ((m = this.textBuf.match(/^[\s\S]*?[.!?…]+(?=\s|$)/))) {
      this.speaker.enqueue(m[0]);
      this.textBuf = this.textBuf.slice(m[0].length).replace(/^\s+/, "");
    }
  }

  private handle(ev: { type: string } & Record<string, unknown>): void {
    switch (ev.type) {
      case "response.created":
        this.responseActive = true;
        this.answerText = "";
        break;
      case "response.output_text.delta":
        this.feedText(String(ev.delta ?? ""));
        this.ev.onTranscript("companion", String(ev.delta ?? ""), false);
        break;
      case "response.output_audio.delta":
        if (this.state !== "speaking") this.setState("speaking");
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
        if (this.textBuf.trim()) {
          this.speaker.enqueue(this.textBuf);
          this.textBuf = "";
        }
        if (this.answerText.trim()) this.ev.onTranscript("companion", this.answerText.trim(), true);
        // Thinking holds until her first audio actually plays; only a truly
        // empty answer goes straight back to ready.
        if (!this.speaker.busy() && this.state !== "speaking") this.setState("ready");
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
    return this.speaker.playing > 0;
  }

  close(): void {
    this.speaker.cancel();
    const seconds = this.startedAt ? Math.round((Date.now() - this.startedAt) / 1000) : 0;
    if (this.startedAt) this.ev.onEvent?.("ask_session_ended", { sessionId: this.sessionId, turns: this.turns, seconds });
    this.dc?.close();
    this.pc?.close();
    this.mic?.getTracks().forEach((t) => t.stop());
    this.pc = undefined;
    this.dc = undefined;
    this.mic = undefined;
    this.startedAt = 0;
    if (this.state !== "error") this.setState("closed");
  }
}
