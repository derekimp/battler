import assert from "node:assert/strict";
import { test } from "node:test";
import { mergePanel, type JudgeVerdict } from "../src/core/panel.ts";
import type { Criteria, Verdict } from "../src/core/verdict.ts";

const c = (accuracy: number, reasoning = 4, engagement = 4, calibration = 4): Criteria => ({ accuracy, reasoning, engagement, calibration });

/** A judge's verdict with the given criteria per debater label. */
function judged(judgeId: string, scores: Record<string, Criteria>, winner = "Debater A", reason = `${judgeId} says so`): JudgeVerdict {
  const verdict: Verdict = {
    answer: `answer from ${judgeId}`,
    agreement: "partial",
    consensus: [`consensus from ${judgeId}`],
    disagreements: [],
    scorecard: Object.entries(scores).map(([debater, criteria]) => ({
      debater,
      position: `${debater} per ${judgeId}`,
      strength: "",
      weakness: "",
      score: (criteria.accuracy + criteria.reasoning + criteria.engagement + criteria.calibration) / 2,
      criteria,
    })),
    winner: { debater: winner, reason },
  };
  return { judgeId, judgeName: judgeId.toUpperCase(), verdict };
}

// claude = Debater A, codex = Debater B, grok = Debater C
const labels = new Map([["claude", "Debater A"], ["codex", "Debater B"], ["grok", "Debater C"]]);

test("the lead judge's written verdict is kept; criteria are averaged and the score recomputed", () => {
  const v = mergePanel(
    [judged("claude", { "Debater A": c(5), "Debater B": c(3) }), judged("codex", { "Debater A": c(4), "Debater B": c(2) })],
    labels,
    false,
  );
  assert.equal(v.answer, "answer from claude");
  const a = v.scorecard.find((s) => s.debater === "Debater A")!;
  assert.deepEqual(a.criteria, c(4.5));
  assert.equal(a.score, 8.3); // (4.5 + 4 + 4 + 4) / 2 = 8.25 → one decimal
  assert.equal(a.position, "Debater A per claude");
  assert.deepEqual(v.panel, { judges: ["CLAUDE", "CODEX"], selfScoringExcluded: false });
});

test("with self-exclusion, a judge's scores for itself are ignored", () => {
  // Each judge rates itself 5s and the others 3s; without exclusion that would be a wash.
  const selfish = (id: string, self: string) =>
    judged(id, Object.fromEntries(["Debater A", "Debater B", "Debater C"].map((d) => [d, d === self ? c(5, 5, 5, 5) : c(3, 3, 3, 3)])));
  const v = mergePanel([selfish("claude", "Debater A"), selfish("codex", "Debater B"), selfish("grok", "Debater C")], labels, true);
  for (const s of v.scorecard) assert.equal(s.score, 6, `${s.debater} only gets the others' 3s`);
  assert.equal(v.panel?.selfScoringExcluded, true);
});

test("the top average score wins, and votes are counted", () => {
  const v = mergePanel(
    [
      judged("claude", { "Debater B": c(5), "Debater C": c(3) }, "Debater B", "B was sharpest"),
      judged("codex", { "Debater A": c(3), "Debater C": c(5) }, "Debater C"),
      judged("grok", { "Debater A": c(2), "Debater B": c(5) }, "Debater B"),
    ],
    labels,
    true,
  );
  assert.deepEqual(v.winner, { debater: "Debater B", reason: "B was sharpest", votes: 2, voters: 3, decidedBy: "score" });
});

test("the scorecard's top wins even when more judges picked someone else", () => {
  // Real case: GPT tops the averages thanks to one judge, but two judges' first choice is Grok.
  const v = mergePanel(
    [
      judged("claude", { "Debater B": c(4), "Debater C": c(5) }), // picks C (Grok)
      judged("codex", { "Debater A": c(3), "Debater C": c(4) }), // picks C (Grok)
      judged("grok", { "Debater A": c(3), "Debater B": c(5, 5, 5, 5) }), // picks B (GPT)
    ],
    labels,
    true,
  );
  // B: (4,4,4,4)+(5,5,5,5) → 4.5 each → 9.0.  C: (5,4,4,4)+(4,4,4,4) → 8.3.
  assert.deepEqual([v.winner.debater, v.winner.decidedBy, v.winner.votes, v.winner.voters], ["Debater B", "score", 1, 3]);
  assert.equal([...v.scorecard].sort((a, b) => b.score - a.score)[0].debater, v.winner.debater);
});

test("tied top scores are broken by the judges' first choices", () => {
  const v = mergePanel(
    [
      judged("claude", { "Debater A": c(5), "Debater B": c(3) }),
      judged("codex", { "Debater A": c(3), "Debater B": c(5) }),
      judged("grok", { "Debater A": c(4), "Debater B": c(3) }),
    ],
    labels,
    false,
  );
  assert.equal(v.winner.debater, "Debater A");
  const tied = mergePanel(
    [
      judged("claude", { "Debater A": c(5), "Debater B": c(3) }),
      judged("codex", { "Debater A": c(3), "Debater B": c(5) }),
      judged("grok", { "Debater A": c(4), "Debater B": c(4) }, "Debater B"),
    ],
    labels,
    false,
  );
  // Both average 4 → 8.0; first choices: A, B, B (grok's tie goes to its named winner).
  assert.deepEqual([tied.winner.debater, tied.winner.decidedBy, tied.winner.votes], ["Debater B", "votes", 2]);
});

test("a split panel with level averages is a tie", () => {
  const v = mergePanel(
    [
      judged("claude", { "Debater B": c(5), "Debater C": c(3) }),
      judged("codex", { "Debater A": c(3), "Debater C": c(5) }),
      judged("grok", { "Debater A": c(5), "Debater B": c(3) }),
    ],
    labels,
    true,
  );
  assert.deepEqual([v.winner.debater, v.winner.decidedBy], ["tie", "tie"]);
  assert.match(v.winner.reason, /split/);
});

test("a judge's tied ratings are broken by the winner it named; otherwise it abstains", () => {
  const tieBroken = mergePanel(
    [judged("claude", { "Debater A": c(4), "Debater B": c(4) }, "Debater B"), judged("codex", { "Debater A": c(5), "Debater B": c(3) })],
    labels,
    false,
  );
  // claude's tie goes to B (its named winner), codex votes A: 1-1, so the average decides.
  assert.deepEqual([tieBroken.winner.votes, tieBroken.winner.voters], [1, 2]);
  const abstain = mergePanel(
    [judged("claude", { "Debater A": c(4), "Debater B": c(4) }, "Debater C"), judged("codex", { "Debater A": c(5), "Debater B": c(3) })],
    labels,
    false,
  );
  assert.deepEqual([abstain.winner.debater, abstain.winner.votes, abstain.winner.voters], ["Debater A", 1, 1]);
});

test("when votes don't settle it, the highest average score wins", () => {
  // Real-world case: every judge's two eligible debaters tie, and nobody named one of them.
  // Averages: A (5, 5) = 8.5, B (4, 5) = 8.3, C (4, 5) = 8.3.
  const v = mergePanel(
    [
      judged("claude", { "Debater B": c(4), "Debater C": c(4) }, "tie"),
      judged("codex", { "Debater A": c(5), "Debater C": c(5) }, "tie"),
      judged("grok", { "Debater A": c(5), "Debater B": c(5) }, "tie"),
    ],
    labels,
    true,
  );
  assert.deepEqual([v.winner.debater, v.winner.decidedBy, v.winner.voters], ["Debater A", "score", 0]);
  assert.match(v.winner.reason, /^Highest average rating across the judges\./);
});

test("the winner comes from the scores even if the judge's stated winner disagrees", () => {
  const v = mergePanel([judged("claude", { "Debater A": c(2), "Debater B": c(5) }, "Debater A", "A, obviously")], labels, false);
  assert.equal(v.winner.debater, "Debater B");
  assert.equal(v.winner.reason, "Highest average rating across the judges.");
});

test("judges without criteria fall back to averaging their 0-10 scores", () => {
  const plain = (id: string, a: number): JudgeVerdict => {
    const j = judged(id, { "Debater A": c(1) });
    j.verdict.scorecard = [{ debater: "Debater A", position: "", strength: "", weakness: "", score: a }];
    return j;
  };
  const v = mergePanel([plain("claude", 7), plain("codex", 8)], labels, false);
  assert.equal(v.scorecard[0].score, 7.5);
  assert.equal(v.scorecard[0].criteria, undefined);
});
