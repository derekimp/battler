#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { parseArgs } from "node:util";
import { AGENT_IDS, createAgent, resolveAgentId, type AgentId } from "./adapters/cli-agents.ts";
import { CONFIG_PATH, loadConfig, type Config } from "./config.ts";
import { runBattle } from "./core/battle.ts";
import { renderReport } from "./core/report.ts";
import type { Agent } from "./core/types.ts";

const HELP = `battler: make your AI subscriptions debate a topic and consolidate the result.

Usage:
  battler "Is Rust better than Go for backend services?"
  echo "topic" | battler
  battler --doctor

Options:
  -a, --agents <list>   Debaters, comma-separated name[:model]   (default: every CLI that is ready)
                        names: claude (Claude Code), codex|gpt (Codex CLI), grok (Cursor CLI)
                        e.g. claude:opus,codex,grok:grok-4.7-high
  -j, --judge <agent>   Who writes the consolidated verdict      (default: claude, else codex, else grok)
  -r, --rounds <n>      Rounds including the opening (1-5)       (default: 2)
  -o, --out <dir>       Where to save the full Markdown report   (default: ./battles)
      --doctor          Check which CLIs are installed and logged in with a subscription
  -h, --help

Defaults can be set in ${CONFIG_PATH}
Only subscription logins are used: API-key env vars are removed before each CLI runs.`;

function fail(msg: string): never {
  process.stderr.write(`battler: ${msg}\n`);
  process.exit(1);
}

const tty = process.stderr.isTTY;
const c = {
  dim: (s: string) => (tty ? `\x1b[2m${s}\x1b[0m` : s),
  bold: (s: string) => (tty ? `\x1b[1m${s}\x1b[0m` : s),
  green: (s: string) => (tty ? `\x1b[32m${s}\x1b[0m` : s),
  red: (s: string) => (tty ? `\x1b[31m${s}\x1b[0m` : s),
  yellow: (s: string) => (tty ? `\x1b[33m${s}\x1b[0m` : s),
};
const log = (s = "") => process.stderr.write(s + "\n");

/** "grok:grok-4.7-high" -> Agent. A model given in the spec beats the config's "models". */
function makeAgent(spec: string, config: Config): Agent {
  const [name, ...rest] = spec.trim().split(":");
  const id = resolveAgentId(name);
  if (!id) fail(`unknown agent "${name}" (choose from ${AGENT_IDS.join(", ")})`);
  return createAgent(id, rest.join(":") || config.models?.[id]);
}

async function checkAll(agents: Agent[]): Promise<Map<string, string | null>> {
  const results = await Promise.all(agents.map(async (a) => [a.id, await a.check()] as const));
  return new Map(results);
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  let s = "";
  for await (const chunk of process.stdin) s += chunk;
  return s;
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      agents: { type: "string", short: "a" },
      judge: { type: "string", short: "j" },
      rounds: { type: "string", short: "r" },
      out: { type: "string", short: "o" },
      doctor: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) return void log(HELP);

  let config: Config;
  try {
    config = loadConfig();
  } catch (err) {
    fail((err as Error).message);
  }

  if (values.doctor) {
    const agents = AGENT_IDS.map((id) => createAgent(id, config.models?.[id]));
    const status = await checkAll(agents);
    for (const a of agents) {
      const err = status.get(a.id);
      log(`${err ? c.red("✗") : c.green("✓")} ${a.name.padEnd(7)} ${err ?? "ready"}`);
    }
    const ready = [...status.values()].filter((e) => !e).length;
    log(c.dim(`\n${ready} of ${agents.length} ready. A battle needs at least 2.`));
    process.exit(ready >= 2 ? 0 : 1);
  }

  const topic = (positionals.join(" ") || (await readStdin())).trim();
  if (!topic) fail(`no topic given\n\n${HELP}`);
  const rounds = Number(values.rounds ?? config.rounds ?? 2);
  if (!Number.isInteger(rounds) || rounds < 1 || rounds > 5) fail("--rounds must be 1-5");

  // Debaters: explicit list (flag, then config), otherwise whichever CLIs are ready.
  const explicit = values.agents?.split(",") ?? config.agents;
  let agents: Agent[];
  if (explicit) {
    agents = explicit.filter((s) => s.trim()).map((s) => makeAgent(s, config));
  } else {
    const candidates = AGENT_IDS.map((id) => createAgent(id, config.models?.[id]));
    const status = await checkAll(candidates);
    agents = candidates.filter((a) => !status.get(a.id));
    for (const a of candidates) {
      const err = status.get(a.id);
      if (err) log(c.yellow(`skipping ${a.name}: ${err}`));
    }
    if (agents.length < 2) fail("need at least 2 CLIs installed and logged in; run `battler --doctor`");
  }
  if (new Set(agents.map((a) => a.id)).size !== agents.length) fail("each agent can only debate once");
  if (agents.length < 2) fail("need at least 2 debaters");

  const judgeSpec = values.judge ?? config.judge;
  const judgeId: AgentId = judgeSpec
    ? (resolveAgentId(judgeSpec.split(":")[0]) ?? fail(`unknown judge "${judgeSpec}"`))
    : AGENT_IDS.find((id) => agents.some((a) => a.id === id))!;
  const judge = judgeSpec ? makeAgent(judgeSpec, config) : createAgent(judgeId, config.models?.[judgeId]);

  log(c.bold(`⚔️  ${topic}`));
  log(c.dim(`   ${agents.map((a) => a.name).join(" vs ")} · ${rounds} round(s) · judge: ${judge.name}`));

  const controller = new AbortController();
  process.on("SIGINT", () => {
    controller.abort();
    fail("interrupted");
  });

  const started = Date.now();
  const result = await runBattle({
    topic,
    agents,
    judge,
    rounds,
    signal: controller.signal,
    onEvent(e) {
      switch (e.type) {
        case "round-start":
          return log(`\n${c.bold(e.label)} ${c.dim(`(waiting on ${e.agents.join(", ")})`)}`);
        case "turn-done": {
          const firstLine = e.turn.text.split("\n").find((l) => l.trim() && !l.startsWith("#")) ?? "";
          const preview = firstLine.length > 90 ? firstLine.slice(0, 89) + "…" : firstLine;
          return log(`  ${c.green("✓")} ${e.turn.agentName.padEnd(7)} ${c.dim(`${(e.turn.ms / 1000).toFixed(0)}s`)}  ${c.dim(preview)}`);
        }
        case "turn-failed":
          return log(`  ${c.red("✗")} ${e.agentName.padEnd(7)} ${c.red(e.error)} ${c.dim("(dropped)")}`);
        case "judge-start":
          return log(`\n${c.bold("Verdict")} ${c.dim(`(${e.judgeName} is judging)`)}`);
        case "judge-done":
          return log(`  ${c.green("✓")} done ${c.dim(`${(e.ms / 1000).toFixed(0)}s`)}`);
      }
    },
  });

  const outDir = resolve((values.out ?? config.out ?? "battles").replace(/^~(?=$|\/)/, homedir()));
  mkdirSync(outDir, { recursive: true });
  const slug = topic.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50) || "battle";
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const file = join(outDir, `${stamp}-${slug}.md`);
  writeFileSync(file, renderReport(result, agents));

  log(c.dim(`\nTotal ${((Date.now() - started) / 1000).toFixed(0)}s · full transcript: ${file}\n`));
  process.stdout.write(result.verdict + "\n");
}

main().catch((err) => fail(err instanceof Error ? err.message : String(err)));
