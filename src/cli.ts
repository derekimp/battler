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
import type { FollowUp } from "./core/battle.ts";
import { finalPositions, latestSaved, loadSaved, savedAnswer, toSaved, type SavedBattle } from "./core/saved.ts";
import type { Agent, BattleResult, Turn } from "./core/types.ts";
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
  battler continue "q"     follow-up question to your last battle, with it as background
  battler continue         another round on your last battle's topic
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
      --from <report>   With continue: which battle to continue (default: the latest)
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
      from: { type: "string" },
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

  const outDir = resolve((values.out ?? config.out ?? "battles").replace(/^~(?=$|\/)/, homedir()));
  const shorthand = values.short ? "short" : values.long ? "long" : values.medium ? "medium" : undefined;
  const lengthFlag = (shorthand ?? values.length) as Length | undefined;
  if (lengthFlag && !LENGTHS.includes(lengthFlag)) fail(`--length must be one of ${LENGTHS.join(", ")}`);
  const roundsFlag = values.rounds === undefined ? undefined : Number(values.rounds);
  if (roundsFlag !== undefined && (!Number.isInteger(roundsFlag) || roundsFlag < 1 || roundsFlag > 5)) fail("--rounds must be 1-5");

  let plan: Plan;
  let chat = false; // offer follow-ups after each verdict
  if (positionals[0] === "continue") {
    const from = values.from ?? latestSaved(outDir);
    if (!from) fail(`no earlier battle found in ${display(outDir)}. Run a battle first, or pass --from <report>`);
    const saved = loadOrFail(from);
    let question = positionals.slice(1).join(" ").trim() || (process.stdin.isTTY ? "" : (await readStdin()).trim());
    if (!question && process.stdin.isTTY && process.stderr.isTTY && !values.json) {
      process.stderr.write("\n");
      question = await terminalPrompter.text("Follow-up question? (Enter to keep debating the same topic)");
    }
    plan = continuePlan(saved, from, question, { length: lengthFlag, rounds: roundsFlag, config, judge: values.judge });
    chat = process.stdin.isTTY && process.stderr.isTTY && !values.json;
  } else {
    // Interactive when run bare in a terminal: ask for the topic (and length, unless it's set).
    const interactive = !positionals.length && process.stdin.isTTY && process.stderr.isTTY;
    let topic = (positionals.join(" ") || (interactive ? "" : await readStdin())).trim();
    if (interactive) {
      process.stderr.write("\n");
      topic = await terminalPrompter.text("What should they debate?");
    }
    if (!topic) fail(`no topic given\n\n${HELP}`);
    let length = lengthFlag ?? (config.length as Length | undefined);
    if (!length && interactive) {
      length = await terminalPrompter.select<Length>("How long?", [
        { value: "short", label: "short", hint: "quick answer and a winner, about a minute" },
        { value: "medium", label: "medium", hint: "the full verdict, 2-3 minutes" },
        { value: "long", label: "long", hint: "in depth" },
      ], 1);
    }
    length ??= "medium";
    if (!LENGTHS.includes(length)) fail(`--length must be one of ${LENGTHS.join(", ")}`);
    const rounds = roundsFlag ?? config.rounds ?? 2;
    if (!Number.isInteger(rounds) || rounds < 1 || rounds > 5) fail("rounds must be 1-5");

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
    plan = { topic, agents, judges: pickJudges(agents, length, values.judge ?? config.judge, config), rounds, length, notes: skipped };
    chat = interactive && !values.json;
  }

  const openIt = values.open ?? config.open ?? false;
  for (;;) {
    const { jsonFile, saved } = await execute(plan, outDir, openIt, Boolean(values.json));
    if (!chat) break;
    const question = await terminalPrompter.text("Follow-up question? (Enter to finish, \"more\" for another round)");
    if (!question) break;
    plan = continuePlan(saved, jsonFile, question.toLowerCase() === "more" ? "" : question, {
      length: lengthFlag,
      rounds: roundsFlag,
      config,
      judge: values.judge,
    });
  }
}

/** Everything needed to run one battle. */
interface Plan {
  topic: string;
  agents: Agent[];
  judges: Agent[];
  rounds: number;
  length: Length;
  notes: string[];
  labels?: Map<string, string>;
  resume?: Turn[][];
  followUp?: FollowUp;
  /** Carried over from a continued battle that was itself a follow-up. */
  followUpOf?: string;
}

const display = (f: string) => (relative(process.cwd(), f).startsWith("..") ? f : relative(process.cwd(), f));

function loadOrFail(path: string): SavedBattle {
  try {
    return loadSaved(path);
  } catch (e) {
    fail((e as Error).message);
  }
}

/** Judges: a panel of the debaters themselves, or one agent. Short battles default to one to save usage. */
function pickJudges(agents: Agent[], length: Length, requested: string | undefined, config: Config): Agent[] {
  const spec = requested ?? (length === "short" ? undefined : "panel");
  try {
    if (spec?.trim().toLowerCase() === "panel") {
      const lead = defaultJudge(agents);
      return [lead, ...agents.filter((a) => a !== lead)];
    }
    return [spec ? agentFromSpec(spec, config.models) : defaultJudge(agents)];
  } catch (e) {
    fail((e as Error).message);
  }
}

/**
 * Continue a saved battle: with a question, a follow-up debate that has the earlier one as
 * background; without, more rounds on the same topic. Same debaters, same labels.
 */
function continuePlan(
  saved: SavedBattle,
  from: string,
  question: string,
  opts: { length?: Length; rounds?: number; config: Config; judge?: string },
): Plan {
  const agents = saved.agents.map((a) => {
    try {
      return { ...agentFromSpec(a.spec ?? a.id), id: a.id, name: a.name };
    } catch (e) {
      fail(`can't recreate ${a.name} from ${display(from)}: ${(e as Error).message}`);
    }
  });
  const length = opts.length ?? saved.length;
  const labels = new Map(saved.labels);
  const judges = pickJudges(agents, length, opts.judge ?? opts.config.judge, opts.config);
  const source = `Continuing ${display(from.replace(/\.json$/, ".html"))}`;
  if (question) {
    return {
      topic: question,
      agents,
      judges,
      length,
      labels,
      rounds: opts.rounds ?? opts.config.rounds ?? 2,
      followUp: { topic: saved.topic, answer: savedAnswer(saved), finals: finalPositions(saved) },
      notes: [source],
    };
  }
  return {
    topic: saved.topic,
    agents,
    judges,
    length,
    labels,
    rounds: opts.rounds ?? 1,
    resume: saved.rounds,
    followUpOf: saved.followUpOf,
    notes: [`${source} · ${saved.rounds.length} round${saved.rounds.length === 1 ? "" : "s"} so far`],
  };
}

/** Run a plan, show progress, save the reports and the battle, and print the verdict. */
async function execute(plan: Plan, outDir: string, openIt: boolean, json: boolean) {
  const progress = new Progress({
    topic: plan.topic,
    agents: plan.agents.map((a) => a.name),
    judges: plan.judges.map((j) => j.name),
    rounds: (plan.resume?.length ?? 0) + plan.rounds,
    length: plan.length,
    skipped: plan.notes,
    followUpOf: plan.followUp?.topic ?? plan.followUpOf,
  });

  const controller = new AbortController();
  const onSigint = () => {
    controller.abort();
    progress.fail();
    fail("interrupted");
  };
  process.once("SIGINT", onSigint);

  const started = Date.now();
  let result: BattleResult;
  try {
    result = await runBattle({
      topic: plan.topic,
      agents: plan.agents,
      judges: plan.judges,
      rounds: plan.rounds,
      length: plan.length,
      labels: plan.labels,
      resume: plan.resume,
      followUp: plan.followUp,
      signal: controller.signal,
      onEvent: (e) => progress.handle(e),
    });
  } catch (e) {
    progress.fail();
    throw e;
  } finally {
    process.off("SIGINT", onSigint);
  }
  if (plan.followUpOf && !result.followUpOf) result.followUpOf = plan.followUpOf;

  mkdirSync(outDir, { recursive: true });
  // Keep letters in any script (a Chinese topic keeps its Chinese), about 40 columns wide.
  const slug =
    truncate(plan.topic.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, ""), 41).replace(/…$/, "").replace(/-$/, "") ||
    "battle";
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const file = join(outDir, `${stamp}-${slug}.md`);
  writeFileSync(file, renderReport(result));
  const htmlFile = file.replace(/\.md$/, ".html");
  writeFileSync(htmlFile, renderHtmlReport(result));
  const jsonFile = file.replace(/\.md$/, ".json");
  const saved = toSaved(result, plan.agents);
  writeFileSync(jsonFile, JSON.stringify(saved, null, 2) + "\n");

  progress.finish(
    `Done in ${formatDuration(Date.now() - started)}`,
    `Report: ${display(htmlFile)}`,
    openIt ? "Opening it in your browser." : "Add --open to view it in your browser.",
    `Follow up: battler continue "your question"   ·   more rounds: battler continue`,
  );
  if (openIt) spawn("open", [htmlFile], { stdio: "ignore", detached: true }).on("error", () => {}).unref();

  if (json) {
    const verdict = namedVerdict(result);
    const payload = {
      topic: plan.topic,
      length: plan.length,
      ...(result.followUpOf ? { followUpOf: result.followUpOf } : {}),
      verdict,
      ...(verdict ? {} : { verdictText: result.verdictText }),
      transcript: file,
      report: htmlFile,
      saved: jsonFile,
    };
    process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
  } else if (process.stdout.isTTY) {
    process.stdout.write(renderVerdict(result, style(process.stdout), termWidth(process.stdout)) + "\n");
  } else {
    process.stdout.write(renderVerdictMarkdown(result));
  }
  return { result, jsonFile, saved };
}

main().catch((e) => fail(e instanceof Error ? e.message : String(e)));
