import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import {
  agentFromSpec,
  claudeAgent,
  codexAgent,
  cursorAgent,
  cursorGrokAgent,
  explain,
  familyName,
  subscriptionEnv,
} from "../src/adapters/cli-agents.ts";
import { FAKE_BIN } from "./helpers.ts";

const saved = { ...process.env };
let log: string;

beforeEach(() => {
  process.env.PATH = `${FAKE_BIN}:${saved.PATH}`;
  log = join(mkdtempSync(join(tmpdir(), "battler-test-")), "calls.jsonl");
  process.env.FAKE_LOG = log;
});
afterEach(() => {
  process.env = { ...saved };
});

const calls = () =>
  readFileSync(log, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as { cli: string; args: string[] });

test("each adapter returns the CLI's answer", async () => {
  assert.equal(await claudeAgent().ask("hi"), "## Position\nclaude[default] opening position.\n## Confidence\n70%");
  assert.match(await codexAgent("gpt-5.5").ask("hi"), /codex\[gpt-5\.5\] opening/);
  assert.match(await cursorGrokAgent().ask("hi"), /cursor\[grok-4\.7-medium\] opening/);
});

test("API keys never reach the CLIs", async () => {
  process.env.ANTHROPIC_API_KEY = "sk-ant-test";
  process.env.OPENAI_API_KEY = "sk-test";
  process.env.CURSOR_API_KEY = "cur-test";
  for (const agent of [claudeAgent(), codexAgent(), cursorGrokAgent()]) {
    assert.doesNotMatch(await agent.ask("hi"), /LEAKED/, agent.name);
  }
  const env = subscriptionEnv();
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.PATH, process.env.PATH, "everything else is kept");
});

test("CLIs run sandboxed: no tools, read-only, ask mode, in an empty temp dir", async () => {
  await claudeAgent().ask("hi", { system: "SYS" });
  await codexAgent().ask("hi", { system: "SYS" });
  await cursorGrokAgent().ask("hi");
  const [claude, codex, cursor] = calls();
  assert.deepEqual(claude.args.slice(0, 7), ["-p", "--output-format", "json", "--tools", "", "--strict-mcp-config", "--no-session-persistence"]);
  assert.deepEqual(claude.args.slice(7, 9), ["--system-prompt", "SYS"]);
  assert.deepEqual(codex.args.slice(0, 5), ["exec", "--skip-git-repo-check", "--ephemeral", "-s", "read-only"]);
  assert.deepEqual(cursor.args.slice(0, 7), ["-p", "--output-format", "json", "--mode", "ask", "--trust", "--model"]);
});

test("check() reports ready, logged out, and not installed", async () => {
  assert.equal(await claudeAgent().check(), null);
  assert.equal(await codexAgent().check(), null);
  assert.equal(await cursorGrokAgent().check(), null);

  process.env.FAKE_LOGGED_OUT = "claude,codex,cursor-agent";
  assert.match((await claudeAgent().check())!, /not logged in/);
  assert.match((await codexAgent().check())!, /codex login/);
  assert.match((await cursorGrokAgent().check())!, /cursor-agent login/);

  process.env.PATH = "/usr/bin:/bin";
  assert.match((await codexAgent().check())!, /not found on PATH; install Codex CLI/);
});

test("CLI failures become errors with a useful hint", async () => {
  process.env.FAKE_FAIL = "codex";
  await assert.rejects(codexAgent().ask("hi"), /codex exited with code 2: codex: simulated failure/);
  await assert.rejects(cursorAgent("grok-bogus").ask("hi"), /isn't available.*Grok models your Cursor account offers: grok-4\.7-low, grok-4\.7-medium$/s);
});

test("explain() recognises common failure types", () => {
  assert.match(explain("codex", "error: unexpected argument '--ephemeral'"), /command-line interface has probably changed/);
  assert.match(explain("claude", "API Error: 429 Too Many Requests"), /usage limit/);
  assert.match(explain("claude", "Please log in"), /^Please log in$/);
  assert.match(explain("cursor-agent", "Error: Unauthorized"), /not logged in/);
  assert.ok(explain("x", "y".repeat(1000)).length < 320, "long lines are clipped");
});

test("agentFromSpec understands names, aliases, models and cursor:<model>", () => {
  assert.equal(agentFromSpec("claude").id, "claude");
  assert.equal(agentFromSpec("GPT").id, "codex");
  const cursor = agentFromSpec("cursor:claude-sonnet-5-medium");
  assert.deepEqual([cursor.id, cursor.name], ["cursor:claude-sonnet-5-medium", "Claude"]);
  assert.throws(() => agentFromSpec("cursor"), /needs a model/);
  assert.throws(() => agentFromSpec("gemini"), /unknown agent "gemini"/);
});

test("spec models beat config models", async () => {
  await agentFromSpec("grok", { grok: "grok-4.7-high" }).ask("hi");
  await agentFromSpec("grok:grok-4.7-low", { grok: "grok-4.7-high" }).ask("hi");
  assert.deepEqual(calls().map((c) => c.args[c.args.indexOf("--model") + 1]), ["grok-4.7-high", "grok-4.7-low"]);
});

test("familyName maps Cursor model ids to a family", () => {
  assert.equal(familyName("cursor-grok-4.6-high"), "Grok");
  assert.equal(familyName("claude-opus-5-5-high"), "Claude");
  assert.equal(familyName("gpt-5.6-sol-high"), "GPT");
  assert.equal(familyName("gemini-3.7-flash-high"), "Gemini");
  assert.equal(familyName("mystery-1"), "mystery-1");
});

test("Codex falls back through its own model list when the default isn't allowed on ChatGPT", async () => {
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const { resetCodexFallback } = await import("../src/adapters/cli-agents.ts");
  resetCodexFallback();
  const home = mkdtempSync(join(tmpdir(), "codex-home-"));
  mkdirSync(home, { recursive: true });
  writeFileSync(
    join(home, "models_cache.json"),
    JSON.stringify({
      models: [
        { slug: "gpt-hidden", visibility: "hide", priority: 0 },
        { slug: "gpt-new", visibility: "list", priority: 1 },
        { slug: "gpt-retiring", visibility: "list", priority: 2, upgrade: { model: "gpt-good" } },
        { slug: "gpt-good", visibility: "list", priority: 3 },
      ],
    }),
  );
  process.env.CODEX_HOME = home;
  process.env.FAKE_CODEX_DEFAULT = "gpt-new";
  process.env.FAKE_CODEX_UNSUPPORTED = "gpt-new";

  assert.match(await codexAgent().ask("hi"), /codex\[gpt-good\] opening/);
  assert.match(await codexAgent().ask("again"), /codex\[gpt-good\]/, "the working model is remembered");
  const models = calls().map((c) => (c.args.includes("-m") ? c.args[c.args.indexOf("-m") + 1] : "(default)"));
  assert.deepEqual(models, ["(default)", "gpt-good", "gpt-good"]);

  // A model the user chose explicitly is never swapped, and the error is readable.
  await assert.rejects(codexAgent("gpt-new").ask("hi"), (err: Error) => {
    assert.match(err.message, /isn't available to your codex login/);
    assert.match(err.message, /ERROR: The 'gpt-new' model is not supported when using Codex with a ChatGPT account\./);
    assert.doesNotMatch(err.message, /Keep it|user\n|"type"/, "no prompt echo or raw JSON");
    return true;
  });
  resetCodexFallback();
});
