/**
 * Runs the whole suite against every published tour, one after another, and
 * prints a table of what passed. A tour is only as good as the checks it clears.
 */
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const TOURS_DIR = "/Applications/MAMP/htdocs/timetravel/content/tours";
const only = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const tours = (only.length ? only : fs.readdirSync(TOURS_DIR)).filter((t) => fs.existsSync(path.join(TOURS_DIR, t, "manifest.json")));

const SUITE = [
  ["script", "apps/playground/tools/checks/p9-script.cjs"],
  ["gates", "apps/playground/tools/checks/p2-gate.cjs"],
  ["stills", "apps/playground/tools/checks/p6-pausebg.cjs"],
  ["points", "apps/playground/tools/checks/p7-hotspot-audio.cjs"],
  ["circle", "apps/playground/tools/checks/p8-circle-seam.cjs"],
  ["full", "apps/playground/tools/validate-ui.cjs"],
];

const rows = [];
for (const tour of tours) {
  const manifest = JSON.parse(fs.readFileSync(path.join(TOURS_DIR, tour, "manifest.json"), "utf8"));
  const row = { tour, title: manifest.title, year: manifest.year, results: {} };
  for (const [name, script] of SUITE) {
    if (only.includes("--fast") && name === "full") continue;
    try {
      const out = execFileSync("node", [script, ], {
        env: { ...process.env, TOUR: tour },
        encoding: "utf8",
        timeout: 20 * 60_000,
      });
      const pass = (out.match(/PASS/g) || []).length;
      const fail = (out.match(/FAIL/g) || []).length;
      row.results[name] = fail ? `${pass}/${pass + fail} FAIL` : `${pass} ok`;
      if (fail) row.detail = (row.detail || "") + "\n" + out.split("\n").filter((l) => l.includes("FAIL")).join("\n");
    } catch (err) {
      const out = String(err.stdout || "") + String(err.stderr || "");
      const pass = (out.match(/PASS/g) || []).length;
      const fail = (out.match(/FAIL/g) || []).length;
      row.results[name] = fail ? `${pass}/${pass + fail} FAIL` : "ERROR";
      row.detail = (row.detail || "") + "\n" + out.split("\n").filter((l) => /FAIL|Error/.test(l)).slice(0, 6).join("\n");
    }
  }
  rows.push(row);
  console.log(`${row.year}  ${row.title.padEnd(38)} ` + SUITE.map(([n]) => `${n}:${row.results[n] ?? "-"}`).join("  "));
  if (row.detail) console.log(row.detail.trim().split("\n").map((l) => "      " + l).join("\n"));
}
const bad = rows.filter((r) => Object.values(r.results).some((v) => String(v).includes("FAIL") || v === "ERROR"));
console.log(`\n${rows.length - bad.length}/${rows.length} tours fully clean`);
if (bad.length) process.exit(1);
