import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentId } from "../src/adapters/cli-agents.ts";
import { runSetup, type SetupDeps } from "../src/setup.ts";
import type { Prompter } from "../src/ui/prompt.ts";

type State = Record<AgentId, "ready" | "missing" | "logged-out">;

/** A simulated machine: installing makes a CLI logged-out, logging in makes it ready. Gemini is ready unless given. */
function machine(initial: Omit<State, "gemini"> & Partial<State>, answers: (string | boolean)[], opts: { failInstall?: boolean } = {}) {
  const state: State = { gemini: "ready", ...initial };
  const ran: string[] = [];
  const asked: string[] = [];
  const lines: string[] = [];
  const queue = [...answers];
  const next = (q: string) => {
    asked.push(q);
    if (!queue.length) throw new Error(`unexpected question: ${q}`);
    return queue.shift()!;
  };
  const prompt: Prompter = {
    text: async (q) => String(next(q)),
    confirm: async (q) => Boolean(next(q)),
    select: async (q, choices) => {
      const answer = next(q);
      return choices.find((c) => c.value === answer)!.value;
    },
  };
  const dir = mkdtempSync(join(tmpdir(), "setup-"));
  const deps: SetupDeps = {
    prompt,
    configPath: join(dir, "battler", "config.json"),
    log: (l = "") => void lines.push(l),
    async run(cmd, args) {
      const full = [cmd, ...args].join(" ");
      ran.push(full);
      const id = (["claude", "codex", "grok", "gemini"] as AgentId[]).find((i) =>
        ({ claude: /claude/, codex: /codex/, grok: /cursor/, gemini: /agy|antigravity|gemini/ })[i].test(full),
      )!;
      if (/install/.test(full) && !/login/.test(full)) {
        if (opts.failInstall) return 1;
        state[id] = "logged-out";
      } else state[id] = "ready";
      return 0;
    },
    async check() {
      const msg = { ready: null, missing: "`x` not found on PATH; install it", "logged-out": "not logged in; run login" };
      return { claude: msg[state.claude], codex: msg[state.codex], grok: msg[state.grok], gemini: msg[state.gemini] };
    },
    testBattle: async () => 42,
  };
  return { deps, ran, asked, lines, state, out: () => lines.join("\n") };
}

test("everything ready: no installs, saves preferences, runs the test battle", async () => {
  const m = machine({ claude: "ready", codex: "ready", grok: "ready" }, ["short", false, true]);
  assert.equal(await runSetup(m.deps), 42);
  assert.deepEqual(m.ran, []);
  assert.deepEqual(JSON.parse(readFileSync(m.deps.configPath, "utf8")), { length: "short", open: false });
  assert.match(m.out(), /You're ready:.* Claude vs GPT vs Grok/);
});

test("a missing CLI is installed and logged in, only after asking", async () => {
  const m = machine({ claude: "ready", codex: "missing", grok: "logged-out" }, [true, true, true, "medium", true, false]);
  assert.equal(await runSetup(m.deps), 0);
  assert.deepEqual(m.ran, ["npm install -g @openai/codex", "codex login", "cursor-agent login"]);
  assert.match(m.asked[0], /Install Codex CLI .*It runs: npm install -g @openai\/codex/);
  assert.match(m.asked[1], /Log in to Codex CLI with a ChatGPT plan/);
  assert.match(m.asked[2], /Log in to Cursor CLI/);
  assert.match(m.out(), /Start a battle any time/);
});

test("declining everything with fewer than 2 CLIs ends with guidance and exit 1", async () => {
  const m = machine({ claude: "ready", codex: "missing", grok: "missing", gemini: "missing" }, [false, false, false]);
  assert.equal(await runSetup(m.deps), 1);
  assert.deepEqual(m.ran, []);
  assert.match(m.out(), /needs at least two of these CLIs, or Cursor on its own/);
});

test("Cursor alone is enough, and the lineup says who stands in", async () => {
  const m = machine({ claude: "missing", codex: "missing", grok: "ready" }, [false, false, "medium", true, false]);
  assert.equal(await runSetup(m.deps), 0);
  assert.match(m.out(), /Claude \(via Cursor\) vs GPT \(via Cursor\) vs Grok/);
});

test("a failed install is reported with the command to run by hand", async () => {
  const m = machine({ claude: "ready", codex: "ready", grok: "missing" }, [true, "medium", true, false], { failInstall: true });
  assert.equal(await runSetup(m.deps), 0);
  assert.match(m.out(), /Installing Cursor CLI failed \(exit code 1\)\. You can run it yourself: sh -c curl https:\/\/cursor\.com\/install -fsS \| bash/);
});

test("existing config is kept and its values are the defaults", async () => {
  const m = machine({ claude: "ready", codex: "ready", grok: "ready" }, ["long", true, false]);
  const { mkdirSync } = await import("node:fs");
  mkdirSync(join(m.deps.configPath, ".."), { recursive: true });
  writeFileSync(m.deps.configPath, JSON.stringify({ agents: ["claude", "grok"], length: "long", open: true }));
  await runSetup(m.deps);
  assert.deepEqual(JSON.parse(readFileSync(m.deps.configPath, "utf8")), { agents: ["claude", "grok"], length: "long", open: true });
});

test("Gemini can be installed and signed in from setup, through Antigravity CLI", async () => {
  const m = machine({ claude: "ready", codex: "ready", grok: "ready", gemini: "missing" }, [true, true, "medium", true, false]);
  assert.equal(await runSetup(m.deps), 0);
  assert.deepEqual(m.ran, ["sh -c curl -fsSL https://antigravity.google/cli/install.sh | bash", "agy"]);
  assert.match(m.asked[1], /Log in to Antigravity CLI with a Google account.*Sign in with Google, then type \/quit/);
  assert.match(m.out(), /You're ready: Claude vs GPT vs Grok vs Gemini/);
});
