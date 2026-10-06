// Records a real comparison, then a debate of it, in the battler web app for the README demo.
// Usage: node scripts/demo/record-web.mjs <port> <outDir>
// Uses the Chrome you have (playwright-core is a dev dependency). Waiting is sped up afterwards by
// edit.sh, using the "waits" marks written next to the video.
import { chromium } from "playwright-core";
import { writeFileSync } from "node:fs";

const [port = "4850", outDir = "./video"] = process.argv.slice(2);
const TOPIC = "Is it still worth learning to code in 2026, now that AI writes most code?";

const t0 = Date.now();
const now = () => (Date.now() - t0) / 1000;
const marks = { waits: [] };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({ channel: "chrome" });
const context = await browser.newContext({
  viewport: { width: 1280, height: 800 },
  deviceScaleFactor: 1,
  colorScheme: "light",
  recordVideo: { dir: outDir, size: { width: 1280, height: 800 } },
});
const page = await context.newPage();

async function smoothScroll(total, steps = 30, pause = 30) {
  for (let i = 0; i < steps; i++) {
    await page.mouse.wheel(0, total / steps);
    await sleep(pause);
  }
}
async function wait(selector, timeout) {
  const start = now();
  await page.waitForSelector(selector, { timeout });
  marks.waits.push([start + 1.5, now() + 0.3]);
}

await page.goto(`http://localhost:${port}/`);
await page.waitForSelector("#topic");
await sleep(1200);
marks.typing = now();
await page.click("#topic");
await page.keyboard.type(TOPIC, { delay: 36 });
await sleep(700);
await page.click('[data-mode="compare"]');
await sleep(1100);
await page.click("#start");

// 1. Everyone's answer, side by side.
await wait("#debate-it", 6 * 60_000);
await sleep(600);
await page.evaluate(() => window.scrollTo({ top: 0 }));
await sleep(1500);
await smoothScroll(420, 30, 35);
await sleep(2500);

// 2. Have them debate it: rebuttals, then the blind judges.
await page.click("#debate-it");
await wait("#verdict-slot .verdict", 12 * 60_000);
await sleep(600);
await page.evaluate(() => window.scrollTo({ top: 0 }));
await sleep(1200);
const vy = await page.evaluate(() => document.querySelector("#verdict-slot").getBoundingClientRect().top + scrollY - 70);
await smoothScroll(vy, 20, 25);
await sleep(3500);
await smoothScroll(400, 30, 40);
await sleep(2500);
await smoothScroll(420, 30, 40);
await sleep(2500);

// 3. Share: the image card.
await page.click(".followbar #share");
await page.waitForSelector(".share-dialog[open] img");
await sleep(4000);
marks.end = now();

await context.close();
await browser.close();
writeFileSync(`${outDir}/marks.json`, JSON.stringify(marks, null, 2));
console.log(JSON.stringify(marks));
