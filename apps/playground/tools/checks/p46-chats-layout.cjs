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
    const panel = document.querySelector(".chats");
    // Scroll it into view first: the console is a wide layout, and a point
    // outside the viewport is not "covered", it is just off-screen.
    const at = (el) => { if (!el) return "missing"; el.scrollIntoView({ block: "center", inline: "center" }); const b = el.getBoundingClientRect();
      const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
      return hit === el || el.contains(hit) ? "visible" : `covered by <${hit ? hit.tagName.toLowerCase() : "none"}${hit && hit.className ? "." + hit.className : ""}>`; };
    // Nothing in the ledger may be wider than the panel that holds it, and no
    // card may escape it: both are how a stray class blows the layout open.
    let spill = null;
    if (panel) {
      const pb = panel.getBoundingClientRect();
      if (panel.scrollWidth > panel.clientWidth + 1) spill = `panel content ${panel.scrollWidth}px in ${panel.clientWidth}px`;
      for (const el of panel.querySelectorAll(".c-turn, .c-q, .c-a, .c-meta")) {
        const b = el.getBoundingClientRect();
        if (b.right > pb.right + 1 || b.left < pb.left - 1) spill = `${el.className} escapes the panel`;
        if (el.scrollWidth > el.clientWidth + 1) spill = `${el.className} content ${el.scrollWidth}px in ${el.clientWidth}px`;
      }
    }
    const answer = panel && panel.querySelector(".c-a");
    return {
      spill,
      cards: document.querySelectorAll(".chats .c-turn").length,
      // How much of the answer fits per line: the ribbon bug made this ~2 words.
      answerWidth: answer ? Math.round(answer.getBoundingClientRect().width) : null,
      brand: at(document.querySelector(".pg-head .pg-brand") || document.querySelector(".pg-head")),
      tabs: at(document.querySelector(".tabs")),
      list: at(document.querySelector(".chats-list")),
    };
  });
  console.log(width + ":", JSON.stringify(r));
  if (width === 1280) await p.screenshot({ path: process.env.SHOT || "/Users/sherancorera/.claude/jobs/83f0d0aa/tmp/chats-geo.png" });
  if (r.spill || r.cards < 1 || (r.answerWidth && r.answerWidth < 260) || r.brand !== "visible" || r.tabs !== "visible") bad++;
  await ctx.close();
  }
  await b.close();
  if (bad) { console.log("FAIL: layout leak at " + bad + " width(s)"); process.exit(1); }
  console.log("PASS: every width, cards inside the panel, answer column readable");
})();
