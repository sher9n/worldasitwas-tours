/**
 * The client is vendored into the integration folder so an app can paste one
 * file instead of waiting for a published package. Two copies of a contract is
 * exactly how a contract rots, so this makes them the same file or fails.
 *
 * If this trips: copy packages/client/src/index.ts over the vendored path. Do
 * not edit the vendored copy — it is the output, not the source.
 */
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const source = path.join(root, "packages/client/src/index.ts");
const copies = [
  "integration/worldasitwas-app/apps/mobile/src/tours/timetravel.ts",
  "integration/worldasitwas-app/apps/api/src/tours/timetravel.ts",
];

const a = fs.readFileSync(source, "utf8");
let bad = 0;

for (const rel of copies) {
  const full = path.join(root, rel);
  const b = fs.existsSync(full) ? fs.readFileSync(full, "utf8") : null;
  if (a === b) {
    console.log(`[vendor] PASS ${rel}`);
    continue;
  }
  bad += 1;
  console.error(`[vendor] FAIL ${rel} has drifted from packages/client/src/index.ts`);
  console.error(`         cp ${path.relative(root, source)} ${rel}`);
  if (b === null) continue;
  const la = a.split("\n");
  const lb = b.split("\n");
  for (let i = 0; i < Math.max(la.length, lb.length); i++) {
    if (la[i] !== lb[i]) {
      console.error(`         first difference at line ${i + 1}`);
      console.error(`           source:   ${(la[i] ?? "<end of file>").trim().slice(0, 90)}`);
      console.error(`           vendored: ${(lb[i] ?? "<end of file>").trim().slice(0, 90)}`);
      break;
    }
  }
}
process.exit(bad ? 1 : 0);
