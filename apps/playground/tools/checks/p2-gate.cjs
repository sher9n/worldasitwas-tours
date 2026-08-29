const { chromium } = require("/Applications/MAMP/htdocs/document-capture-service/node_modules/playwright");
const ok = (n, c, d = "") => console.log(`[p2] ${c ? "PASS" : "FAIL"} ${n}${d ? " · " + d : ""}`) || c;
(async () => {
  const browser = await chromium.launch({ args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] });
  const page = await (await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true })).newPage();
  await page.goto("http://localhost:5173/?tour=tour_london_1850_flower_seller&play=1", { waitUntil: "networkidle" });
  await page.evaluate(() => localStorage.removeItem("tt.hintExplore"));
  await page.waitForSelector(".player .idle");
  await page.click("button.travel");
  let pass = true;
  // Gradual reveal: while she is still early in her arrival line, no dots yet.
  await page.waitForTimeout(2000);
  pass = ok("dots hidden at the start of her line", !(await page.$(".poi"))) && pass;
  // The arrival gates once her line ends: chevron flashes, dots are out by then.
  let chevron = null;
  for (let i = 0; i < 90 && !chevron; i++) { await page.waitForTimeout(500); chevron = await page.$(".side-pane.right"); }
  pass = ok("arrival gates (right chevron)", Boolean(chevron)) && pass;
  pass = ok("dots revealed by gate time", Boolean(await page.$(".poi"))) && pass;
  pass = ok("first-time hint shown", Boolean(await page.$(".gate-hint"))) && pass;
  const imgBefore = await page.$eval(".slide img.bg, .slide video.bg", (el) => (el.currentSrc || "").split("/").pop());
  await page.waitForTimeout(4200);
  const imgAfter = await page.$eval(".slide img.bg, .slide video.bg", (el) => (el.currentSrc || "").split("/").pop());
  pass = ok("gate holds the screen", imgBefore === imgAfter, `${imgBefore}`) && pass;
  pass = ok("panes flash and go (gone after ~3s)", !(await page.$(".side-pane"))) && pass;
  const beckon = await page.$eval(".poi", (el) => el.className.includes("beckon"));
  pass = ok("dots beckon while gated", beckon) && pass;
  const parked = await page.$eval(".progress span.cur i", (el) => parseFloat(el.style.width));
  pass = ok("progress parks short of full", parked < 100, `${parked}%`) && pass;
  await page.screenshot({ path: "/Users/sherancorera/.claude/jobs/83f0d0aa/tmp/shots/p2-gate.png" });
  // Advance by edge tap (panes may already be gone); the next screen must gate
  // too (dotted card), and the hint must not repeat.
  const neutral = () => page.evaluate(() => {
    const blocked = (el) => Boolean(el && el.closest("[data-noadvance]"));
    for (const y of [500, 560, 440, 380]) for (const x of [330, 300, 350, 280]) if (!blocked(document.elementFromPoint(x, y))) return { x, y };
    return { x: 330, y: 500 };
  });
  {
    const pt = await neutral();
    await page.mouse.click(pt.x, pt.y);
  }
  await page.waitForTimeout(1000);
  let chevron2 = null;
  for (let i = 0; i < 90 && !chevron2; i++) { await page.waitForTimeout(500); chevron2 = await page.$(".side-pane.right"); }
  pass = ok("next screen gates too", Boolean(chevron2)) && pass;
  pass = ok("hint shows only once", !(await page.$(".gate-hint"))) && pass;
  pass = ok("back pane flashes past the first screen", Boolean(await page.$(".side-pane.left"))) && pass;
  // Tap feedback: a side tap flashes its pane like a reel.
  {
    const pt = await neutral();
    await page.mouse.click(pt.x, pt.y);
  }
  await page.waitForTimeout(120);
  pass = ok("side tap flashes the pane", Boolean(await page.$(".side-flash.right"))) && pass;
  await page.waitForTimeout(800);
  pass = ok("flash melts away", !(await page.$(".side-flash"))) && pass;
  await browser.close();
  if (!pass) process.exit(1);
})().catch((e) => { console.error("[p2] FAIL", e.message); process.exit(1); });
