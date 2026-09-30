#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { homedir } from "node:os";
import { parseArgs } from "node:util";
import { AGENT_IDS, agentFromSpec, createAgent } from "./adapters/cli-agents.ts";
import { CONFIG_PATH, loadConfig, type Config } from "./config.ts";
import { runBattle } from "./core/battle.ts";
import { renderReport, renderVerdictMarkdown } from "./core/report.ts";
import type { Agent } from "./core/types.ts";
import { LENGTHS, namedVerdict, type Length } from "./core/verdict.ts";
import { Progress } from "./ui/progress.ts";
import { debaterColor, formatDuration, style, termWidth, truncate } from "./ui/term.ts";
import { renderHtmlReport } from "./ui/html-report.ts";
import { renderVerdict } from "./ui/verdict-view.ts";
import { autoLineup, defaultJudge, explicitLineup } from "./lineup.ts";
import { defaultSetupDeps, runSetup } from "./setup.ts";
import { terminalPrompter } from "./ui/prompt.ts";

const HELP = `battler: make your AI subscriptions debate a topic and consolidate the result.

Usage:
  battler "Is Rust better than Go for backend services?"
  battler                  asks for the topic and length
  battler setup            install and log in to the AI CLIs, pick your defaults
  echo "topic" | battler
  battler --doctor

Options:
  -a, --agents <list>   Debaters, comma-separated name[:model]   (default: every CLI that is ready)
                        names: claude (Claude Code), codex|gpt (Codex CLI), grok (Cursor CLI),
                        cursor:<model> (any model your Cursor plan offers)
                        e.g. claude:opus,codex,grok:grok-4.7-high
                        e.g. cursor:claude-sonnet-5-medium,cursor:gpt-5.5-medium,grok
  -j, --judge <who>     "panel": every debater judges, scores are averaged, majority wins
                        (nobody scores itself when there are 3+ debaters)
                        or one agent, same format as --agents     (default: panel; short: Claude)
  -l, --length <size>   short | medium | long: how much the debaters write and
                        how detailed the verdict is               (default: medium)
  -s, -m, -L            Shorthands for --length short / medium / long
  -r, --rounds <n>      Rounds including the opening (1-5)       (default: 2)
  -o, --out <dir>       Where to save the full Markdown report   (default: ./battles)
      --open            Open the report in your browser when the battle is done
      --json            Print the verdict as JSON (for scripts)
      --doctor          Check which CLIs are installed and logged in with a subscription
  -h, --help

Defaults can be set in ${CONFIG_PATH}
Only subscription logins are used: API-key env vars are removed before each CLI runs.`;

function fail(msg: string): never {
  process.stderr.write(`battler: ${msg}\n`);
  process.exit(1);
}

const err = style(process.stderr);
const log = (s = "") => process.stderr.write(s + "\n");

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
      length: { type: "string", short: "l" },
      short: { type: "boolean", short: "s" },
      medium: { type: "boolean", short: "m" },
      long: { type: "boolean", short: "L" },
      json: { type: "boolean" },
      open: { type: "boolean" },
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
    log();
    for (const a of agents) {
      const problem = status.get(a.id);
      const name = err.fg(debaterColor(a.name), err.bold(a.name.padEnd(7)));
      log(`  ${problem ? err.red("✗") : err.green("✓")} ${name} ${problem ? problem : err.dim("ready")}`);
    }
    const ready = [...status.values()].filter((e) => !e).length;
    const cursorReady = !status.get("grok");
    log(err.dim(`\n  ${ready} of ${agents.length} ready. A battle needs at least 2.`));
    if (cursorReady && ready < agents.length) {
      log(err.dim("  Cursor will stand in for the missing Claude/GPT CLIs, using its own Claude and GPT models."));
    }
    log();
    process.exit(ready >= 2 || cursorReady ? 0 : 1);
  }

  if (positionals.length === 1 && positionals[0] === "setup") {
    process.exit(await runSetup(defaultSetupDeps(terminalPrompter)));
  }

  // Interactive when run bare in a terminal: ask for the topic (and length, unless it's set).
  const interactive = !positionals.length && process.stdin.isTTY && process.stderr.isTTY;
  let topic = (positionals.join(" ") || (interactive ? "" : await readStdin())).trim();
  if (interactive) {
    process.stderr.write("\n");
    topic = await terminalPrompter.text("What should they debate?");
  }
  if (!topic) fail(`no topic given\n\n${HELP}`);
  const rounds = Number(values.rounds ?? config.rounds ?? 2);
  if (!Number.isInteger(rounds) || rounds < 1 || rounds > 5) fail("--rounds must be 1-5");
  const shorthand = values.short ? "short" : values.long ? "long" : values.medium ? "medium" : undefined;
  let length = (shorthand ?? values.length ?? config.length) as Length | undefined;
  if (!length && interactive) {
    length = await terminalPrompter.select<Length>("How long?", [
      { value: "short", label: "short", hint: "quick answer and a winner, about a minute" },
      { value: "medium", label: "medium", hint: "the full verdict, 2-3 minutes" },
      { value: "long", label: "long", hint: "in depth" },
    ], 1);
  }
  length ??= "medium";
  if (!LENGTHS.includes(length)) fail(`--length must be one of ${LENGTHS.join(", ")}`);

  // Debaters: explicit list (flag, then config), otherwise whichever CLIs are ready.
  const explicit = values.agents?.split(",") ?? config.agents;
  let agents: Agent[];
  let skipped: string[] = [];
  try {
    if (explicit) {
      agents = explicitLineup(explicit, config);
    } else {
      ({ agents, notes: skipped } = await autoLineup(config));
      if (agents.length < 2) {
        fail(`need at least 2 AI CLIs installed and logged in (or just Cursor).\n  ${skipped.join("\n  ")}\n\n  Run \`battler setup\` to install and log in step by step.`);
      }
    }
  } catch (e) {
    fail((e as Error).message);
  }
  if (new Set(agents.map((a) => a.id)).size !== agents.length) fail("each debater can only appear once");
  if (agents.length < 2) fail("need at least 2 debaters");
  if (agents.length > 6) fail("at most 6 debaters");

  // Judges: a panel of the debaters themselves, or one agent. Short battles default to one to save usage.
  const judgeSpec = values.judge ?? config.judge ?? (length === "short" ? undefined : "panel");
  let judges: Agent[];
  try {
    if (judgeSpec?.trim().toLowerCase() === "panel") judges = [defaultJudge(agents), ...agents.filter((a) => a !== defaultJudge(agents))];
    else judges = [judgeSpec ? agentFromSpec(judgeSpec, config.models) : defaultJudge(agents)];
  } catch (e) {
    fail((e as Error).message);
  }

  const progress = new Progress({
    topic,
    agents: agents.map((a) => a.name),
    judges: judges.map((j) => j.name),
    rounds,
    length,
    skipped,
  });

  const controller = new AbortController();
  process.on("SIGINT", () => {
    controller.abort();
    progress.fail();
    fail("interrupted");
  });

  const started = Date.now();
  let result;
  try {
    result = await runBattle({
      topic,
      agents,
      judges,
      rounds,
      length,
      signal: controller.signal,
      onEvent: (e) => progress.handle(e),
    });
  } catch (e) {
    progress.fail();
    throw e;
  }

  const outDir = resolve((values.out ?? config.out ?? "battles").replace(/^~(?=$|\/)/, homedir()));
  mkdirSync(outDir, { recursive: true });
  // Keep letters in any script (a Chinese topic keeps its Chinese), about 40 columns wide.
  const slug =
    truncate(topic.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, ""), 41).replace(/…$/, "").replace(/-$/, "") ||
    "battle";
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const file = join(outDir, `${stamp}-${slug}.md`);
  writeFileSync(file, renderReport(result));
  const htmlFile = file.replace(/\.md$/, ".html");
  writeFileSync(htmlFile, renderHtmlReport(result));

  const display = (f: string) => (relative(process.cwd(), f).startsWith("..") ? f : relative(process.cwd(), f));
  const openIt = values.open ?? config.open ?? false;
  progress.finish(
    `Done in ${formatDuration(Date.now() - started)}`,
    `Report: ${display(htmlFile)}`,
    openIt ? "Opening it in your browser." : "Add --open to view it in your browser.",
  );
  if (openIt) spawn("open", [htmlFile], { stdio: "ignore", detached: true }).on("error", () => {}).unref();

  if (values.json) {
    const verdict = namedVerdict(result);
    const payload = { topic, length, verdict, ...(verdict ? {} : { verdictText: result.verdictText }), transcript: file, report: htmlFile };
    process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
  } else if (process.stdout.isTTY) {
    process.stdout.write(renderVerdict(result, style(process.stdout), termWidth(process.stdout)) + "\n");
  } else {
    process.stdout.write(renderVerdictMarkdown(result));
  }
}

main().catch((e) => fail(e instanceof Error ? e.message : String(e)));
