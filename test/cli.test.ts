// End-to-end: the real CLI entry point, driving the fake claude / codex / cursor-agent binaries.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { FAKE_BIN, ROOT } from "./helpers.ts";

// BATTLER_ENTRY lets CI run the same tests against the built dist/cli.js.
const ENTRY = resolve(ROOT, process.env.BATTLER_ENTRY ?? "src/cli.ts");

function battler(args: string[], env: Record<string, string> = {}, input?: string) {
  const dir = mkdtempSync(join(tmpdir(), "battler-cli-"));
  const r = spawnSync(process.execPath, [ENTRY, ...args], {
    cwd: dir,
    input,
    encoding: "utf8",
    env: {
      PATH: `${FAKE_BIN}:${process.env.PATH}`,
      HOME: dir,
      XDG_CONFIG_HOME: join(dir, "config"),
      NO_COLOR: "1",
      ...env,
    },
  });
  return { ...r, dir };
}

test("--json runs a full battle and saves a transcript", () => {
  const r = battler(["--json", "-s", "Tabs or spaces?"]);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.topic, "Tabs or spaces?");
  assert.equal(out.length, "short");
  assert.match(out.verdict.answer, /^Consolidated answer by claude/);
  assert.equal(out.verdict.scorecard.length, 3);
  for (const s of out.verdict.scorecard) assert.match(s.debater, /^(Claude|GPT|Grok)$/);
  assert.ok(existsSync(out.transcript));
  const report = readFileSync(out.transcript, "utf8");
  assert.match(report, /# Transcript/);
  assert.doesNotMatch(report, /Debater [ABC]\b(?!\/)/, "names are revealed in the report");
});

test("piped stdout gets Markdown; progress goes to stderr", () => {
  const r = battler(["Tabs or spaces?"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^## Answer\n/);
  assert.match(r.stdout, /## Scorecard/);
  assert.match(r.stderr, /Round 1\/2 · Opening statements/);
  assert.match(r.stderr, /Round 2\/2/);
  assert.match(r.stderr, /Report: battles\/.*\.html/);
  assert.deepEqual(readdirSync(join(r.dir, "battles")).map((f) => f.split(".").pop()).sort(), ["html", "json", "md"]);
});

test("topic can come from stdin", () => {
  const r = battler(["--json", "-s"], {}, "Vim or Emacs?\n");
  assert.equal(JSON.parse(r.stdout).topic, "Vim or Emacs?");
});

test("a missing CLI is skipped, and Cursor stands in for it", () => {
  const bin = mkdtempSync(join(tmpdir(), "bin-"));
  // A PATH with only claude and cursor-agent: no codex.
  for (const n of ["claude", "cursor-agent"]) writeFileSync(join(bin, n), `#!/bin/sh\nexec "${FAKE_BIN}/${n}" "$@"\n`, { mode: 0o755 });
  const r = battler(["--json", "-s", "Q?"], { PATH: `${bin}:/usr/bin:/bin:${process.execPath.replace(/\/node$/, "")}` });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /GPT's own CLI isn't ready .* GPT \(via Cursor\) is standing in/);
  const names = JSON.parse(r.stdout).verdict.scorecard.map((s: { debater: string }) => s.debater).sort();
  assert.deepEqual(names, ["Claude", "GPT (via Cursor)", "Grok"]);
});

test("explicit agents and judge, with models", () => {
  const log = join(mkdtempSync(join(tmpdir(), "log-")), "calls.jsonl");
  const r = battler(["--json", "-s", "-a", "codex:gpt-5.5,grok:grok-4.7-low", "-j", "grok", "Q?"], { FAKE_LOG: log });
  assert.equal(r.status, 0, r.stderr);
  assert.match(JSON.parse(r.stdout).verdict.answer, /by cursor\[cursor-grok-4\.6-high\]/, "judge uses its own default model");
  const clis = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l).cli);
  assert.ok(!clis.includes("claude"), "claude was not used");
});

test("config file sets defaults; flags override it", () => {
  const dir = mkdtempSync(join(tmpdir(), "cfg-"));
  mkdirSync(join(dir, "battler"));
  writeFileSync(join(dir, "battler", "config.json"), JSON.stringify({ agents: ["claude", "codex"], length: "long", rounds: 1 }));
  const r = battler(["--json", "Q?"], { XDG_CONFIG_HOME: dir });
  const out = JSON.parse(r.stdout);
  assert.equal(out.length, "long");
  assert.equal(out.verdict.scorecard.length, 2);
  assert.match(r.stderr, /1 round · judged by a panel: Claude and GPT/);
  assert.equal(JSON.parse(battler(["--json", "-s", "Q?"], { XDG_CONFIG_HOME: dir }).stdout).length, "short");
});

test("a debater that fails mid-battle is dropped, the rest finish", () => {
  const r = battler(["--json", "-s", "Q?"], { FAKE_FAIL: "codex" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /✗ GPT .*codex exited with code 2/);
  assert.equal(JSON.parse(r.stdout).verdict.scorecard.length, 2);
});

test("--doctor", () => {
  const ok = battler(["--doctor"]);
  assert.equal(ok.status, 0);
  assert.match(ok.stderr, /✓ Claude .*ready[\s\S]*✓ GPT .*ready[\s\S]*✓ Grok .*ready[\s\S]*✗ Gemini .*not found on PATH[\s\S]*3 of 4 ready/);
  assert.doesNotMatch(ok.stderr, /stand in/, "only a missing Claude or GPT gets a Cursor stand-in");
  const bad = battler(["--doctor"], { FAKE_LOGGED_OUT: "claude,cursor-agent" });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /✗ Claude .*not logged in/);
});

test("bad input is rejected with a clear message", () => {
  const cases: [string[], RegExp][] = [
    [[], /no topic given/],
    [["-r", "9", "Q"], /--rounds must be 1-5/],
    [["-l", "huge", "Q"], /--length must be one of short, medium, long/],
    [["-a", "claude", "Q"], /at least 2 debaters/],
    [["-a", "claude,claude", "Q"], /only appear once/],
    [["-a", "claude,bard", "Q"], /unknown agent "bard"/],
    [["-j", "cursor", "Q"], /needs a model/],
  ];
  for (const [args, message] of cases) {
    const r = battler(args, {}, "");
    assert.equal(r.status, 1, args.join(" "));
    assert.match(r.stderr, message, args.join(" "));
  }
});

test("an invalid config file is reported", () => {
  const dir = mkdtempSync(join(tmpdir(), "cfg-"));
  mkdirSync(join(dir, "battler"));
  writeFileSync(join(dir, "battler", "config.json"), "{ nope");
  const r = battler(["Q?"], { XDG_CONFIG_HOME: dir });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /invalid config at .*config\.json/);
});

test("medium battles are judged by a panel by default; short by one judge; -j overrides", () => {
  const medium = battler(["--json", "Q?"]);
  assert.equal(medium.status, 0, medium.stderr);
  const v = JSON.parse(medium.stdout).verdict;
  assert.deepEqual(v.panel, { judges: ["Claude", "GPT", "Grok"], selfScoringExcluded: true });
  assert.equal(v.winner.voters, 3);
  assert.ok(v.scorecard.every((s: { criteria?: object }) => s.criteria), "checklist ratings are included");
  assert.match(medium.stderr, /Verdict · judge panel/);

  const short = JSON.parse(battler(["--json", "-s", "Q?"]).stdout).verdict;
  assert.equal(short.panel, undefined);

  const single = battler(["--json", "-j", "codex", "Q?"]);
  assert.match(JSON.parse(single.stdout).verdict.answer, /by codex/);
  assert.match(single.stderr, /judged by GPT/);

  const panelShort = battler(["--json", "-s", "-j", "panel", "Q?"]);
  assert.equal(JSON.parse(panelShort.stdout).verdict.panel.judges.length, 3);
});

test("the terminal verdict shows votes and the panel note", () => {
  const r = battler(["Q?"]);
  assert.match(r.stdout, /\*\*(Claude|GPT|Grok) wins \(top score · first choice of 2 of 3 judges\)\.\*\*/);
  assert.match(r.stdout, /Scored by Claude, GPT and Grok; no judge scored itself/);
  assert.match(r.stdout, /\| Debater \| Score \| Accuracy \| Reasoning \| Engagement \| Calibration \|/);
});

test("every battle also writes an HTML report next to the Markdown", () => {
  const r = battler(["--json", "-s", "Q?"]);
  const out = JSON.parse(r.stdout);
  assert.equal(out.report, out.transcript.replace(/\.md$/, ".html"));
  assert.match(readFileSync(out.report, "utf8"), /<h1>Q\?<\/h1>/);
  assert.match(r.stderr, /Report: .*\.html\n\s+Add --open to view it in your browser\./);
});

test("report file names keep non-English topics", () => {
  const out = JSON.parse(battler(["--json", "-s", "留学机构做AI方向可以吗？"]).stdout);
  assert.match(out.report, /-留学机构做ai方向可以吗\.html$/);
  const long = JSON.parse(battler(["--json", "-s", "现在开一个美澳留学机构，专注AI及相关项目申请，从帮家长学生建立信任"]).stdout);
  assert.match(long.report, /\d-现在开一个美澳留学机构-专注ai及相关项目\.html$/, "long CJK names are capped by width");
});

test("continue: more rounds on the last battle, then a follow-up question with it as background", () => {
  const dir = mkdtempSync(join(tmpdir(), "cont-"));
  const log = join(dir, "calls.jsonl");
  const env = { FAKE_LOG: log };
  const out = join(dir, "battles");
  const first = JSON.parse(battler(["--json", "-s", "-o", out, "Tabs or spaces?"], env).stdout);
  assert.equal(JSON.parse(readFileSync(first.saved, "utf8")).rounds.length, 2);

  // More rounds: same topic, one more round by default, same debaters.
  const more = battler(["continue", "--json", "-o", out], env);
  assert.equal(more.status, 0, more.stderr);
  const moreOut = JSON.parse(more.stdout);
  assert.equal(moreOut.topic, "Tabs or spaces?");
  const moreSaved = JSON.parse(readFileSync(moreOut.saved, "utf8"));
  assert.equal(moreSaved.rounds.length, 3);
  assert.deepEqual(moreSaved.labels, JSON.parse(readFileSync(first.saved, "utf8")).labels, "labels are kept");
  assert.match(more.stderr, /Round 3\/3 · Rebuttals and revisions/);
  assert.match(more.stderr, /Continuing .*\.html · 2 rounds so far/);

  // Follow-up: a new question; debaters get the earlier debate as background.
  const follow = battler(["continue", "--json", "-o", out, "What about YAML files?"], env);
  assert.equal(follow.status, 0, follow.stderr);
  const fo = JSON.parse(follow.stdout);
  assert.equal(fo.topic, "What about YAML files?");
  assert.equal(fo.followUpOf, "Tabs or spaces?");
  assert.match(follow.stderr, /Follow-up to: Tabs or spaces\?/);
  const cursorPrompts = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l))
    .filter((c) => c.cli === "cursor-agent" && c.args[0] === "-p").map((c) => c.args.at(-1) as string);
  const opening = cursorPrompts.find((p) => p.includes("What about YAML files?") && p.includes("OPENING round"))!;
  assert.match(opening, /BACKGROUND: this is a follow-up to an earlier debate you took part in, as Debater [ABC]/);
  assert.match(opening, /Earlier question:\nTabs or spaces\?/);
  assert.match(opening, /<your_earlier_position>\n## Revised position\ncursor\[cursor-grok-4\.6-high\] revised position/);
  assert.match(opening, /<earlier_positions>\n### Debater/);
  assert.match(readFileSync(fo.transcript, "utf8"), /^# What about YAML files\?\n\n\*Follow-up to: Tabs or spaces\?\*/);

  // --from picks a specific battle, and accepts the .html report path.
  const again = JSON.parse(battler(["continue", "--json", "-o", out, "--from", first.report, "Why?"], env).stdout);
  assert.equal(again.followUpOf, "Tabs or spaces?");
});

test("continue with nothing to continue explains what to do", () => {
  const r = battler(["continue", "-o", "nowhere", "Q?"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no earlier battle found in nowhere\. Run a battle first, or pass --from <report>/);
});

test("doctor and battles say which Cursor allowance Grok uses", () => {
  const doc = battler(["--doctor"]);
  assert.match(doc.stderr, /✓ Grok +ready · cursor-grok-4\.6-high, Cursor's Cursor Models allowance/);
  assert.doesNotMatch(doc.stderr, /"Other Models"/);
  const dir = mkdtempSync(join(tmpdir(), "cfg-"));
  mkdirSync(join(dir, "battler"));
  writeFileSync(join(dir, "battler", "config.json"), JSON.stringify({ models: { grok: "grok-4.7-xhigh" } }));
  const warned = battler(["--doctor"], { XDG_CONFIG_HOME: dir });
  assert.match(warned.stderr, /grok-4\.7-xhigh, Cursor's Other Models allowance\n.*uses Cursor's "Other Models" allowance/);
  const battle = battler(["--json", "-s", "Q?"], { XDG_CONFIG_HOME: dir });
  assert.match(battle.stderr, /! Grok \(grok-4\.7-xhigh\) uses Cursor's "Other Models" allowance/);
});

test("with Gemini installed and signed in, it joins the battle and the panel", () => {
  const home = mkdtempSync(join(tmpdir(), "gemini-home-"));
  writeFileSync(join(home, "oauth_creds.json"), "{}");
  const r = battler(["--json", "Q?"], { PATH: `${FAKE_BIN}-gemini:${FAKE_BIN}:${process.env.PATH}`, BATTLER_GEMINI_HOME: home });
  assert.equal(r.status, 0, r.stderr);
  const v = JSON.parse(r.stdout).verdict;
  assert.deepEqual(v.scorecard.map((s: { debater: string }) => s.debater).sort(), ["Claude", "GPT", "Gemini", "Grok"]);
  assert.equal(v.panel.judges.length, 4);
  assert.match(r.stderr, /Claude vs GPT vs Grok vs Gemini/);
});

/** The prompts actually sent to AIs (not the readiness checks) in a FAKE_LOG file. */
const askCalls = (log: string) =>
  existsSync(log)
    ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
        .filter((c) => c.args.includes("-p") || c.args[0] === "exec")
    : [];

test("an unwritable output folder fails before any AI is asked anything", () => {
  const dir = mkdtempSync(join(tmpdir(), "ro-"));
  const out = join(dir, "battles");
  mkdirSync(out);
  chmodSync(out, 0o555);
  const log = join(dir, "calls.jsonl");
  const r = battler(["-s", "-o", out, "Q?"], { FAKE_LOG: log });
  chmodSync(out, 0o755);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /can't save battles in .*battles: .*Pick another folder with --out/);
  assert.equal(askCalls(log).length, 0);
});

test("if judging fails, the rounds are saved and `continue` judges them in place", () => {
  const dir = mkdtempSync(join(tmpdir(), "judge-fail-"));
  const out = join(dir, "battles");
  const failed = battler(["-s", "-o", out, "Q?"], { FAKE_FAIL_JUDGE: "1" });
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /No judge could deliver a verdict[\s\S]*The 2 rounds so far are saved; `battler continue` will have them judged\./);
  const files = readdirSync(out).filter((f) => f.endsWith(".json"));
  assert.equal(files.length, 1);
  const partial = JSON.parse(readFileSync(join(out, files[0]), "utf8"));
  assert.equal(partial.incomplete, true);
  assert.equal(partial.rounds.length, 2);

  const log = join(dir, "calls.jsonl");
  const finished = battler(["continue", "--json", "-o", out], { FAKE_LOG: log });
  assert.equal(finished.status, 0, finished.stderr);
  assert.match(finished.stderr, /2 rounds so far · judging it now/);
  assert.ok(JSON.parse(finished.stdout).verdict, "judged");
  const asks = askCalls(log);
  assert.ok(asks.length >= 1 && asks.every((c) => (c.args.at(-1) ?? "").includes("Consolidate") || c.cli !== "cursor-agent"), "only judging calls");
  assert.deepEqual(readdirSync(out).filter((f) => f.endsWith(".json")), files, "the same battle, completed");
  assert.equal(JSON.parse(readFileSync(join(out, files[0]), "utf8")).incomplete, undefined);
});

test("a dropped connection is retried and the battle finishes", () => {
  const dir = mkdtempSync(join(tmpdir(), "flaky-"));
  const r = battler(["--json", "-s", "-o", join(dir, "b"), "Q?"], { FAKE_FLAKY: "codex", FAKE_FLAKY_STATE: join(dir, "state") });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /GPT hit a hiccup, trying again/);
  assert.equal(JSON.parse(r.stdout).verdict.scorecard.length, 3, "GPT stayed in");
});

test("hand-picked debaters and judges are checked before the battle", () => {
  const dir = mkdtempSync(join(tmpdir(), "pre-"));
  const log = join(dir, "calls.jsonl");
  const r = battler(["-s", "-a", "claude,gemini", "Q?"], { FAKE_LOG: log });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /not ready:\n  Gemini: `gemini` not found on PATH/);
  assert.equal(askCalls(log).length, 0);
  const judge = battler(["-s", "-a", "claude,codex", "-j", "gemini", "Q?"], { FAKE_LOG: log });
  assert.match(judge.stderr, /not ready:\n  Gemini:/);
});

test("continuing leaves out a debater whose CLI is gone", () => {
  const dir = mkdtempSync(join(tmpdir(), "gone-"));
  const out = join(dir, "battles");
  assert.equal(battler(["--json", "-s", "-o", out, "Q?"]).status, 0);
  const r = battler(["continue", "--json", "-o", out, "And?"], { FAKE_LOGGED_OUT: "codex" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /Leaving out GPT: not logged in/);
  assert.equal(JSON.parse(r.stdout).verdict.scorecard.length, 2);
});

test("a huge topic is refused with a clear limit", () => {
  const r = battler(["-s", "x".repeat(10_001)]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /the topic is 10,001 characters; keep it under 10,000/);
});

test("stopping battler (SIGTERM) also stops the AI CLIs it started", async () => {
  const marker = `sigterm-${Date.now()}`;
  const { spawn } = await import("node:child_process");
  const dir = mkdtempSync(join(tmpdir(), "sig-"));
  const child = spawn(process.execPath, [ENTRY, "-s", "-o", join(dir, "b"), `Topic ${marker}?`], {
    env: { PATH: `${FAKE_BIN}:${process.env.PATH}`, HOME: dir, XDG_CONFIG_HOME: join(dir, "c"), FAKE_DELAY_MS: "20000", NO_COLOR: "1" },
    stdio: "ignore",
  });
  const running = () => spawnSync("pgrep", ["-f", marker]).stdout.toString().trim().split("\n").filter(Boolean).length;
  for (let i = 0; i < 40 && running() < 2; i++) await new Promise((r) => setTimeout(r, 100));
  assert.ok(running() >= 2, "battler and at least one AI CLI are running");
  child.kill("SIGTERM");
  await new Promise((r) => child.once("exit", r));
  for (let i = 0; i < 20 && running() > 0; i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal(running(), 0, "no AI CLI left behind");
});

test("piping into something that closes early is not a crash", () => {
  const r = spawnSync("sh", ["-c", `"${process.execPath}" "${ENTRY}" -s "Q?" | head -c 1`], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${FAKE_BIN}:${process.env.PATH}`, XDG_CONFIG_HOME: mkdtempSync(join(tmpdir(), "c-")), NO_COLOR: "1" },
    cwd: mkdtempSync(join(tmpdir(), "pipe-")),
  });
  assert.doesNotMatch(r.stderr, /EPIPE|Unhandled|at .*\.js:\d+/);
});
