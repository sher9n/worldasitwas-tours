import { buildApp } from "./app.ts";
import { config } from "./config.ts";

const app = await buildApp({
  toursDir: config.toursDir,
  falKey: config.falKey,
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

/**
 * Shut down on the platform's signal instead of being killed by it.
 *
 * Railway sends SIGTERM when it replaces a container. Without this the process
 * dies mid-request — a traveller streaming her narration gets a truncated
 * file — and the deployment is recorded as a crash rather than a replacement,
 * which makes the deploy history useless for spotting a real one.
 */
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    console.log(`[api] ${signal} received, finishing in-flight requests`);
    app
      .close()
      .then(() => {
        console.log("[api] closed");
        process.exit(0);
      })
      .catch((err) => {
        console.error("[api] close failed", err);
        process.exit(1);
      });
  });
}
console.log(`[api] listening on ${config.publicBaseUrl}`);
console.log(`[api] tours ${config.toursDir}  media ${config.mediaBaseUrl}  player ${config.playerDir || "(served by vite in dev)"}`);
console.log(`[api] platform keys ${config.platformKeys.length ? `${config.platformKeys.length} configured` : "NONE — every request is allowed"}`);
console.log(`[api] player tokens ${config.playerTokenSecret ? "enabled" : "DISABLED — the hosted player needs a platform key to load a tour"}`);
// The live companion is the one thing here that reaches an outside provider,
// and its absence is otherwise only visible as a 503 on a button nobody may
// press for hours. Say so at boot.
console.log(`[api] companion voice ${config.openaiApiKey ? `ready (${config.realtimeModel})` : "UNAVAILABLE — no OPENAI_API_KEY, the Ask button will 503"}`);
