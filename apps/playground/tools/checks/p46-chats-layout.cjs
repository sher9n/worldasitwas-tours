/**
 * The check that would have caught the black page: every chats cell must sit
 * INSIDE the table, and the console's own furniture must be the thing you
 * actually see at its coordinates (nothing stretched over the top of it).
 */
const { chromium } = require("/Applications/MAMP/htdocs/document-capture-service/node_modules/playwright");
const BASE = process.env.BASE || "http://localhost:5173";
(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
  const p = await ctx.newPage();
  if (BASE.startsWith("https")) await p.goto(`${BASE}/bypass`, { waitUntil: "networkidle" });
  await p.goto(`${BASE}/chats`, { waitUntil: "networkidle" });
  await p.waitForTimeout(2500);
  const r = await p.evaluate(() => {
    const cell = document.querySelector(".chats td.c-walk");
    const table = document.querySelector(".chats table");
    const inside = cell && table ? (() => {
      const c = cell.getBoundingClientRect(), t = table.getBoundingClientRect();
      return c.left >= t.left - 1 && c.top >= t.top - 1 && c.right <= t.right + 1;
    })() : null;
    // What is actually visible where the brand and the tab bar are drawn?
    const at = (el) => { if (!el) return "missing"; const b = el.getBoundingClientRect();
      const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
      return hit === el || el.contains(hit) ? "visible" : `covered by .${(hit && hit.className) || "?"}`; };
    return {
      inside,
      rows: document.querySelectorAll(".chats tbody tr").length,
      walkText: cell ? cell.textContent : null,
      brand: at(document.querySelector(".pg-head .pg-brand") || document.querySelector(".pg-head")),
      tabs: at(document.querySelector(".tabs")),
      table: at(table),
    };
  });
  console.log(JSON.stringify(r));
  await p.screenshot({ path: process.env.SHOT || "/Users/sherancorera/.claude/jobs/83f0d0aa/tmp/chats-geo.png" });
  await b.close();
  if (r.inside !== true || r.brand !== "visible" || r.tabs !== "visible") { console.log("FAIL: layout leak"); process.exit(1); }
  console.log("PASS: cells inside the table, console furniture visible");
})();
