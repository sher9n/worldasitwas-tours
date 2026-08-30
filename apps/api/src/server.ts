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
