// Records a real battle in the battler web app for the README demo.
// Usage: node record.mjs <port> <outDir>
import { chromium } from "playwright";
import { writeFileSync } from "node:fs";

const [port = "4850", outDir = "./video"] = process.argv.slice(2);
const TOPIC = "Is it still worth learning to code in 2026, now that AI writes most code?";
const FOLLOW_UP = "What should a beginner learn first, then?";

const t0 = Date.now();
const marks = {};
const mark = (name) => (marks[name] = (Date.now() - t0) / 1000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch();
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

await page.goto(`http://localhost:${port}/`);
await page.waitForSelector("#topic");
await sleep(1500);
mark("typing");
await page.click("#topic");
await page.keyboard.type(TOPIC, { delay: 38 });
await sleep(900);
mark("start");
await page.click("#start");

// Live progress: stay near the top, where new rounds and then the verdict appear.
await page.waitForSelector(".round-live", { timeout: 60_000 });
mark("live");
await page.waitForSelector("#verdict-slot .verdict", { timeout: 12 * 60_000 });
mark("verdict");
await sleep(600);
await page.evaluate(() => window.scrollTo({ top: 0 }));
await sleep(2500);

// Read the verdict: answer and winner, then agreed / still debated, then the scorecard.
const vy = await page.evaluate(() => document.querySelector("#verdict-slot").getBoundingClientRect().top + scrollY - 70);
await smoothScroll(vy, 20, 25);
await sleep(3500);
await smoothScroll(380, 30, 40);
await sleep(3000);
await smoothScroll(420, 30, 40);
await sleep(3000);

// Show the follow-up bar with a question typed (not sent, so no second battle runs).
mark("followup");
await page.click("#follow");
await page.keyboard.type(FOLLOW_UP, { delay: 45 });
await sleep(2500);
mark("end");

await context.close();
await browser.close();
writeFileSync(`${outDir}/marks.json`, JSON.stringify(marks, null, 2));
console.log(JSON.stringify(marks));
