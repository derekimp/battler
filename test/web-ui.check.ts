// The web app in a real browser (the Chrome already installed), against `battler serve` driving the
// fake CLIs. Run with `npm run test:web`. Set CHROME_PATH to use another Chromium-based browser.
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { chromium, type Browser, type Page } from "playwright-core";
import { startServer } from "../src/server.ts";
import { FAKE_BIN } from "./helpers.ts";

const savedEnv = { ...process.env };
let browser: Browser;
let server: ReturnType<typeof startServer>;
let base: string;
let gistInput: string;
const problems: string[] = [];

/** A stand-in for `gh` that records what it was asked to upload. */
function fakeGh(): string {
  const dir = mkdtempSync(join(tmpdir(), "gh-"));
  gistInput = join(dir, "input.md");
  const bin = join(dir, "gh");
  writeFileSync(
    bin,
    `#!/usr/bin/env node
let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
  require("fs").writeFileSync(${JSON.stringify(gistInput)}, s);
  console.log("https://gist.github.com/someone/abc123");
});`,
  );
  chmodSync(bin, 0o755);
  return bin;
}

before(async () => {
  process.env.PATH = `${FAKE_BIN}:${savedEnv.PATH}`;
  process.env.FAKE_DELAY_MS = "120";
  process.env.FAKE_RICH = "1";
  const outDir = join(mkdtempSync(join(tmpdir(), "web-ui-")), "battles");
  server = startServer({ port: 0, host: "127.0.0.1", outDir, config: {}, gh: fakeGh() });
  await new Promise<void>((r) => server.once("listening", () => r()));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
  browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: "chrome" });
});

after(async () => {
  await browser?.close();
  server?.stopAll();
  server?.close();
  process.env = { ...savedEnv };
  assert.deepEqual(problems, [], "no errors in the page console");
});

/** `expected`: a request the test makes fail on purpose (e.g. "404"), so its console error is fine. */
async function open(path = "/", viewport = { width: 1280, height: 900 }, expected?: string): Promise<Page> {
  const context = await browser.newContext({ viewport, acceptDownloads: true });
  const page = await context.newPage();
  page.on("pageerror", (e) => problems.push(`${path}: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error" && !(expected && m.text().includes(`status of ${expected}`))) problems.push(`${path}: ${m.text()}`);
  });
  await page.goto(base + path);
  return page;
}

const verdict = (page: Page) => page.waitForSelector("#verdict-slot .verdict", { timeout: 30_000 });
const historyCount = (page: Page) => page.locator("#history a").count();

test("home: the AIs' status, and Start waits for a topic", async () => {
  const page = await open();
  await page.waitForSelector("#status-text:not(:has-text('Checking'))");
  assert.match(await page.textContent("#status-text") ?? "", /3 of 4 AIs ready/);
  assert.ok(await page.isDisabled('[data-id="gemini"]'), "Gemini isn't installed, so it can't be picked");
  assert.ok(await page.isDisabled("#start"));
  await page.fill("#topic", "Tabs or spaces?");
  assert.ok(await page.isEnabled("#start"));
  assert.match(await page.textContent("#cost") ?? "", /About 9 AI calls/);
  // Rounds are right there, not tucked into More options.
  assert.ok(await page.isVisible("#rounds-row .stepper"));
  await page.click('[data-step="1"]');
  assert.equal(await page.textContent("#rounds"), "3");
  assert.match(await page.textContent("#rounds-hint") ?? "", /Two rebuttals/);
  assert.match(await page.textContent("#cost") ?? "", /About 12 AI calls/);
  await page.click('[data-step="-1"]');
  await page.click('[data-id="codex"]');
  assert.match(await page.textContent("#cost") ?? "", /About 6 AI calls/);
  await page.click('[data-id="grok"]');
  assert.match(await page.textContent("#cost") ?? "", /Pick at least 2/);
  assert.ok(await page.isDisabled("#start"));
  await page.context().close();
});

test("a debate runs live, ends with a verdict, and is saved; the topic is shown as text, not HTML", async () => {
  const page = await open();
  const topic = `<img src=x onerror="window.__xss=1"> Tabs or spaces?`;
  await page.waitForSelector("#start");
  await page.fill("#topic", topic);
  await page.click("#start");
  await page.waitForSelector(".round-live");
  await verdict(page);
  assert.match(page.url(), /#\/b\//);
  assert.equal(await page.textContent(".battle-head h1"), topic);
  assert.equal(await page.evaluate(() => (window as any).__xss), undefined);
  assert.equal(await page.locator(".timeline li.done").count(), 3, "opening, round 2 and verdict all done");
  assert.match(await page.textContent("#verdict-slot") ?? "", /modular monolith/i);
  assert.equal(await historyCount(page), 1);
  assert.ok(await page.isVisible(".followbar"));
  await page.context().close();
});

test("a follow-up and another round, from the bar under a battle", async () => {
  const page = await open();
  await page.click("#history a");
  await page.waitForSelector(".followbar #follow");
  await page.fill("#follow", "What about YAML files?");
  await page.click(".followbar button[type=submit]");
  await page.waitForSelector(".battle-head .followup");
  assert.match(await page.textContent(".battle-head .followup") ?? "", /Follow-up to:.*Tabs or spaces/);
  await verdict(page);
  assert.equal(await page.textContent(".battle-head h1"), "What about YAML files?");

  await page.waitForSelector(".followbar #more");
  await page.click(".followbar #more");
  await page.waitForSelector('.timeline li[data-step="r3"]');
  await verdict(page);
  // A finished battle keeps its verdict; the longer debate is saved next to it.
  assert.equal(await historyCount(page), 3);
  await page.context().close();
});

test("compare mode shows the answers side by side, then 'Have them debate it' makes it a battle in place", async () => {
  const page = await open();
  await page.waitForSelector("#start");
  const before = await historyCount(page);
  await page.click('[data-mode="compare"]');
  assert.ok(await page.isHidden("#more-options"), "no judges to choose");
  assert.ok(await page.isHidden("#rounds-row"), "no rounds to choose");
  assert.match(await page.textContent("#cost") ?? "", /About 3 AI calls/);
  assert.match(await page.textContent("#start") ?? "", /Compare answers/);
  await page.fill("#topic", "Best way to learn SQL?");
  await page.click("#start");
  await page.waitForSelector("#debate-it", { timeout: 30_000 });
  assert.equal(await page.locator("#verdict-slot .turn").count(), 3);
  assert.equal(await page.locator(".timeline li").count(), 1, "no verdict step");
  assert.equal(await historyCount(page), before + 1);
  assert.match(await page.locator("#history a").first().textContent() ?? "", /answers compared/);

  // The share image of a comparison: a column per AI.
  await page.click(".followbar #share");
  await page.waitForSelector(".share-dialog[open] img");
  assert.equal(await page.evaluate(() => document.querySelector<HTMLImageElement>(".share-dialog img")!.naturalWidth), 2400);
  await page.keyboard.press("Escape");
  await page.waitForSelector(".share-dialog", { state: "detached" });

  await page.click("#debate-it");
  await verdict(page);
  assert.equal(await historyCount(page), before + 1, "the same entry, now a full battle");
  assert.doesNotMatch(await page.locator("#history a").first().textContent() ?? "", /answers compared/);
  await page.context().close();
});

test("share: an image to download, and a link made with gh", async () => {
  const page = await open();
  await page.click("#history a");
  await page.waitForSelector(".followbar #share");
  await page.click(".followbar #share");
  await page.waitForSelector(".share-dialog[open] img");
  const size = await page.evaluate(() => {
    const img = document.querySelector<HTMLImageElement>(".share-dialog img")!;
    return [img.naturalWidth, img.naturalHeight];
  });
  assert.deepEqual(size, [2400, 1350], "1200×675 at 2x");

  const [download] = await Promise.all([page.waitForEvent("download"), page.click("#share-download")]);
  assert.match(download.suggestedFilename(), /^battler-.*\.png$/);
  const png = readFileSync((await download.path())!);
  assert.equal(png.subarray(1, 4).toString(), "PNG");

  await page.click("#share-link");
  await page.waitForSelector("#share-note a");
  assert.equal(await page.getAttribute("#share-note a", "href"), "https://gist.github.com/someone/abc123");
  assert.match(readFileSync(gistInput, "utf8"), /Made with \[battler\]/);
  await page.keyboard.press("Escape");
  await page.waitForSelector(".share-dialog", { state: "detached" });
  await page.context().close();
});

test("when judging fails, the rounds are kept and 'Judge the rounds so far' finishes the battle", async () => {
  process.env.FAKE_FAIL_JUDGE = "1";
  const page = await open();
  await page.waitForSelector("#start");
  await page.fill("#topic", "Will judging work?");
  await page.click("#start");
  await page.waitForSelector(".error-card #finish", { timeout: 30_000 });
  assert.match(await page.textContent(".error-card") ?? "", /couldn't finish/);
  delete process.env.FAKE_FAIL_JUDGE;
  await page.click("#finish");
  await verdict(page);
  await page.waitForFunction(() => !document.querySelector("#history")?.textContent?.includes("interrupted"));
  await page.context().close();
});

test("a running battle can be stopped", async () => {
  process.env.FAKE_DELAY_MS = "4000";
  const page = await open();
  await page.waitForSelector("#start");
  await page.fill("#topic", "Will this be stopped?");
  await page.click("#start");
  await page.waitForSelector("#cancel");
  await page.click("#cancel");
  await page.waitForSelector(".error-card");
  assert.match(await page.textContent(".error-card h2") ?? "", /Battle stopped/);
  process.env.FAKE_DELAY_MS = "120";
  await page.context().close();
});

test("an unknown battle or a bad address shows a message, not a blank page", async () => {
  const page = await open("/#/b/does-not-exist", undefined, "404");
  await page.waitForSelector(".battle-head h1");
  assert.match(await page.textContent(".battle-head h1") ?? "", /not found/i);
  await page.goto(`${base}/#/whatever`);
  await page.waitForSelector("#topic");
  await page.context().close();
});

test("on a phone: no sideways scrolling, and history opens as a drawer", async () => {
  const page = await open("/", { width: 375, height: 812 });
  await page.waitForSelector("#topic");
  const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok((await overflow()) <= 0, "home fits");
  await page.click("#open-sidebar");
  await page.waitForSelector("#sidebar.open");
  await page.click("#history a");
  await page.waitForSelector("#sidebar:not(.open)");
  await page.waitForSelector(".followbar");
  assert.ok((await overflow()) <= 0, "a saved battle fits");
  await page.context().close();
});

test("the API refuses requests from other sites", async () => {
  const page = await open("/", undefined, "403");
  const status = await page.evaluate(async () => (await fetch("/api/battles", { method: "POST", body: "{}" })).status);
  assert.equal(status, 403, "no X-Battler header, no battle");
  await page.context().close();
});
