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

export class CompanionSession {
  private pc?: RTCPeerConnection;
  private dc?: RTCDataChannel;
  private mic?: MediaStream;
  private audioEl: HTMLAudioElement;
  private pendingContext?: CompanionContext;
  private turns = 0;
  private startedAt = 0;
  state: CompanionState = "idle";
  sessionId = "";

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
    // Cut her off if she is mid-sentence, then open the mic.
    this.send({ type: "response.cancel" });
    this.send({ type: "input_audio_buffer.clear" });
    const track = this.mic?.getAudioTracks()[0];
    if (track) track.enabled = true;
    this.setState("listening");
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

  private handle(ev: { type: string } & Record<string, unknown>): void {
    switch (ev.type) {
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
      case "response.done":
        if (this.state === "speaking" || this.state === "thinking") this.setState("ready");
        break;
      case "error":
        this.setState("error", JSON.stringify(ev.error).slice(0, 200));
        break;
      default:
        break;
    }
  }

  close(): void {
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
