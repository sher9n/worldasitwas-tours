const { chromium } = require("/Applications/MAMP/htdocs/document-capture-service/node_modules/playwright");
(async () => {
  const browser = await chromium.launch({ args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] });
  const page = await (await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true })).newPage();
  await page.goto(`http://localhost:5173/?tour=${TOUR}&play=1`, { waitUntil: "networkidle" });
  await page.waitForSelector(".player .idle", { timeout: 90000 });
  await page.click("button.travel");
  // tap to the walk screen
  const neutralTap = async () => { const pt = await page.evaluate(() => { const b=(el)=>Boolean(el&&el.closest("[data-noadvance]")); for (const y of [620,560,500]) for (const x of [340,300]) if (!b(document.elementFromPoint(x,y))) return {x,y}; return {x:340,y:620}; }); await page.mouse.click(pt.x, pt.y); };
  let onWalk = false;
  for (let i = 0; i < 10 && !onWalk; i++) { await neutralTap(); await page.waitForTimeout(600); onWalk = Boolean(await page.$(".walk-dots")); }
  if (!onWalk) { console.log("[p1] FAIL never reached walk dots"); process.exit(1); }
  const anims = await page.$$eval(".walk-dots span", (els) => els.map((e) => getComputedStyle(e).animationName));
  const info = await page.evaluate(() => {
    const dots = [...document.querySelectorAll(".walk-dots span")];
    const stops = Number((document.querySelector(".walk-dots").getAttribute("aria-label") || "of 0").split("of ")[1]);
    return { count: dots.length, stops, onIndex: dots.findIndex((d) => d.classList.contains("on")) };
  });
  const TOUR = process.env.TOUR || "tour_london_1850_flower_seller";
const ok = anims.every((a) => a === "none") && info.count === info.stops && info.onIndex >= 1;
  console.log(`[p1] ${ok ? "PASS" : "FAIL"} stop-indicator dots · animations:${anims.join(",")} · ${JSON.stringify(info)}`);
  await page.screenshot({ path: "/Users/sherancorera/.claude/jobs/83f0d0aa/tmp/shots/p1-walk-dots.png" });
  await browser.close();
  if (!ok) process.exit(1);
})().catch((e) => { console.error("[p1] FAIL", e.message); process.exit(1); });
