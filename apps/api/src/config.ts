import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
dotenv.config({ path: path.join(repoRoot, ".env") });

function resolveContentDir(): string {
  const raw = process.env.CONTENT_DIR || "./content";
  return path.isAbsolute(raw) ? raw : path.resolve(repoRoot, raw);
}

export const config = {
  repoRoot,
  port: Number(process.env.PORT || 4100),
  publicBaseUrl: (process.env.PUBLIC_BASE_URL || `http://localhost:${process.env.PORT || 4100}`).replace(/\/$/, ""),
  contentDir: resolveContentDir(),
  toursDir: path.join(resolveContentDir(), "tours"),
  platformKeys: (process.env.PLATFORM_KEYS || "")
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean),
  openaiApiKey: process.env.OPENAI_API_KEY || "",
  falKey: process.env.FAL_KEY || "",
  realtimeModel: process.env.REALTIME_MODEL || "gpt-realtime-2",
  /** Dev mode exposes unauthenticated helper routes for the playground. */
  dev: process.env.NODE_ENV !== "production",
};
