#!/usr/bin/env node
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { parseArgs } from "node:util";
import { AGENT_IDS, createAgent, cursorModelOf, cursorQuota } from "./adapters/cli-agents.ts";
import { CONFIG_PATH, loadConfig, type Config } from "./config.ts";
import { renderVerdictMarkdown } from "./core/report.ts";
import { latestSaved, loadSaved, savedToResult } from "./core/saved.ts";
import type { Agent } from "./core/types.ts";
import { LENGTHS, namedVerdict, type Length } from "./core/verdict.ts";
import { Progress } from "./ui/progress.ts";
import { debaterColor, formatDuration, style, termWidth } from "./ui/term.ts";
import { renderVerdict } from "./ui/verdict-view.ts";
import { battleSlug, continuePlan, displayPath, newPlan, type Plan } from "./plan.ts";
import { runPlan, type RunOutput } from "./run.ts";
import { defaultSetupDeps, runSetup } from "./setup.ts";
import { terminalPrompter } from "./ui/prompt.ts";

const HELP = `battler: make your AI subscriptions debate a topic and consolidate the result.

Usage:
  battler "Is Rust better than Go for backend services?"
  battler                  asks for the topic and length
  battler serve            open the web app in your browser (runs locally)
  battler setup            install and log in to the AI CLIs, pick your defaults
  battler continue "q"     follow-up question to your last battle, with it as background
  battler continue         another round on your last battle's topic
  battler share            a link to your last battle (a secret GitHub Gist, via the gh CLI)
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
  -c, --compare         Just compare: each AI answers once, side by side; no debate or
                        judging. Quicker and uses 1 message per AI. Debate it later with
                        battler continue
  -o, --out <dir>       Where to save the full Markdown report   (default: ./battles)
      --open            Open the report in your browser when the battle is done
      --from <report>   With continue: which battle to continue (default: the latest)
      --json            Print the verdict as JSON (for scripts)
      --doctor          Check which CLIs are installed and logged in with a subscription
      --port <n>        With serve: port to use                   (default: 4747)
      --lan             With serve: also reachable from your phone on the same Wi-Fi,
                        protected by an access token
      --no-open         With serve: don't open the browser
  -h, --help

Defaults can be set in ${CONFIG_PATH}
Only subscription logins are used: API-key env vars are removed before each CLI runs.`;

/** Open a file or address in the default browser (macOS `open`, Linux `xdg-open`). Best effort. */
function openInBrowser(target: string) {
  const cmd = process.platform === "darwin" ? "open" : "xdg-open";
  spawn(cmd, [target], { stdio: "ignore", detached: true }).on("error", () => {}).unref();
}

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
      compare: { type: "boolean", short: "c" },
      json: { type: "boolean" },
      open: { type: "boolean" },
      out: { type: "string", short: "o" },
      doctor: { type: "boolean" },
      from: { type: "string" },
      port: { type: "string" },
      lan: { type: "boolean" },
      "no-open": { type: "boolean" },
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
      const model = cursorModelOf(a);
      const quota = model && cursorQuota(model);
      const detail = model ? err.dim(` · ${model}, Cursor's ${quota} allowance`) : "";
      const install = problem?.match(/^(.*?);?\s*install it with: (.+)$/);
      log(`  ${problem ? err.red("✗") : err.green("✓")} ${name} ${problem ? (install ? `${install[1]}. Install it with:` : problem) : err.dim("ready") + detail}`);
      if (install) log(`              ${err.cyan(install[2])}`);
      if (!problem && quota === "Other Models") {
        log(err.yellow(`            This model uses Cursor's "Other Models" allowance. Cursor's own Grok (cursor-grok-*) uses the separate "Cursor Models" one.`));
      }
    }
    const ready = [...status.values()].filter((e) => !e).length;
    const cursorReady = !status.get("grok");
    log(err.dim(`\n  ${ready} of ${agents.length} ready. A battle needs at least 2.`));
    if (cursorReady && (status.get("claude") || status.get("codex"))) {
      log(err.dim(`  Cursor will stand in for the missing Claude/GPT CLIs, using its Claude and GPT models (Cursor's "Other Models" allowance).`));
    }
    log();
    process.exit(ready >= 2 || cursorReady ? 0 : 1);
  }

  if (positionals.length === 1 && positionals[0] === "setup") {
    process.exit(await runSetup(defaultSetupDeps(terminalPrompter)));
  }

  const outDir = resolve((values.out ?? config.out ?? "battles").replace(/^~(?=$|\/)/, homedir()));

  if (positionals[0] === "share") {
    const from = values.from ?? latestSaved(outDir);
    if (!from) fail(`no battle to share in ${displayPath(outDir)}. Run one first, or pass --from <report>`);
    const saved = loadSaved(from);
    if (saved.incomplete) fail("that battle stopped before its verdict. Finish it with `battler continue`, then share it.");
    const { createGist, shareMarkdown } = await import("./core/share.ts");
    log(err.dim(`  Uploading "${saved.topic.slice(0, 60)}" as a secret GitHub Gist (unlisted; anyone with the link can read it)…`));
    try {
      const url = await createGist(shareMarkdown(savedToResult(saved)), `${battleSlug(saved.topic)}.md`, `battler: ${saved.topic.slice(0, 200)}`);
      log(`  ${err.green("✓")} ${url}`);
      process.stdout.write(`${url}\n`);
    } catch (e) {
      fail((e as Error).message);
    }
    return;
  }

  if (positionals[0] === "serve") {
    await serve(outDir, config, { port: values.port, lan: Boolean(values.lan), open: !values["no-open"] });
    return;
  }
  const shorthand = values.short ? "short" : values.long ? "long" : values.medium ? "medium" : undefined;
  const lengthFlag = shorthand ?? values.length;
  if (lengthFlag && !LENGTHS.includes(lengthFlag as Length)) fail(`--length must be one of ${LENGTHS.join(", ")}`);
  const roundsFlag = values.rounds === undefined ? undefined : Number(values.rounds);
  // 0 is allowed only with `continue`: judge a battle that stopped before its verdict.
  const minRounds = positionals[0] === "continue" ? 0 : 1;
  if (roundsFlag !== undefined && (!Number.isInteger(roundsFlag) || roundsFlag < minRounds || roundsFlag > 5)) {
    fail(`--rounds must be ${minRounds}-5`);
  }

  let plan: Plan;
  let chat = false; // offer follow-ups after each verdict
  try {
    if (positionals[0] === "continue") {
      const from = values.from ?? latestSaved(outDir);
      if (!from) fail(`no earlier battle found in ${displayPath(outDir)}. Run a battle first, or pass --from <report>`);
      const saved = loadSaved(from);
      let question = positionals.slice(1).join(" ").trim() || (process.stdin.isTTY ? "" : (await readStdin()).trim());
      if (!question && process.stdin.isTTY && process.stderr.isTTY && !values.json) {
        process.stderr.write("\n");
        question = await terminalPrompter.text("Follow-up question? (Enter to keep debating the same topic)");
      }
      plan = await continuePlan(saved, from, question, {
        length: lengthFlag,
        rounds: roundsFlag,
        config,
        judge: values.judge,
        ...(values.compare ? { compare: true } : {}),
      });
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
      let length = lengthFlag ?? config.length;
      if (!length && interactive) {
        length = await terminalPrompter.select<Length>("How long?", [
          { value: "short", label: "short", hint: "quick answer and a winner, about a minute" },
          { value: "medium", label: "medium", hint: "the full verdict, 2-3 minutes" },
          { value: "long", label: "long", hint: "in depth" },
        ], 1);
      }
      plan = await newPlan({
        topic,
        length: length ?? "medium",
        rounds: roundsFlag ?? config.rounds ?? 2,
        agents: values.agents?.split(",") ?? config.agents,
        judge: values.judge,
        compare: Boolean(values.compare),
        config,
      });
      chat = interactive && !values.json;
    }
  } catch (e) {
    fail((e as Error).message);
  }

  const openIt = values.open ?? config.open ?? false;
  for (;;) {
    const { jsonFile, saved } = await execute(plan, outDir, openIt, Boolean(values.json));
    if (!chat) break;
    const question = await terminalPrompter.text(
      saved.compare ? 'Follow-up question? (Enter to finish, "debate" to have them debate these answers)' : 'Follow-up question? (Enter to finish, "more" for another round)',
    );
    if (!question) break;
    try {
      plan = await continuePlan(saved, jsonFile, ["more", "debate"].includes(question.toLowerCase()) ? "" : question, {
        length: lengthFlag,
        rounds: roundsFlag,
        config,
        judge: values.judge,
      });
    } catch (e) {
      fail((e as Error).message);
    }
  }
}

/** `battler serve`: start the local web app and open it. */
async function serve(outDir: string, config: Config, opts: { port?: string; lan: boolean; open: boolean }) {
  const { startServer } = await import("./server.ts");
  const { randomBytes } = await import("node:crypto");
  const { networkInterfaces } = await import("node:os");
  const token = opts.lan ? randomBytes(12).toString("base64url") : undefined;
  let port = opts.port ? Number(opts.port) : 4747;
  if (!Number.isInteger(port) || port < 1 || port > 65535) fail("--port must be a number from 1 to 65535");
  // Try the next ports if the default one is taken.
  let server!: ReturnType<typeof startServer>;
  for (let attempt = 0; ; attempt++) {
    server = startServer({ port, host: opts.lan ? "0.0.0.0" : "127.0.0.1", outDir, config, token });
    const ok = await new Promise<boolean>((res) => {
      server.once("listening", () => res(true));
      server.once("error", (e: NodeJS.ErrnoException) => {
        if (e.code !== "EADDRINUSE" || opts.port || attempt >= 10) fail(`can't listen on port ${port}: ${e.message}`);
        res(false);
      });
    });
    if (ok) break;
    port++;
  }
  const local = `http://localhost:${port}/`;
  log();
  log(`  ${err.bold("battler is running")} at ${err.cyan(local)}`);
  if (token) {
    const lanIps = Object.values(networkInterfaces()).flat().filter((i) => i && i.family === "IPv4" && !i.internal).map((i) => i!.address);
    for (const ip of lanIps) log(`  On your phone (same Wi-Fi):  ${err.cyan(`http://${ip}:${port}/?t=${token}`)}`);
    log(err.yellow("  Anyone with that link on your network can start battles with your subscriptions. Keep it private."));
  }
  log(err.dim(`  Battles are saved in ${displayPath(outDir)}. Press Ctrl+C to stop.`));
  log();
  if (opts.open) openInBrowser(token ? `${local}?t=${token}` : local);
  // Stopping the server stops its battles (and so the AI CLIs they started).
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.once(sig, () => {
      server.stopAll();
      log(err.dim("\n  Stopped."));
      process.exit(0);
    });
  }
  await new Promise(() => {}); // run until stopped
}

/** Run a plan with terminal progress, save the reports and the battle, and print the verdict. */
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
  // Ctrl+C, `kill`, or the terminal closing: stop the AI CLIs we started, not just ourselves.
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.once(sig, onSigint);

  const started = Date.now();
  let out: RunOutput;
  try {
    out = await runPlan(plan, { outDir, signal: controller.signal, onEvent: (e) => progress.handle(e) });
  } catch (e) {
    progress.fail();
    throw e;
  } finally {
    for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.off(sig, onSigint);
  }
  const { result, htmlFile, mdFile, jsonFile, saved, saveError } = out;

  if (saveError) {
    progress.finish(`Done in ${formatDuration(Date.now() - started)}`);
    log(err.yellow(`  Couldn't save this battle (${saveError}). The verdict is below; copy anything you want to keep.`));
  } else {
    progress.finish(
      `Done in ${formatDuration(Date.now() - started)}`,
      `Report: ${displayPath(htmlFile)}`,
      openIt ? "Opening it in your browser." : "Add --open to view it in your browser.",
      result.compare
        ? (result.rounds.at(-1)?.length ?? 0) >= 2
          ? `Follow up: battler continue "your question"   ·   have them debate it: battler continue`
          : `Follow up: battler continue "your question"`
        : `Follow up: battler continue "your question"   ·   more rounds: battler continue`,
      "Share a link to it: battler share",
    );
    if (openIt) openInBrowser(htmlFile);
  }

  if (json) {
    const verdict = namedVerdict(result);
    const payload = {
      topic: plan.topic,
      length: plan.length,
      ...(result.followUpOf ? { followUpOf: result.followUpOf } : {}),
      verdict,
      ...(result.compare
        ? { compare: true, answers: (result.rounds.at(-1) ?? []).map((t) => ({ name: t.agentName, text: t.text })) }
        : verdict
          ? {}
          : { verdictText: result.verdictText }),
      transcript: mdFile,
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

// `battler … | head` closes stdout early; that's fine, not a crash.
process.stdout.on("error", (e: NodeJS.ErrnoException) => {
  if (e.code === "EPIPE") process.exit(0);
  throw e;
});

main().catch((e) => fail(e instanceof Error ? e.message : String(e)));
