// Records reading a saved battle's verdict down to the scorecard, then typing a follow-up.
// Usage: node record-saved.mjs <port> <battleId> <outDir>
import { chromium } from "playwright";
import { writeFileSync } from "node:fs";

const [port, id, outDir] = process.argv.slice(2);
const FOLLOW_UP = "What should a beginner learn first, then?";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1280, height: 800 },
  colorScheme: "light",
  recordVideo: { dir: outDir, size: { width: 1280, height: 800 } },
});
const page = await context.newPage();
const t0 = Date.now();
await page.goto(`http://localhost:${port}/#/b/${encodeURIComponent(id)}`);
await page.waitForSelector(".verdict");
await page.evaluate(() => document.querySelector(".verdict").scrollIntoView({ block: "start" }));
await page.evaluate(() => window.scrollBy(0, -80));
const ready = (Date.now() - t0) / 1000;

async function glideTo(selector, offset = 80, ms = 1100) {
  const from = await page.evaluate(() => scrollY);
  const to = await page.evaluate(([s, o]) => document.querySelector(s).getBoundingClientRect().top + scrollY - o, [selector, offset]);
  const steps = Math.round(ms / 16);
  for (let i = 1; i <= steps; i++) {
    const p = i / steps;
    const e = p < 0.5 ? 2 * p * p : 1 - (-2 * p + 2) ** 2 / 2; // ease in-out
    await page.evaluate((y) => window.scrollTo(0, y), from + (to - from) * e);
    await sleep(16);
  }
}

await sleep(4000); // answer + winner
await glideTo("section.two");
await sleep(4500); // agreed / still debated
await page.evaluate(() => document.querySelectorAll("section.card h2").forEach((h) => h.textContent.trim() === "Scorecard" && h.closest("section").setAttribute("data-demo", "score")));
await glideTo("[data-demo=score]", 70, 1300);
await sleep(4500); // scorecard
await page.click("#follow");
await page.keyboard.type(FOLLOW_UP, { delay: 45 });
await sleep(2500);
await context.close();
await browser.close();
writeFileSync(`${outDir}/marks.json`, JSON.stringify({ ready }));
console.log("ready at", ready);
