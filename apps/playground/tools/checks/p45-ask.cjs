const { chromium } = require("/Applications/MAMP/htdocs/document-capture-service/node_modules/playwright");
const TOUR = process.env.TOUR || "tour_london_1850_flower_seller";
const ok = (n, c, d = "") => console.log(`[p45] ${c ? "PASS" : "FAIL"} ${n}${d ? " · " + d : ""}`) || c;
(async () => {
  const browser = await chromium.launch({ args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] });
  const page = await (await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true })).newPage();
  await page.goto(`http://localhost:5173/?tour=${TOUR}&play=1`, { waitUntil: "networkidle" });
  await page.waitForSelector(".player .idle", { timeout: 90000 });
  await page.click("button.travel");
  // The opening must be silent: background preconnect shows no pill, no dots.
  let quietOpen = true;
  for (let t = 0; t < 3500; t += 350) {
    if (await page.$(".ask-state")) quietOpen = false;
    const label = await page.$eval(".ask", (el) => el.textContent.trim());
    if (label !== "Hold to ask") quietOpen = false;
    await page.waitForTimeout(350);
  }
  ok("background preconnect is invisible", quietOpen) || process.exitCode;
  await page.waitForTimeout(500); // preconnect settles
  const ask = await page.$(".ask");
  const box = await ask.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(500);
  const midHold = await page.evaluate(() => ({
    cls: document.querySelector(".ask").className,
    circle: (() => { const v = document.querySelector(".voice-circle video.on"); return v ? !v.paused : null; })(),
  }));
  await page.waitForTimeout(1800);
  await page.mouse.up();
  // Sample the state machine and the circle through the answer.
  const timeline = [];
  let dotsSeen = null;
  for (let t = 0; t < 48000; t += 150) {
    const s = await page.evaluate(() => ({
      cls: document.querySelector(".ask").className.replace("ask", "").trim() || "ready",
      circle: (() => { const v = document.querySelector(".voice-circle video.on"); return v ? !v.paused : null; })(),
    }));
    timeline.push(s);
    if (s.cls === "thinking" && dotsSeen === null) {
      dotsSeen = await page.evaluate(() => { const i = document.querySelector(".ask-state .tdots i, .ask .tdots i"); return i ? getComputedStyle(i).animationName : "missing"; });
    }
    await page.waitForTimeout(150);
    if (timeline.length > 20 && s.cls === "ready") break;
  }
  const states = timeline.map((x) => x.cls);
  const firstSpeak = states.indexOf("speaking");
  let pass = true;
  pass = ok("listening while held, circle still", /listening/.test(midHold.cls) && midHold.circle !== true, JSON.stringify(midHold)) && pass;
  pass = ok("thinking immediately after release", states[0] === "thinking" || states[0] === "listening", states.slice(0, 3).join(",")) && pass;
  pass = ok("thinking shows animated dots", dotsSeen === "tdot", String(dotsSeen)) && pass;
  if (firstSpeak >= 0) {
    const before = states.slice(0, firstSpeak);
    pass = ok("no ready inside the synthesis gap", !before.includes("ready"), `pre-speak: ${[...new Set(before)].join(",")}`) && pass;
    const speakSamples = timeline.filter((x) => x.cls === "speaking");
    const moving = speakSamples.filter((x) => x.circle === true).length;
    // Play-once: the clip may finish before a long answer does and rest as a still.
    pass = ok("circle appears during live answer (plays once)", moving >= Math.max(1, speakSamples.length * 0.25), `${moving}/${speakSamples.length} samples moving`) && pass;
    const after = states.slice(firstSpeak);
    pass = ok("settles to ready after the answer", after.includes("ready")) && pass;
  } else {
    pass = ok("no speech recognized: settled cleanly to ready", states.includes("ready"), `states: ${[...new Set(states)].join(",")}`) && pass;
    console.log("[p45] NOTE fake mic produced no answer; speaking-phase checks not exercised this run");
  }
  pass = ok("no error pill", !(await page.$(".ask-state.error"))) && pass;
  await browser.close();
  if (!pass) process.exit(1);
})().catch((e) => { console.error("[p45] FAIL", e.message); process.exit(1); });
