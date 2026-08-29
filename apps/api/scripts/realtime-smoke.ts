/**
 * End-to-end check of the companion voice path without a browser:
 * mint a client secret exactly as the API does, open the Realtime WebSocket
 * with it, send one typed question, and confirm audio bytes and a transcript
 * come back in character. Costs a few cents.
 */
import WebSocket from "ws";
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../src/config.ts";
import { mintSession } from "../src/companion.ts";
import { parseTour } from "@timetravel/schema";

const tourId = process.argv[2] || "tour_london_1850_flower_seller";
const question = process.argv[3] || "What would a cup of coffee cost me here, and where should I get it?";

const manifest = parseTour(JSON.parse(await fs.readFile(path.join(config.toursDir, tourId, "manifest.json"), "utf8")));
let companionNotes: string | undefined;
try {
  companionNotes = await fs.readFile(path.join(config.toursDir, tourId, "companion.md"), "utf8");
} catch {
  companionNotes = undefined;
}

const t0 = Date.now();
const session = await mintSession({
  apiKey: config.openaiApiKey,
  model: config.realtimeModel,
  tour: manifest,
  companionNotes,
  request: { travellerId: "smoke", stopId: manifest.stops[0].id, cardId: manifest.stops[0].cards[0].id },
});
console.log(`minted ${session.sessionId} in ${Date.now() - t0} ms, voice=${session.realtime.voice}`);

const ws = new WebSocket(`wss://api.openai.com/v1/realtime?model=${encodeURIComponent(session.realtime.model)}`, {
  headers: { Authorization: `Bearer ${session.realtime.clientSecret}` },
});

let audioBytes = 0;
let transcript = "";
let firstAudioAt = 0;
let askedAt = 0;

ws.on("open", () => {
  console.log("websocket open");
  const ctx = manifest.stops[0].cards[0].companionContext;
  if (ctx) {
    ws.send(
      JSON.stringify({
        type: "conversation.item.create",
        item: { type: "message", role: "user", content: [{ type: "input_text", text: `[Context, do not reply] ${ctx.text}` }] },
      }),
    );
  }
  ws.send(
    JSON.stringify({
      type: "conversation.item.create",
      item: { type: "message", role: "user", content: [{ type: "input_text", text: question }] },
    }),
  );
  askedAt = Date.now();
  ws.send(JSON.stringify({ type: "response.create" }));
});

ws.on("message", (data) => {
  const ev = JSON.parse(data.toString());
  switch (ev.type) {
    case "response.output_audio.delta":
      if (!firstAudioAt) firstAudioAt = Date.now();
      audioBytes += Buffer.from(ev.delta, "base64").length;
      break;
    case "response.output_audio_transcript.delta":
      transcript += ev.delta;
      break;
    case "response.done": {
      const usage = ev.response?.usage;
      console.log(`first audio after ${firstAudioAt - askedAt} ms; total ${Date.now() - askedAt} ms`);
      console.log(`audio bytes: ${audioBytes} (~${(audioBytes / 48000).toFixed(1)} s of 24 kHz pcm16)`);
      console.log(`transcript: ${transcript.trim()}`);
      if (usage) console.log(`usage: in=${usage.input_tokens} out=${usage.output_tokens}`);
      ws.close();
      break;
    }
    case "error":
      console.error("realtime error", JSON.stringify(ev.error));
      ws.close();
      process.exitCode = 1;
      break;
    default:
      break;
  }
});

ws.on("close", () => {
  console.log(audioBytes > 0 && transcript ? "SMOKE OK" : "SMOKE FAILED");
  if (!(audioBytes > 0 && transcript)) process.exitCode = 1;
});
ws.on("error", (e) => {
  console.error("ws error", e.message);
  process.exitCode = 1;
});
