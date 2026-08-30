import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

/**
 * Find the workspace root by walking up for the package.json that declares the
 * workspaces, rather than counting directories up from this file.
 *
 * The count is different in development and in production and that difference
 * is invisible until something is deployed: running from source this module
 * sits at apps/api/src, three levels down, but the production build bundles it
 * to dist/, one level down. The fixed `../../..` resolved to the parent of the
 * repository, and the service came up serving an empty catalogue from a
 * directory that does not exist. Anchoring on a file that only exists at the
 * root is correct from either place.
 */
function findRepoRoot(from: string): string {
  let dir = from;
  for (let i = 0; i < 10; i++) {
    const candidate = path.join(dir, "package.json");
    if (fs.existsSync(candidate)) {
      try {
        if (JSON.parse(fs.readFileSync(candidate, "utf8")).workspaces) return dir;
      } catch {
        // A malformed package.json on the way up is not the root; keep going.
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Nothing found (an unpacked single-file deploy, say). The working directory
  // is the only honest answer left, and CONTENT_DIR can always be absolute.
  return process.cwd();
}

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = findRepoRoot(here);
dotenv.config({ path: path.join(repoRoot, ".env") });

function resolvePlayerDir(): string {
  if (process.env.PLAYER_DIR !== undefined) {
    const raw = process.env.PLAYER_DIR;
    if (!raw) return "";
    return path.isAbsolute(raw) ? raw : path.resolve(repoRoot, raw);
  }
  const built = path.join(repoRoot, "apps/playground/dist");
  return fs.existsSync(path.join(built, "index.html")) ? built : "";
}

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
  /**
   * Where media is actually served from. Defaults to this service's own
   * /media mount, which is right in dev and for a single-box deploy; in
   * production it is the bucket or CDN, and the service then serves JSON only.
   */
  mediaBaseUrl: (process.env.MEDIA_BASE_URL || `${(process.env.PUBLIC_BASE_URL || `http://localhost:${process.env.PORT || 4100}`).replace(/\/$/, "")}/media`).replace(/\/$/, ""),
  /**
   * The built player, served at the root so a walk opens at
   * <origin>/?tour=…&play=1.
   *
   * Found rather than configured: a deployment that has run the build has the
   * player sitting right there, and making the operator name its path is a
   * step to forget — one that fails as a 404 on the tour itself rather than as
   * anything obviously wrong at boot. In development the directory does not
   * exist and Vite serves the player instead, so this stays empty on its own.
   * Set PLAYER_DIR to override, or to "" to serve the API alone.
   */
  playerDir: resolvePlayerDir(),
  /**
   * Secret for player tokens, shared with whoever builds player URLs. Without
   * it the hosted player cannot authenticate itself and only a platform key
   * opens a tour — which is fine for server-to-server, useless for a browser.
   */
  playerTokenSecret: process.env.PLAYER_TOKEN_SECRET || "",
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
