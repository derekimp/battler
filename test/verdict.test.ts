import assert from "node:assert/strict";
import { test } from "node:test";
import { namedVerdict, panelNote, parseVerdict, revealNames, scoreFromCriteria, winnerHeadline, type Verdict } from "../src/core/verdict.ts";

const valid = {
  answer: "Use spaces.",
  agreement: "strong",
  consensus: ["a", "b"],
  disagreements: [{ point: "p", sides: [{ debaters: ["Debater A"], view: "v" }] }],
  scorecard: [{ debater: "Debater A", position: "x", strength: "y", weakness: "z", score: 8 }],
  winner: { debater: "Debater A", reason: "r" },
};

test("parses plain JSON", () => {
  assert.deepEqual(parseVerdict(JSON.stringify(valid)), valid);
});

test("parses JSON wrapped in a code fence and prose", () => {
  const text = "Here is the verdict:\n```json\n" + JSON.stringify(valid) + "\n```\nHope this helps.";
  assert.equal(parseVerdict(text)?.answer, "Use spaces.");
});

test("rejects prose, broken JSON and a missing answer", () => {
  assert.equal(parseVerdict("Debater A won."), null);
  assert.equal(parseVerdict('{"answer": "x",'), null);
  assert.equal(parseVerdict(JSON.stringify({ ...valid, answer: "  " })), null);
});

test("repairs sloppy fields instead of failing", () => {
  const v = parseVerdict(
    JSON.stringify({
      answer: "ok",
      agreement: "total",
      consensus: ["kept", 3, null],
      disagreements: [{ nope: 1 }, { point: "p", sides: [{ view: "v" }, { debaters: ["A"] }] }],
      scorecard: [{ debater: "Debater A", score: 14 }, { debater: "Debater B", score: "7.5" }, { score: 3 }],
    }),
  )!;
  assert.equal(v.agreement, "partial");
  assert.deepEqual(v.consensus, ["kept"]);
  assert.deepEqual(v.disagreements, [{ point: "p", sides: [{ debaters: [], view: "v" }] }]);
  assert.deepEqual(v.scorecard.map((s) => s.score), [10, 7.5]);
  assert.deepEqual(v.winner, { debater: "tie", reason: "" });
});

test("revealNames swaps labels and leaves unknown ones", () => {
  const names = new Map([["Debater A", "Claude"], ["Debater B", "GPT"]]);
  assert.equal(revealNames("Debater A beat Debater B; Debater C absent.", names), "Claude beat GPT; Debater C absent.");
  assert.equal(revealNames("Debater Alpha", names), "Debater Alpha");
});

test("namedVerdict reveals names everywhere and sorts the scorecard", () => {
  const verdict = parseVerdict(
    JSON.stringify({
      ...valid,
      answer: "Debater B is right.",
      scorecard: [
        { debater: "Debater A", position: "", strength: "", weakness: "", score: 6 },
        { debater: "Debater B", position: "agrees with Debater A", strength: "", weakness: "", score: 9 },
      ],
      winner: { debater: "TIE", reason: "Debater A and Debater B tied." },
    }),
  );
  const names = new Map([["Debater A", "Claude"], ["Debater B", "GPT"]]);
  const v = namedVerdict({ topic: "", length: "medium", rounds: [], verdict, verdictText: "", judges: [""], names, dropped: [] })!;
  assert.equal(v.answer, "GPT is right.");
  assert.deepEqual(v.scorecard.map((s) => s.debater), ["GPT", "Claude"]);
  assert.equal(v.scorecard[0].position, "agrees with Claude");
  assert.equal(v.disagreements[0].sides[0].debaters[0], "Claude");
  assert.deepEqual(v.winner, { debater: "Tie", reason: "Claude and GPT tied." });
});

test("criteria are clamped to 1-5 and the score is computed from them", () => {
  const v = parseVerdict(
    JSON.stringify({
      answer: "x",
      scorecard: [
        { debater: "Debater A", score: 2, criteria: { accuracy: 9, reasoning: 4, engagement: 3, calibration: 0 } },
        { debater: "Debater B", score: 6, criteria: { accuracy: 4 } },
      ],
    }),
  )!;
  assert.deepEqual(v.scorecard[0].criteria, { accuracy: 5, reasoning: 4, engagement: 3, calibration: 1 });
  assert.equal(v.scorecard[0].score, 6.5, "the judge's own score is ignored");
  assert.equal(v.scorecard[1].criteria, undefined, "incomplete criteria fall back to the score");
  assert.equal(v.scorecard[1].score, 6);
  assert.equal(scoreFromCriteria({ accuracy: 5, reasoning: 5, engagement: 5, calibration: 5 }), 10);
});

test("winnerHeadline and panelNote", () => {
  const base = { answer: "", agreement: "strong", consensus: [], disagreements: [], scorecard: [] } as unknown as Verdict;
  assert.equal(winnerHeadline({ ...base, winner: { debater: "GPT", reason: "" } }), "GPT wins");
  const panel = { judges: ["Claude", "GPT", "Grok"], selfScoringExcluded: true };
  assert.equal(
    winnerHeadline({ ...base, panel, winner: { debater: "GPT", reason: "", votes: 1, voters: 3, decidedBy: "score" } }),
    "GPT wins (top score · first choice of 1 of 3 judges)",
  );
  assert.equal(
    winnerHeadline({ ...base, panel, winner: { debater: "GPT", reason: "", votes: 2, voters: 3, decidedBy: "votes" } }),
    "GPT wins (scores tied; first choice of 2 of 3 judges)",
  );
  assert.equal(winnerHeadline({ ...base, winner: { debater: "Tie", reason: "" } }), "Tie");
  assert.equal(winnerHeadline({ ...base, panel, winner: { debater: "Tie", reason: "", votes: 0, voters: 3 } }), "No clear winner");
  assert.equal(panelNote({ ...base, winner: { debater: "x", reason: "" } }), null);
  assert.match(
    panelNote({ ...base, winner: { debater: "x", reason: "" }, panel: { judges: ["Claude", "GPT", "Grok"], selfScoringExcluded: true } })!,
    /^Scored by Claude, GPT and Grok; no judge scored itself\./,
  );
});
