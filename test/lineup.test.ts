import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentId } from "../src/adapters/cli-agents.ts";
import type { Agent } from "../src/core/types.ts";
import { autoLineup, dedupeNames, defaultJudge, explicitLineup } from "../src/lineup.ts";

const NAMES: Record<AgentId, string> = { claude: "Claude", codex: "GPT", grok: "Grok" };

/** Lineup deps where `broken` CLIs fail their check. */
function deps(broken: AgentId[]) {
  const agent = (id: string, name: string, problem: string | null): Agent => ({
    id,
    name,
    ask: async () => "",
    check: async () => problem,
  });
  return {
    create: (id: AgentId) => agent(id, NAMES[id], broken.includes(id) ? "not found on PATH; install it" : null),
    standIn: (id: "claude" | "codex") => agent(`cursor:${id}`, `${NAMES[id]} (via Cursor)`, null),
  };
}

const ids = (agents: Agent[]) => agents.map((a) => a.id);

test("everything ready: the three native CLIs", async () => {
  const { agents, notes } = await autoLineup({}, deps([]));
  assert.deepEqual(ids(agents), ["claude", "codex", "grok"]);
  assert.deepEqual(notes, []);
});

test("Claude and GPT only: Grok is skipped with a reason", async () => {
  const { agents, notes } = await autoLineup({}, deps(["grok"]));
  assert.deepEqual(ids(agents), ["claude", "codex"]);
  assert.deepEqual(notes, ["Skipping Grok: not found on PATH; install it"]);
});

test("Cursor stands in for a missing Claude Code or Codex", async () => {
  const { agents, notes } = await autoLineup({}, deps(["codex"]));
  assert.deepEqual(ids(agents), ["claude", "cursor:codex", "grok"]);
  assert.match(notes[0], /GPT's own CLI isn't ready \(not found on PATH\), so GPT \(via Cursor\) is standing in/);
});

test("Cursor alone still gives a three-way battle", async () => {
  const { agents } = await autoLineup({}, deps(["claude", "codex"]));
  assert.deepEqual(agents.map((a) => a.name), ["Claude (via Cursor)", "GPT (via Cursor)", "Grok"]);
});

test("only one CLI and no Cursor: fewer than two debaters", async () => {
  const { agents, notes } = await autoLineup({}, deps(["codex", "grok"]));
  assert.deepEqual(ids(agents), ["claude"]);
  assert.equal(notes.length, 2);
});

test("explicit lineups keep order and disambiguate duplicate names", () => {
  const agents = explicitLineup(["claude", " ", "cursor:claude-opus-5-5-high", "cursor:claude-sonnet-5-medium"], {});
  assert.deepEqual(agents.map((a) => a.name), ["Claude", "Claude (via Cursor)", "Claude (via Cursor) 2"]);
});

test("dedupeNames leaves unique names alone", () => {
  const a = { id: "claude", name: "Claude" } as Agent;
  assert.equal(dedupeNames([a])[0], a);
});

test("default judge prefers Claude, then GPT, then Grok", () => {
  const mk = (name: string) => ({ id: name, name }) as Agent;
  assert.equal(defaultJudge([mk("Grok"), mk("GPT"), mk("Claude (via Cursor)")]).name, "Claude (via Cursor)");
  assert.equal(defaultJudge([mk("Grok"), mk("GPT")]).name, "GPT");
  assert.equal(defaultJudge([mk("Kimi"), mk("Gemini")]).name, "Kimi");
});
