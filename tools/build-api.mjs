/**
 * Production build for the tour API.
 *
 * The source imports its own modules with explicit `.ts` extensions, which is
 * what lets `tsx` run it directly in development — and exactly what stops
 * `tsc` from emitting a runnable build, since the emitted `.js` would still
 * import `.ts`. Rewriting every import to `.js` would churn the whole
 * codebase while another agent is working in it.
 *
 * So esbuild bundles our own TypeScript — the API, the schema and the client
 * packages — into one ESM file, and leaves every third-party dependency
 * external for `npm ci --omit=dev` to install normally. Nothing from
 * node_modules is rewritten or inlined, which keeps Fastify's own plugin
 * resolution and `require` calls working exactly as they do in development.
 *
 * The external list is read from package.json rather than written out here,
 * so adding a dependency cannot silently produce a build that bundles it.
 */
import { build } from "esbuild";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(await readFile(path.join(root, "apps/api/package.json"), "utf8"));

// Workspace packages are source, not dependencies: they have to be bundled.
const external = Object.keys(pkg.dependencies ?? {}).filter((d) => !d.startsWith("@timetravel/"));

const result = await build({
  entryPoints: [path.join(root, "apps/api/src/server.ts")],
  outfile: path.join(root, "dist/server.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: true,
  minify: false, // a stack trace from production should name real functions
  external,
  logLevel: "info",
  metafile: true,
});

// The bundle is ESM but the workspace root package.json has no "type", so Node
// sniffs the file on every boot and warns. A one-line package.json beside the
// output settles it without making the whole repo ESM, which would change how
// every .cjs tool in tools/ and apps/playground/tools/ is resolved.
await mkdir(path.join(root, "dist"), { recursive: true });
await writeFile(path.join(root, "dist/package.json"), JSON.stringify({ type: "module" }, null, 2) + "\n");

const bytes = Object.values(result.metafile.outputs).reduce((n, o) => n + o.bytes, 0);
console.log(`[build] dist/server.js  ${(bytes / 1024).toFixed(0)} kB  external: ${external.join(", ")}`);
