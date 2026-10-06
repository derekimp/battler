#!/usr/bin/env node
// Live check against the REAL AI CLIs and your subscriptions: are they still answering the way
// battler expects? The CLIs change often, so run this before a release.
//
//   npm run test:live            a short comparison and a short debate (about 7 messages in all)
//   npm run test:live -- --quick just the comparison (about 3 messages)
//
// Battles go to a temporary folder; nothing in ./battles is touched.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "../..");
const ENTRY = join(ROOT, "src/cli.ts");
const quick = process.argv.includes("--quick");
const out = mkdtempSync(join(tmpdir(), "battler-live-"));
let failed = 0;

function battler(args, label) {
  const started = Date.now();
  const r = spawnSync(process.execPath, [ENTRY, ...args, "-o", out], { encoding: "utf8", timeout: 15 * 60_000, env: { ...process.env, NO_COLOR: "1" } });
  const secs = Math.round((Date.now() - started) / 1000);
  return { ...r, secs, label };
}

function check(ok, what, detail = "") {
  console.log(`  ${ok ? "✓" : "✗"} ${what}${detail ? `  (${detail})` : ""}`);
  if (!ok) failed++;
}

console.log(`\nbattler live check: real CLIs, real subscriptions${quick ? " (quick)" : ""}\n`);

const doctor = battler(["--doctor"], "doctor");
const ready = [...doctor.stderr.matchAll(/✓ (\w+)/g)].map((m) => m[1]);
check(ready.length >= 2, "at least two AIs are ready", ready.join(", ") || "none");
if (ready.length < 2) {
  console.log(doctor.stderr);
  process.exit(1);
}

// 1. Compare: everyone answers once.
const cmp = battler(["-c", "-s", "--json", "Is a hot dog a sandwich? Answer in one sentence."], "compare");
let cmpOut = null;
try {
  cmpOut = JSON.parse(cmp.stdout);
} catch {}
check(cmp.status === 0 && cmpOut?.compare, "compare finished", `${cmp.secs}s`);
for (const name of ready) {
  const a = cmpOut?.answers?.find((x) => x.name === name || x.name.startsWith(name));
  check(Boolean(a?.text?.trim()), `${name} answered`, a ? `${a.text.trim().length} chars` : (cmp.stderr.match(new RegExp(`${name}: (.*)`))?.[1] ?? "no answer"));
}

if (!quick) {
  // 2. Debate that comparison: rebuttals, then a judge, and a parsed verdict.
  const deb = battler(["continue", "--json"], "debate");
  let v = null;
  try {
    v = JSON.parse(deb.stdout).verdict;
  } catch {}
  check(deb.status === 0, "debating the comparison finished", `${deb.secs}s`);
  check(Boolean(v?.answer), "the judge returned a verdict battler could read", v ? `winner: ${v.winner.debater}` : deb.stderr.split("\n").filter(Boolean).at(-1));
  check((v?.scorecard?.length ?? 0) >= 2, "every debater was scored", v ? v.scorecard.map((s) => `${s.debater} ${s.score}`).join(", ") : "");
  const saved = readdirSync(out).filter((f) => f.endsWith(".json"));
  check(saved.length === 1 && !JSON.parse(readFileSync(join(out, saved[0]), "utf8")).compare, "the comparison became one full battle");
}

console.log(`\n  ${failed ? `${failed} problem${failed === 1 ? "" : "s"}` : "All good"}. Files: ${out}\n`);
if (failed && cmp.stderr) console.log(cmp.stderr.split("\n").slice(-12).join("\n"));
process.exit(failed ? 1 : 0);
