import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const here = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(here, "../../..");
dotenv.config({ path: path.join(repoRoot, ".env") });

export type Quality = "draft" | "final";
export type ProviderName = "fal" | "mock";

function abs(p: string): string {
  return path.isAbsolute(p) ? p : path.resolve(repoRoot, p);
}

export const env = {
  falKey: process.env.FAL_KEY || "",
  openaiApiKey: process.env.OPENAI_API_KEY || "",
  publicBaseUrl: (process.env.PUBLIC_BASE_URL || "http://localhost:4100").replace(/\/$/, ""),
  contentDir: abs(process.env.CONTENT_DIR || "./content"),
  mediaProvider: (process.env.MEDIA_PROVIDER || "fal") as ProviderName,
  quality: (process.env.QUALITY || "draft") as Quality,
  researchModel: process.env.RESEARCH_MODEL || "gpt-5.4",
};

export const dirs = {
  tours: path.join(env.contentDir, "tours"),
  work: path.join(env.contentDir, "work"),
  recipes: path.join(env.contentDir, "recipes"),
};
