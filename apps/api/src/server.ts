import { buildApp } from "./app.ts";
import { config } from "./config.ts";

const app = await buildApp({
  toursDir: config.toursDir,
  mediaBaseUrl: config.mediaBaseUrl,
  playerDir: config.playerDir,
  playerTokenSecret: config.playerTokenSecret,
  platformKeys: config.platformKeys,
  openaiApiKey: config.openaiApiKey,
  realtimeModel: config.realtimeModel,
  dev: config.dev,
  logger: true,
});

await app.listen({ port: config.port, host: "0.0.0.0" });
console.log(`[api] listening on ${config.publicBaseUrl}`);
console.log(`[api] tours ${config.toursDir}  media ${config.mediaBaseUrl}  player ${config.playerDir || "(served by vite in dev)"}`);
console.log(`[api] platform keys ${config.platformKeys.length ? `${config.platformKeys.length} configured` : "NONE — every request is allowed"}`);
console.log(`[api] player tokens ${config.playerTokenSecret ? "enabled" : "DISABLED — the hosted player needs a platform key to load a tour"}`);
// The live companion is the one thing here that reaches an outside provider,
// and its absence is otherwise only visible as a 503 on a button nobody may
// press for hours. Say so at boot.
console.log(`[api] companion voice ${config.openaiApiKey ? `ready (${config.realtimeModel})` : "UNAVAILABLE — no OPENAI_API_KEY, the Ask button will 503"}`);
