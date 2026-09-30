import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { finalPositions, latestSaved, loadSaved, savedAnswer, toSaved } from "../src/core/saved.ts";
import type { Agent, BattleResult } from "../src/core/types.ts";

const agents = [
  { id: "claude", name: "Claude", spec: "claude:opus" },
  { id: "cursor:codex", name: "GPT (via Cursor)", spec: "cursor:gpt-5.5-medium" },
] as Agent[];

const result: BattleResult = {
  topic: "T?",
  length: "medium",
  rounds: [
    [
      { agentId: "claude", agentName: "Claude", round: 1, text: "c1", ms: 1 },
      { agentId: "cursor:codex", agentName: "GPT (via Cursor)", round: 1, text: "g1", ms: 1 },
    ],
    [{ agentId: "claude", agentName: "Claude", round: 2, text: "c2", ms: 1 }],
  ],
  verdict: null,
  verdictText: "Debater A won.",
  judges: ["Claude"],
  names: new Map([["Debater A", "Claude"], ["Debater B", "GPT (via Cursor)"]]),
  labels: new Map([["claude", "Debater A"], ["cursor:codex", "Debater B"]]),
  dropped: [],
};

test("a battle round-trips through its saved JSON", () => {
  const dir = mkdtempSync(join(tmpdir(), "saved-"));
  const file = join(dir, "2026-09-30-10-00-00-t.json");
  const saved = toSaved(result, agents, new Date("2026-09-30T10:00:00Z"));
  writeFileSync(file, JSON.stringify(saved));
  const back = loadSaved(file.replace(/\.json$/, ".html"));
  assert.deepEqual(back.agents, [
    { id: "claude", name: "Claude", spec: "claude:opus" },
    { id: "cursor:codex", name: "GPT (via Cursor)", spec: "cursor:gpt-5.5-medium" },
  ]);
  assert.deepEqual(back.labels, [["claude", "Debater A"], ["cursor:codex", "Debater B"]]);
  assert.equal(savedAnswer(back), "Debater A won.", "falls back to the judge's prose, labels intact");
  // A debater that sat out the last round keeps its last position.
  assert.deepEqual([...finalPositions(back)], [["claude", "c2"], ["cursor:codex", "g1"]]);
});

test("latestSaved picks the newest battle; bad files are rejected clearly", () => {
  const dir = mkdtempSync(join(tmpdir(), "saved-"));
  assert.equal(latestSaved(join(dir, "missing")), null);
  for (const n of ["2026-09-29-23-59-59-b.json", "2026-09-30-08-00-00-a.json", "notes.json", "2026-09-30-09-00-00-c.md"]) {
    writeFileSync(join(dir, n), "{}");
  }
  assert.equal(latestSaved(dir), join(dir, "2026-09-30-08-00-00-a.json"));
  assert.throws(() => loadSaved(join(dir, "2026-09-30-08-00-00-a.json")), /isn't a battle saved by this version/);
  assert.throws(() => loadSaved(join(dir, "nope.html")), /no saved battle at .*nope\.json/);
});
