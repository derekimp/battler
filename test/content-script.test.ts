// The extension's content script is a plain browser script; load it with just enough of a page
// around it to reach its test hook.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { ROOT } from "./helpers.ts";

function driver(hostname: string) {
  const g = globalThis as any;
  const saved = { window: g.window, location: g.location };
  g.window = {};
  g.location = { hostname };
  try {
    new Function(readFileSync(join(ROOT, "extension", "content.js"), "utf8"))();
    return g.window.__battlerDriver;
  } finally {
    g.window = saved.window;
    g.location = saved.location;
  }
}

test("site notices are refused instead of entering the debate as an answer", () => {
  const { checked } = driver("chatgpt.com");
  for (const notice of [
    "You've reached our limit of messages per hour. Please try again later.",
    "Something went wrong. If this issue persists please contact us.",
    "Too many requests in 1 hour. Try again later.",
    "You've hit your usage limit. Upgrade to Pro to continue.",
  ]) {
    assert.throws(() => checked(notice), /the site showed a notice instead of an answer/, notice);
  }
  assert.equal(checked("## Position\nUse spaces."), "## Position\nUse spaces.");
  const longAnswer = "A real answer that mentions rate limits in passing. ".repeat(20);
  assert.equal(checked(longAnswer), longAnswer, "long answers are never treated as notices");
});

test("every supported site has a driver; others are left alone", () => {
  for (const host of ["chatgpt.com", "claude.ai", "gemini.google.com", "cursor.com"]) assert.ok(driver(host), host);
  assert.equal(driver("example.com"), undefined);
});
