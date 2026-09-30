import assert from "node:assert/strict";
import { test } from "node:test";
import { randomShuffle, runBattle } from "../src/core/battle.ts";
import type { BattleEvent } from "../src/core/types.ts";
import { fakeAgent, identity, verdictJson } from "./helpers.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("runs every round, then the judges: [judge], and returns a parsed verdict", async () => {
  const a = fakeAgent("a");
  const b = fakeAgent("b");
  const judge = fakeAgent("judge", (p) => verdictJson(p));
  const result = await runBattle({ topic: "T?", agents: [a, b], judges: [judge], rounds: 3, length: "medium", shuffle: identity });
  assert.equal(result.rounds.length, 3);
  assert.equal(a.prompts.length, 3);
  assert.equal(judge.prompts.length, 1);
  assert.equal(result.verdict?.answer, "The answer.");
  assert.deepEqual([...result.names], [["Debater A", "a"], ["Debater B", "b"]]);
});

test("debaters within a round run in parallel", async () => {
  const slow = (id: string) => fakeAgent(id, async () => (await sleep(150), `## Position\n${id}`));
  const judge = fakeAgent("judge", (p) => verdictJson(p));
  const start = Date.now();
  await runBattle({ topic: "T", agents: [slow("a"), slow("b"), slow("c")], judges: [judge], rounds: 2, length: "short" });
  const elapsed = Date.now() - start;
  // Sequential would be 6 × 150ms = 900ms; parallel is 2 rounds × 150ms.
  assert.ok(elapsed < 600, `took ${elapsed}ms`);
});

test("round 2 shows each debater the others' positions, anonymised", async () => {
  const a = fakeAgent("a", () => "Claude-secret opening", "Claude");
  const b = fakeAgent("b", () => "GPT-secret opening", "GPT");
  const judge = fakeAgent("judge", (p) => verdictJson(p));
  await runBattle({ topic: "T", agents: [a, b], judges: [judge], rounds: 2, length: "medium", shuffle: identity });
  const round2 = a.prompts[1];
  assert.match(round2, /<your_position>\nClaude-secret opening/);
  assert.match(round2, /### Debater B\nGPT-secret opening/);
  assert.doesNotMatch(round2, /\bGPT\b(?!-secret)/);
  // The judge never sees real names.
  assert.doesNotMatch(judge.prompts[0], /\bClaude\b(?!-secret)|\bGPT\b(?!-secret)/);
});

test("labels follow the shuffle, so Debater A is not always the first agent", async () => {
  const agents = [fakeAgent("a"), fakeAgent("b"), fakeAgent("c")];
  const judge = fakeAgent("judge", (p) => verdictJson(p));
  const reversed = <T>(xs: T[]) => [...xs].reverse();
  const events: BattleEvent[] = [];
  const result = await runBattle({ topic: "T", agents, judges: [judge], rounds: 1, length: "short", shuffle: reversed, onEvent: (e) => events.push(e) });
  assert.equal(result.names.get("Debater A"), "c");
  assert.equal(result.names.get("Debater C"), "a");
  assert.deepEqual(events[0], { type: "start", names: result.names });
  // The judge sees positions in label order regardless of who answered first.
  assert.ok(judge.prompts[0].indexOf("### Debater A") < judge.prompts[0].indexOf("### Debater B"));
});

test("randomShuffle is a permutation and eventually varies", () => {
  const xs = [1, 2, 3, 4];
  const seen = new Set<string>();
  for (let i = 0; i < 200; i++) {
    const s = randomShuffle(xs);
    assert.deepEqual([...s].sort(), xs);
    seen.add(s.join());
  }
  assert.ok(seen.size > 1);
  assert.deepEqual(xs, [1, 2, 3, 4], "input is not mutated");
});

test("a failing debater is dropped and the battle goes on", async () => {
  const bad = fakeAgent("bad", () => {
    throw new Error("usage limit");
  });
  const judge = fakeAgent("judge", (p) => verdictJson(p));
  const events: BattleEvent[] = [];
  const result = await runBattle({
    topic: "T",
    agents: [fakeAgent("a"), fakeAgent("b"), bad],
    judges: [judge],
    rounds: 2,
    length: "medium",
    onEvent: (e) => events.push(e),
  });
  assert.deepEqual(result.dropped, [{ agentName: "bad", round: 1, error: "usage limit" }]);
  assert.equal(result.rounds[1].length, 2, "the dropped debater sits out round 2");
  assert.ok(events.some((e) => e.type === "turn-failed" && e.agentName === "bad"));
});

test("fewer than 2 working debaters is an error that names the causes", async () => {
  const bad = (id: string) =>
    fakeAgent(id, () => {
      throw new Error(`${id} broke`);
    });
  const judge = fakeAgent("judge", (p) => verdictJson(p));
  await assert.rejects(
    runBattle({ topic: "T", agents: [fakeAgent("ok"), bad("x"), bad("y")], judges: [judge], rounds: 1, length: "short" }),
    /at least 2 working debaters.*\n.*x broke\n.*y broke/s,
  );
  assert.equal(judge.prompts.length, 0);
});

test("the judge gets one retry when it answers in prose", async () => {
  let calls = 0;
  const judge = fakeAgent("judge", (p) => (++calls === 1 ? "Debater A won, clearly." : verdictJson(p)));
  const result = await runBattle({ topic: "T", agents: [fakeAgent("a"), fakeAgent("b")], judges: [judge], rounds: 1, length: "short" });
  assert.equal(calls, 2);
  assert.match(judge.prompts[1], /not a valid JSON object/);
  assert.ok(result.verdict);
});

test("if the judge never returns JSON, its prose is kept", async () => {
  const judge = fakeAgent("judge", () => "Just prose.");
  const result = await runBattle({ topic: "T", agents: [fakeAgent("a"), fakeAgent("b")], judges: [judge], rounds: 1, length: "short" });
  assert.equal(result.verdict, null);
  assert.equal(result.verdictText, "Just prose.");
});

test("length changes the word budgets in the prompts", async () => {
  const words = async (length: "short" | "long") => {
    const a = fakeAgent("a");
    await runBattle({ topic: "T", agents: [a, fakeAgent("b")], judges: [fakeAgent("j", (p) => verdictJson(p))], rounds: 2, length });
    return a.prompts.map((p) => Number(p.match(/under (\d+) words/)![1]));
  };
  assert.deepEqual(await words("short"), [150, 200]);
  assert.deepEqual(await words("long"), [700, 900]);
});

test("a panel judges in parallel, and scores for yourself are left out with 3+ debaters", async () => {
  // Every judge rates the first label highly: that is "itself" only for the agent labelled A.
  const judgeOf = (id: string) =>
    fakeAgent(id, async (p) => {
      await sleep(100);
      return verdictJson(p);
    });
  const agents = [judgeOf("a"), judgeOf("b"), judgeOf("c")];
  const start = Date.now();
  const result = await runBattle({ topic: "T", agents, judges: agents, rounds: 1, length: "medium", shuffle: identity });
  assert.ok(Date.now() - start < 350, "judges ran in parallel");
  assert.deepEqual(result.judges, ["a", "b", "c"]);
  assert.equal(result.verdict?.panel?.selfScoringExcluded, true);
  // verdictJson scores A 9, B 8, C 7. A's own 9 is dropped, so A gets 9 from b and c anyway.
  assert.equal(result.verdict?.winner.debater, "Debater A");
  assert.deepEqual([result.verdict?.winner.votes, result.verdict?.winner.voters], [2, 3], "a can't vote for itself");
});

test("with 2 debaters, panel judges may score themselves (otherwise nobody could compare)", async () => {
  const a = fakeAgent("a", (p) => (p.includes("Consolidate") ? verdictJson(p) : "pos"));
  const b = fakeAgent("b", (p) => (p.includes("Consolidate") ? verdictJson(p) : "pos"));
  const result = await runBattle({ topic: "T", agents: [a, b], judges: [a, b], rounds: 1, length: "medium", shuffle: identity });
  assert.equal(result.verdict?.panel?.selfScoringExcluded, false);
  assert.deepEqual([result.verdict?.winner.votes, result.verdict?.winner.voters], [2, 2]);
});

test("a failing judge is left out; a debater that was dropped doesn't judge", async () => {
  const good = (id: string) => fakeAgent(id, (p) => (p.includes("Consolidate") ? verdictJson(p) : "pos"));
  const brokenJudge = fakeAgent("x", (p) => {
    if (p.includes("Consolidate")) throw new Error("judge crashed");
    return "pos";
  });
  const brokenDebater = fakeAgent("y", () => {
    throw new Error("down");
  });
  const agents = [good("a"), brokenJudge, good("b"), brokenDebater];
  const events: BattleEvent[] = [];
  const result = await runBattle({ topic: "T", agents, judges: agents, rounds: 1, length: "medium", onEvent: (e) => events.push(e) });
  assert.deepEqual(result.judges, ["a", "b"]);
  assert.ok(events.some((e) => e.type === "judge-failed" && e.judgeName === "x"));
  assert.ok(!brokenDebater.prompts.some((p) => p.includes("Consolidate")), "y was never asked to judge");
  const start = events.find((e) => e.type === "judge-start");
  assert.deepEqual(start, { type: "judge-start", judges: ["a", "x", "b"] });
});

test("if every judge fails, the battle fails with the reason", async () => {
  const judge = fakeAgent("j", () => {
    throw new Error("limit reached");
  });
  await assert.rejects(
    runBattle({ topic: "T", agents: [fakeAgent("a"), fakeAgent("b")], judges: [judge], rounds: 1, length: "short" }),
    /No judge could deliver a verdict: limit reached/,
  );
});

test("resume adds rounds to an earlier battle, keeping its labels", async () => {
  const a = fakeAgent("a", (p) => (p.includes("ROUND 3") ? "a round 3" : "a earlier"));
  const b = fakeAgent("b", (p) => (p.includes("ROUND 3") ? "b round 3" : "b earlier"));
  const judge = fakeAgent("j", (p) => verdictJson(p));
  const earlier = [
    [
      { agentId: "a", agentName: "a", round: 1, text: "a opening", ms: 1 },
      { agentId: "b", agentName: "b", round: 1, text: "b opening", ms: 1 },
    ],
    [
      { agentId: "a", agentName: "a", round: 2, text: "a revised", ms: 1 },
      { agentId: "b", agentName: "b", round: 2, text: "b revised", ms: 1 },
    ],
  ];
  const labels = new Map([["a", "Debater B"], ["b", "Debater A"]]);
  const events: BattleEvent[] = [];
  const result = await runBattle({
    topic: "T", agents: [a, b], judges: [judge], rounds: 1, length: "medium", labels, resume: earlier, onEvent: (e) => events.push(e),
  });
  assert.equal(result.rounds.length, 3);
  assert.equal(result.resumedFrom, 2);
  assert.equal(a.prompts.length, 1, "only the new round is asked for");
  assert.match(a.prompts[0], /This is ROUND 3/);
  assert.match(a.prompts[0], /<your_position>\na revised/);
  assert.match(a.prompts[0], /### Debater A\nb revised/, "b keeps the label it had");
  assert.deepEqual(events.find((e) => e.type === "round-start"), { type: "round-start", round: 3, total: 3, label: "Debate round 3", agents: ["a", "b"] });
  // The judge sees the whole debate, all three rounds.
  assert.match(judge.prompts[0], /## Round 1 \(opening\)[\s\S]*## Round 2[\s\S]*## Round 3/);
  assert.equal(earlier.length, 2, "the saved rounds are not mutated");
});

test("a follow-up gives each debater the earlier debate as background", async () => {
  const a = fakeAgent("a");
  const b = fakeAgent("b");
  const judge = fakeAgent("j", (p) => verdictJson(p));
  const result = await runBattle({
    topic: "What about YAML?",
    agents: [a, b],
    judges: [judge],
    rounds: 1,
    length: "short",
    labels: new Map([["a", "Debater A"], ["b", "Debater B"]]),
    followUp: { topic: "Tabs or spaces?", answer: "Spaces, per Debater B.", finals: new Map([["a", "A said tabs."], ["b", "B said spaces."]]) },
  });
  assert.match(a.prompts[0], /^BACKGROUND: this is a follow-up to an earlier debate you took part in, as Debater A\./);
  assert.match(a.prompts[0], /Earlier question:\nTabs or spaces\?\n\nThe judges' consolidated answer:\nSpaces, per Debater B\./);
  assert.match(a.prompts[0], /<your_earlier_position>\nA said tabs\.\n<\/your_earlier_position>/);
  assert.match(a.prompts[0], /<earlier_positions>\n### Debater B\nB said spaces\.\n<\/earlier_positions>/);
  assert.match(a.prompts[0], /DEBATE TOPIC:\nWhat about YAML\?\n\nThis is the OPENING round of the follow-up\./);
  assert.match(judge.prompts[0], /follow-up to an earlier one on "Tabs or spaces\?"/);
  assert.equal(result.followUpOf, "Tabs or spaces?");
});
