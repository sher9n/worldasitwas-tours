/**
 * The check that would have caught the black page: every chats cell must sit
 * INSIDE the table, and the console's own furniture must be the thing you
 * actually see at its coordinates (nothing stretched over the top of it).
 */
const { chromium } = require("/Applications/MAMP/htdocs/document-capture-service/node_modules/playwright");
const BASE = process.env.BASE || "http://localhost:5173";
(async () => {
  const b = await chromium.launch();
  let bad = 0;
  for (const width of [1280, 1024, 1600]) {
  const ctx = await b.newContext({ viewport: { width, height: 800 }, deviceScaleFactor: 2 });
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
    // Scroll it into view first: the console is a wide layout, and a point
    // outside the viewport is not "covered", it is just off-screen.
    const at = (el) => { if (!el) return "missing"; el.scrollIntoView({ block: "center", inline: "center" }); const b = el.getBoundingClientRect();
      const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
      return hit === el || el.contains(hit) ? "visible" : `covered by <${hit ? hit.tagName.toLowerCase() : "none"}${hit && hit.className ? "." + hit.className : ""}>`; };
    // Fixed columns don't move for content: text wider than its column paints
    // over the neighbour (or gets clipped). Either way the column is too narrow.
    let overlap = null;
    for (const tr of document.querySelectorAll(".chats tbody tr, .chats thead tr"))
      for (const [i, c] of [...tr.children].entries())
        if (c.scrollWidth > c.clientWidth + 1)
          overlap = `col ${i} content ${c.scrollWidth}px in ${c.clientWidth}px: "${c.textContent.slice(0, 20)}"`;
    return {
      inside,
      overlap,
      rows: document.querySelectorAll(".chats tbody tr").length,
      walkText: cell ? cell.textContent : null,
      brand: at(document.querySelector(".pg-head .pg-brand") || document.querySelector(".pg-head")),
      tabs: at(document.querySelector(".tabs")),
      table: at(table),
    };
  });
  console.log(width + ":", JSON.stringify(r));
  if (width === 1280) await p.screenshot({ path: process.env.SHOT || "/Users/sherancorera/.claude/jobs/83f0d0aa/tmp/chats-geo.png" });
  if (r.inside !== true || r.overlap || r.brand !== "visible" || r.tabs !== "visible") bad++;
  await ctx.close();
  }
  await b.close();
  if (bad) { console.log("FAIL: layout leak at " + bad + " width(s)"); process.exit(1); }
  console.log("PASS: every width, cells inside the table, no content wider than its column");
})();
