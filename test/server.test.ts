import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { request, type Server } from "node:http";
import { startServer } from "../src/server.ts";
import { FAKE_BIN } from "./helpers.ts";

const savedEnv = { ...process.env };
let server: Server;
let base: string;
let outDir: string;

async function listening(s: Server): Promise<string> {
  await new Promise<void>((r) => s.once("listening", () => r()));
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}

before(async () => {
  process.env.PATH = `${FAKE_BIN}:${savedEnv.PATH}`;
  outDir = join(mkdtempSync(join(tmpdir(), "serve-")), "battles");
  server = startServer({ port: 0, host: "127.0.0.1", outDir, config: {} });
  base = await listening(server);
});
after(() => {
  server.close();
  process.env = { ...savedEnv };
});

const api = (path: string, init: RequestInit = {}) =>
  fetch(base + path, { ...init, headers: { "x-battler": "1", "content-type": "application/json", ...(init.headers ?? {}) } });

function statusWithHost(path: string, host: string, extra: Record<string, string> = {}): Promise<number> {
  const { port } = new URL(base);
  return new Promise((resolve, reject) => {
    request({ port, path, headers: { host, "x-battler": "1", ...extra } }, (res) => {
      res.resume();
      resolve(res.statusCode!);
    }).on("error", reject).end();
  });
}

/** Collect a job's Server-Sent Events until it ends. */
async function events(jobId: string, root = base, query = ""): Promise<any[]> {
  const res = await fetch(`${root}/api/jobs/${jobId}/events${query}`);
  assert.equal(res.status, 200);
  const text = await res.text();
  return text
    .split("\n\n")
    .filter((c) => c.startsWith("data: "))
    .map((c) => JSON.parse(c.slice(6)));
}

test("serves the page and its assets", async () => {
  const page = await fetch(base + "/");
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<script type="module" src="assets\/app\.js">/);
  for (const a of ["/assets/app.js", "/assets/app.css", "/assets/report.css"]) assert.equal((await fetch(base + a)).status, 200, a);
  assert.equal((await fetch(base + "/nope")).status, 404);
});

test("status lists the AIs, their readiness and Cursor allowance", async () => {
  const s = await (await api("/api/status")).json();
  assert.equal(s.canBattle, true);
  assert.deepEqual(s.agents.map((a: any) => [a.id, a.ready]), [["claude", true], ["codex", true], ["grok", true], ["gemini", false]]);
  const grok = s.agents.find((a: any) => a.id === "grok");
  assert.deepEqual([grok.model, grok.allowance], ["cursor-grok-4.6-high", "Cursor Models"]);
  assert.equal(s.agents.find((a: any) => a.id === "codex").standInSpec, "cursor:gpt-5.5-medium");
});

test("a battle runs, streams progress, and is saved to history", async () => {
  const start = await api("/api/battles", { method: "POST", body: JSON.stringify({ topic: "Tabs or spaces?", length: "short", rounds: 2 }) });
  assert.equal(start.status, 202);
  const { jobId } = await start.json();
  const evs = await events(jobId);
  const types = evs.map((e) => e.type);
  assert.equal(types[0], "plan");
  assert.deepEqual(evs[0].debaters.map((d: any) => d.name), ["Claude", "GPT", "Grok"]);
  assert.equal(evs[0].firstRound, 1);
  assert.equal(types.filter((t) => t === "turn-done").length, 6);
  assert.deepEqual(types.slice(-2), ["done", "end"]);
  const turn = evs.find((e) => e.type === "turn-done");
  assert.match(turn.html, /^<article class="turn"/);
  assert.doesNotMatch(turn.html, /Debater [ABC]\b/);
  const done = evs.find((e) => e.type === "done").battle;
  assert.match(done.verdictHtml, /class="card verdict"/);
  assert.match(done.roundsHtml, /Round 2/);
  assert.ok(existsSync(join(outDir, `${done.id}.json`)));

  const list = await (await api("/api/battles")).json();
  assert.equal(list.battles[0].id, done.id);
  assert.equal(list.battles[0].topic, "Tabs or spaces?");
  const detail = await (await api(`/api/battles/${encodeURIComponent(done.id)}`)).json();
  assert.equal(detail.rounds, 2);
  const report = await fetch(base + detail.reportUrl);
  assert.match(await report.text(), /<h1>Tabs or spaces\?<\/h1>/);

  // Follow-up and one more round, both from the saved battle.
  const follow = await (await api("/api/battles", { method: "POST", body: JSON.stringify({ continueFrom: done.id, question: "And YAML?" }) })).json();
  const fev = await events(follow.jobId);
  assert.equal(fev[0].followUpOf, "Tabs or spaces?");
  assert.equal(fev[0].topic, "And YAML?");
  assert.ok(!fev[0].notes.some((n: string) => n.includes("/")), "no file paths in browser notes");
  const more = await (await api("/api/battles", { method: "POST", body: JSON.stringify({ continueFrom: done.id, more: true }) })).json();
  const mev = await events(more.jobId);
  assert.deepEqual([mev[0].firstRound, mev[0].totalRounds], [3, 3]);
  assert.match(mev[0].notes[0], /^Picking up after 2 rounds/);
  assert.equal(mev.find((e) => e.type === "done").battle.rounds, 3);
});

test("bad requests get a readable error", async () => {
  const empty = await api("/api/battles", { method: "POST", body: JSON.stringify({ topic: "  " }) });
  assert.equal(empty.status, 400);
  assert.equal((await empty.json()).error, "no topic given");
  const rounds = await api("/api/battles", { method: "POST", body: JSON.stringify({ topic: "Q", rounds: 9 }) });
  assert.equal((await rounds.json()).error, "rounds must be 1-5");
  const missing = await api("/api/battles", { method: "POST", body: JSON.stringify({ continueFrom: "2026-01-01-00-00-00-nope" }) });
  assert.equal(missing.status, 404);
  assert.equal((await api("/api/jobs/abc123/events")).status, 404);
});

test("security: header, host, origin and path checks", async () => {
  // No X-Battler header: a plain cross-site form post can't do this.
  assert.equal((await fetch(base + "/api/battles", { method: "POST", body: "{}" })).status, 403);
  assert.equal((await fetch(base + "/api/status")).status, 403);
  // Cross-origin request with the header (e.g. a misconfigured proxy) is refused too.
  assert.equal((await api("/api/status", { headers: { origin: "https://evil.example" } })).status, 403);
  // DNS rebinding: a request whose Host isn't localhost is refused. (fetch won't send a custom
  // Host header, so use node:http directly.)
  assert.equal(await statusWithHost("/api/status", "evil.example"), 403);
  assert.equal(await statusWithHost("/api/status", `localhost:${new URL(base).port}`), 200);
  // Path tricks can't reach files outside the battles folder.
  assert.equal((await api("/api/battles/..%2F..%2Fetc%2Fpasswd")).status, 404);
  assert.equal((await fetch(base + "/reports/..%2Fsecret.html")).status, 404);
});

test("LAN mode requires the token for data, not for the page", async () => {
  const lan = startServer({ port: 0, host: "127.0.0.1", outDir, config: {}, token: "s3cret" });
  const root = await listening(lan);
  try {
    assert.equal((await fetch(root + "/")).status, 200, "the page itself loads");
    assert.equal((await fetch(root + "/api/status", { headers: { "x-battler": "1" } })).status, 401);
    const ok = await fetch(root + "/api/status", { headers: { "x-battler": "1", "x-battler-token": "s3cret" } });
    assert.equal(ok.status, 200);
    // Any Host is fine in LAN mode (phones use the Mac's IP), because the token guards it.
    const viaIp = await fetch(root + "/api/status", { headers: { "x-battler": "1", "x-battler-token": "s3cret", host: "192.168.1.20:4747" } });
    assert.equal(viaIp.status, 200);
    const wrong = await fetch(root + "/api/battles", { headers: { "x-battler": "1", "x-battler-token": "nope" } });
    assert.equal(wrong.status, 401);
  } finally {
    lan.close();
  }
});

test("a battle that fails after some rounds offers them for judging; history marks it interrupted", async () => {
  process.env.FAKE_FAIL_JUDGE = "1";
  try {
    const { jobId } = await (await api("/api/battles", { method: "POST", body: JSON.stringify({ topic: "Judges down?", length: "short" }) })).json();
    const evs = await events(jobId);
    const err = evs.find((e) => e.type === "error");
    assert.match(err.message, /No judge could deliver a verdict/);
    assert.doesNotMatch(err.message, /battler continue/, "no terminal instructions in the browser");
    assert.ok(err.savedId);
    const list = (await (await api("/api/battles")).json()).battles;
    const entry = list.find((b: any) => b.id === err.savedId);
    assert.deepEqual([entry.incomplete, entry.headline], [true, "interrupted"]);

    delete process.env.FAKE_FAIL_JUDGE;
    const { jobId: again } = await (await api("/api/battles", { method: "POST", body: JSON.stringify({ continueFrom: err.savedId, more: true }) })).json();
    const done = (await events(again)).find((e) => e.type === "done");
    assert.equal(done.battle.id, err.savedId, "finishing it keeps the same battle");
    assert.equal(done.battle.incomplete, false);
  } finally {
    delete process.env.FAKE_FAIL_JUDGE;
  }
});
