import { buildApp } from "./app.ts";
import { config } from "./config.ts";

const app = await buildApp({
  toursDir: config.toursDir,
  platformKeys: config.platformKeys,
  openaiApiKey: config.openaiApiKey,
  falKey: config.falKey,
  realtimeModel: config.realtimeModel,
  dev: config.dev,
  logger: true,
});

await app.listen({ port: config.port, host: "0.0.0.0" });
console.log(`[api] listening on ${config.publicBaseUrl}  tours from ${config.toursDir}`);
