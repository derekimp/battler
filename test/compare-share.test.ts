// Compare mode (answers side by side, no judging) and sharing (image card data, gist links).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { runBattle } from "../src/core/battle.ts";
import { toSaved, type SavedBattle } from "../src/core/saved-core.ts";
import { createGist, shareCard, shareMarkdown } from "../src/core/share.ts";
import { continuePlan, newPlan } from "../src/plan.ts";
import { renderReport } from "../src/core/report.ts";
import { renderHtmlReport } from "../src/ui/html-report.ts";
import { renderVerdict } from "../src/ui/verdict-view.ts";
import { style, visibleWidth } from "../src/ui/term.ts";
import { startServer } from "../src/server.ts";
import { fakeAgent, FAKE_BIN, ROOT, verdictJson } from "./helpers.ts";

const answer = (id: string) => () => `## Position\n**${id}** says ship it.\n## Confidence\n70%`;

async function compared() {
  const agents = [fakeAgent("claude", answer("claude"), "Claude"), fakeAgent("codex", answer("codex"), "GPT")];
  const result = await runBattle({ topic: "Ship on Friday?", agents, judges: [], rounds: 1, length: "medium", shuffle: (a) => a });
  return { agents, result };
}

test("compare mode: one round, no judging, no verdict", async () => {
  const { agents, result } = await compared();
  assert.equal(result.compare, true);
  assert.equal(result.verdict, null);
  assert.deepEqual(result.judges, []);
  assert.equal(result.rounds.length, 1);
  assert.equal(agents[0].prompts.length, 1, "each AI is asked once");
  assert.equal(toSaved(result, agents).compare, true);
});

test("a comparison keeps the answers that came back when one AI fails", async () => {
  const agents = [
    fakeAgent("claude", answer("claude"), "Claude"),
    fakeAgent("codex", () => {
      throw new Error("codex timed out after 480s");
    }, "GPT"),
  ];
  const result = await runBattle({ topic: "T?", agents, judges: [], rounds: 1, length: "short", shuffle: (a) => a, retryDelayMs: 0 });
  assert.equal(result.rounds[0].length, 1);
  assert.equal(result.dropped[0].agentName, "GPT");
  const nobody = [fakeAgent("claude", () => { throw new Error("offline: fetch failed"); }, "Claude")];
  await assert.rejects(runBattle({ topic: "T?", agents: nobody, judges: [], rounds: 1, length: "short", retryDelayMs: 0 }));
});

test("compare results render as the answers, in the terminal, Markdown and HTML", async () => {
  const { result } = await compared();
  const term = renderVerdict(result, style({ isTTY: false } as NodeJS.WriteStream), 40);
  assert.match(term, /── Claude/);
  assert.match(term, /claude says ship it\./);
  assert.match(term, /it\.\n\n  Confidence/, "a blank line before each heading");
  for (const l of term.split("\n")) assert.ok(visibleWidth(l) <= 40, l);
  const md = renderReport(result);
  assert.match(md, /compared side by side, not debated or judged/);
  assert.match(md, /## GPT\n\n## Position/);
  assert.doesNotMatch(md, /# Transcript/);
  const html = renderHtmlReport(result);
  assert.match(html, /Their answers/);
  assert.doesNotMatch(html, /<h2>Transcript<\/h2>/);
});

test("newPlan in compare mode skips the rounds and the judges", async () => {
  const plan = await newPlan({ topic: "T?", length: "short", rounds: 3, agents: ["claude", "codex"], compare: true, config: {}, check: async () => null });
  assert.equal(plan.rounds, 1);
  assert.deepEqual(plan.judges, []);
  assert.equal(plan.compare, true);
});

const savedCompare: SavedBattle = {
  version: 1,
  topic: "T?",
  length: "medium",
  createdAt: "2026-09-30T00:00:00Z",
  agents: [
    { id: "claude", name: "Claude", spec: "claude" },
    { id: "codex", name: "GPT", spec: "codex" },
  ],
  labels: [
    ["claude", "Debater A"],
    ["codex", "Debater B"],
  ],
  rounds: [[{ agentId: "claude", agentName: "Claude", round: 1, text: "a", ms: 1 }, { agentId: "codex", agentName: "GPT", round: 1, text: "b", ms: 1 }]],
  verdict: null,
  verdictText: "",
  judges: [],
  compare: true,
};

test("continuing a comparison debates it in place; a follow-up stays a comparison", async () => {
  const debate = await continuePlan(savedCompare, "/x/2026-09-30-t.json", "", { config: {}, check: async () => null });
  assert.equal(debate.rounds, 1);
  assert.equal(debate.resume?.length, 1);
  assert.ok(debate.judges.length >= 1);
  assert.equal(debate.replaces, "2026-09-30-t");
  assert.ok(!debate.compare);

  const follow = await continuePlan(savedCompare, "/x/2026-09-30-t.json", "And on Monday?", { config: {}, check: async () => null });
  assert.equal(follow.compare, true);
  assert.deepEqual(follow.judges, []);
  assert.match(follow.followUp!.answer, /compared side by side/);
  const forced = await continuePlan(savedCompare, "/x/2026-09-30-t.json", "And on Monday?", { config: {}, compare: false, check: async () => null });
  assert.ok(forced.judges.length >= 1, "a follow-up can be debated instead");
});

test("the CLI compares with -c, then `continue` debates it into a full battle", () => {
  const dir = mkdtempSync(join(tmpdir(), "battler-cmp-"));
  const run = (args: string[]) =>
    spawnSync(process.execPath, [resolve(ROOT, process.env.BATTLER_ENTRY ?? "src/cli.ts"), ...args], {
      cwd: dir,
      encoding: "utf8",
      env: { PATH: `${FAKE_BIN}:${process.env.PATH}`, HOME: dir, XDG_CONFIG_HOME: join(dir, "config"), NO_COLOR: "1" },
    });
  const r = run(["-c", "--json", "Tabs or spaces?"]);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.compare, true);
  assert.equal(out.answers.length, 3);
  assert.match(r.stderr, /no debate or judging/);
  assert.match(r.stderr, /have them debate it: battler continue/);

  const c = run(["continue", "--json"]);
  assert.equal(c.status, 0, c.stderr);
  assert.equal(JSON.parse(c.stdout).verdict.scorecard.length, 3);
  const files = readdirSync(join(dir, "battles")).filter((f) => f.endsWith(".json"));
  assert.equal(files.length, 1, "the comparison became the battle, not a second one");
  const saved = JSON.parse(readFileSync(join(dir, "battles", files[0]), "utf8"));
  assert.equal(saved.compare, undefined);
  assert.equal(saved.rounds.length, 2);
});

test("share card: the winner, answer and scores; for a comparison, each position", async () => {
  const agents = [fakeAgent("claude", answer("claude"), "Claude"), fakeAgent("codex", answer("codex"), "GPT")];
  const judge = fakeAgent("claude", (p) => verdictJson(p, { answer: "**Do** it." }), "Claude");
  const result = await runBattle({ topic: "Ship on Friday?", agents, judges: [judge], rounds: 1, length: "medium", shuffle: (a) => a });
  const card = shareCard(result);
  assert.equal(card.winner, "Claude");
  assert.match(card.headline!, /^Claude wins/);
  assert.equal(card.answer, "Do it.", "Markdown is stripped");
  assert.deepEqual(card.scores.map((s) => s.name), ["Claude", "GPT"]);

  const cmp = shareCard((await compared()).result);
  assert.equal(cmp.compare, true);
  assert.equal(cmp.answer, null);
  assert.deepEqual(cmp.positions, [
    { name: "Claude", text: "claude says ship it." },
    { name: "GPT", text: "codex says ship it." },
  ]);
  assert.match(shareMarkdown(result), /Made with \[battler\]\(https:\/\/github\.com\/derekimp\/battler\)/);
});

/** A stand-in for `gh` that records its arguments and stdin, and prints a gist URL. */
function fakeGh(behaviour: "ok" | "logged-out") {
  const dir = mkdtempSync(join(tmpdir(), "gh-"));
  const bin = join(dir, "gh");
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const fs = require("fs");
let input = "";
process.stdin.on("data", (d) => (input += d)).on("end", () => {
  fs.writeFileSync(${JSON.stringify(join(dir, "call.json"))}, JSON.stringify({ args: process.argv.slice(2), input }));
  if (${JSON.stringify(behaviour)} === "logged-out") { console.error("To get started with GitHub CLI, please run:  gh auth login"); process.exit(4); }
  console.log("https://gist.github.com/someone/abc123");
});
`,
  );
  chmodSync(bin, 0o755);
  return { bin, call: () => JSON.parse(readFileSync(join(dir, "call.json"), "utf8")) };
}

test("createGist uploads a secret gist with gh and returns its URL", async () => {
  const gh = fakeGh("ok");
  const url = await createGist("# Report\n", "tabs.md", "battler: Tabs?", gh.bin);
  assert.equal(url, "https://gist.github.com/someone/abc123");
  const call = gh.call();
  assert.deepEqual(call.args, ["gist", "create", "--filename", "tabs.md", "--desc", "battler: Tabs?", "-"]);
  assert.ok(!call.args.includes("--public"), "never public");
  assert.equal(call.input, "# Report\n");

  await assert.rejects(createGist("x", "a.md", "d", fakeGh("logged-out").bin), /gh auth login/);
  await assert.rejects(createGist("x", "a.md", "d", "/nonexistent/gh"), /GitHub CLI/);
});

test("the web API shares a finished battle as a gist and gives the page its card", async () => {
  const outDir = join(mkdtempSync(join(tmpdir(), "share-")), "battles");
  const gh = fakeGh("ok");
  const server = startServer({ port: 0, host: "127.0.0.1", outDir, config: {}, gh: gh.bin, checkAgents: async () => [] });
  await new Promise<void>((r) => server.once("listening", () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const api = (path: string, init: RequestInit = {}) => fetch(base + path, { ...init, headers: { "x-battler": "1", "content-type": "application/json" } });
  try {
    const { mkdirSync } = await import("node:fs");
    mkdirSync(outDir, { recursive: true });
    const { result, agents } = await compared();
    writeFileSync(join(outDir, "2026-09-30-00-00-00-ship.json"), JSON.stringify(toSaved(result, agents)));
    const detail = await (await api("/api/battles/2026-09-30-00-00-00-ship")).json();
    assert.equal(detail.compare, true);
    assert.equal(detail.card.positions.length, 2);
    const list = await (await api("/api/battles")).json();
    assert.equal(list.battles[0].headline, "answers compared");

    const shared = await (await api("/api/battles/2026-09-30-00-00-00-ship/share", { method: "POST" })).json();
    assert.equal(shared.url, "https://gist.github.com/someone/abc123");
    assert.match(gh.call().input, /# Ship on Friday\?/);
    assert.equal((await api("/api/battles/nope/share", { method: "POST" })).status, 404);
  } finally {
    server.close();
  }
});

function cli(args: string[], dir: string, extraPath = "") {
  return spawnSync(process.execPath, [resolve(ROOT, process.env.BATTLER_ENTRY ?? "src/cli.ts"), ...args], {
    cwd: dir,
    encoding: "utf8",
    env: { PATH: `${extraPath}${FAKE_BIN}:${process.env.PATH}`, HOME: dir, XDG_CONFIG_HOME: join(dir, "config"), NO_COLOR: "1" },
  });
}

test("`battler share` uploads the latest battle and prints the link", () => {
  const dir = mkdtempSync(join(tmpdir(), "battler-share-"));
  const none = cli(["share"], dir);
  assert.equal(none.status, 1);
  assert.match(none.stderr, /no battle to share/);

  assert.equal(cli(["-s", "Tabs or spaces?"], dir).status, 0);
  const gh = fakeGh("ok");
  const ghDir = gh.bin.replace(/\/gh$/, "");
  const r = cli(["share"], dir, `${ghDir}:`);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), "https://gist.github.com/someone/abc123");
  assert.match(r.stderr, /secret GitHub Gist/);
  assert.match(gh.call().input, /^# Tabs or spaces\?/);

  const out = fakeGh("logged-out");
  const bad = cli(["share"], dir, `${out.bin.replace(/\/gh$/, "")}:`);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /gh auth login/);
});

test("a follow-up to a comparison is compared too, unless it's debated", () => {
  const dir = mkdtempSync(join(tmpdir(), "battler-cmpf-"));
  assert.equal(cli(["-c", "Tabs or spaces?"], dir).status, 0);
  const follow = cli(["continue", "--json", "And for YAML?"], dir);
  assert.equal(follow.status, 0, follow.stderr);
  assert.equal(JSON.parse(follow.stdout).compare, true);
});
