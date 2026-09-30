import assert from "node:assert/strict";
import { test } from "node:test";
import { isTransient, looksOffline } from "../src/core/errors.ts";

test("hiccups are retried; problems that would fail again are not", () => {
  for (const msg of [
    "codex exited with code 1: Error: read ECONNRESET",
    "claude: API Error: 529 overloaded",
    "claude: API Error: 503 Service Unavailable",
    "cursor-agent: fetch failed",
    "ChatGPT: the site showed a notice instead of an answer: \"Something went wrong. Try again.\"",
    "ChatGPT: timed out waiting for the reply to start. The message may not have been sent",
  ]) {
    assert.ok(isTransient(new Error(msg)), msg);
  }
  for (const msg of [
    "you've hit your codex subscription usage limit. Try again later",
    "claude: not logged in. Run `battler --doctor` for instructions",
    "`gemini` not found on PATH; install Gemini CLI",
    "the configured model isn't available to your cursor-agent login",
    "the Claude tab was closed or reloaded",
    "Battle aborted",
    "codex: 429 Too Many Requests",
  ]) {
    assert.ok(!isTransient(new Error(msg)), msg);
  }
});

test("offline-looking errors", () => {
  assert.ok(looksOffline("getaddrinfo ENOTFOUND api.anthropic.com"));
  assert.ok(looksOffline(new Error("fetch failed")));
  assert.ok(!looksOffline("usage limit"));
});
