import { CRITERIA, scoreFromCriteria, type Criteria, type ScoreEntry, type Verdict } from "./verdict.ts";

export interface JudgeVerdict {
  judgeId: string;
  judgeName: string;
  verdict: Verdict;
}

/**
 * Merge several judges' verdicts into one.
 *
 * - The written parts (answer, consensus, disagreements) come from the first judge, the "lead".
 * - Each debater's criteria are averaged across judges and the score recomputed from them.
 * - The winner is the debater with the highest average score. If that's tied, the judges'
 *   first choices (one vote each) break the tie; if they're split too, it's a tie.
 * - With `excludeSelf`, a judge's scores for (and votes for) its own debate turns are ignored.
 *   `labelOf` maps a judge's agent id to its debater label so we know which entry is "itself".
 */
export function mergePanel(judges: JudgeVerdict[], labelOf: Map<string, string>, excludeSelf: boolean): Verdict {
  const [lead] = judges;
  const counts = (j: JudgeVerdict, debater: string) => !(excludeSelf && labelOf.get(j.judgeId) === debater);

  const debaters = [...new Set(judges.flatMap((j) => j.verdict.scorecard.map((s) => s.debater)))];
  const scorecard: ScoreEntry[] = [];
  for (const debater of debaters) {
    const entries = judges
      .filter((j) => counts(j, debater))
      .map((j) => j.verdict.scorecard.find((s) => s.debater === debater))
      .filter((s): s is ScoreEntry => Boolean(s));
    if (!entries.length) continue;
    const { criteria: _, ...text } = entries[0];
    const withCriteria = entries.filter((e) => e.criteria);
    let criteria: Criteria | undefined;
    let score: number;
    if (withCriteria.length === entries.length) {
      criteria = Object.fromEntries(
        CRITERIA.map((k) => [k, round1(avg(withCriteria.map((e) => e.criteria![k])))]),
      ) as Criteria;
      score = scoreFromCriteria(criteria);
    } else {
      score = round1(avg(entries.map((e) => e.score)));
    }
    scorecard.push(criteria ? { ...text, score, criteria } : { ...text, score });
  }

  // Votes: each judge's highest-scored debater among those it may score. 1-5 ratings tie often,
  // so a tie is broken by the winner the judge named itself; otherwise the judge abstains.
  const picks = judges.map((j) => {
    const eligible = j.verdict.scorecard.filter((s) => counts(j, s.debater));
    const best = Math.max(...eligible.map((s) => s.score));
    const top = eligible.filter((s) => s.score === best).map((s) => s.debater);
    const named = j.verdict.winner.debater;
    return top.length === 1 ? top[0] : top.includes(named) ? named : null;
  });
  const voters = picks.filter(Boolean).length;
  const tally = new Map<string, number>();
  for (const pick of picks) if (pick) tally.set(pick, (tally.get(pick) ?? 0) + 1);
  const ranked = [...tally].sort((a, b) => b[1] - a[1]);

  // The winner is the top of the scorecard, so the two never disagree. Votes break a tie there.
  const sorted = [...scorecard].sort((a, b) => b.score - a.score);
  const byScore = sorted.length && (sorted.length === 1 || sorted[0].score > sorted[1].score) ? sorted[0].debater : null;
  const tied = sorted.filter((s) => s.score === sorted[0]?.score).map((s) => s.debater);
  const byVotes = byScore ? null : tieBreak(ranked, tied);
  const winner = byScore ?? byVotes ?? "tie";
  const votes = tally.get(winner) ?? 0;

  const agreeing = judges.find((j) => j.verdict.winner.debater === winner && j.verdict.winner.reason);
  const strength = scorecard.find((s) => s.debater === winner)?.strength;
  const reason = agreeing
    ? agreeing.verdict.winner.reason
    : winner === "tie"
      ? "The judges' average ratings are level and their first choices are split."
      : `Highest average rating across the judges.${strength ? ` Strongest point: ${strength}` : ""}`;

  return {
    ...lead.verdict,
    scorecard,
    winner: { debater: winner, reason, votes, voters, decidedBy: byScore ? "score" : byVotes ? "votes" : "tie" },
    panel: { judges: judges.map((j) => j.judgeName), selfScoringExcluded: excludeSelf },
  };
}

/** Among the debaters tied on score, the one with strictly the most votes, if any. */
function tieBreak(ranked: [string, number][], tied: string[]): string | null {
  const contenders = ranked.filter(([d]) => tied.includes(d));
  if (!contenders.length) return null;
  return contenders.length === 1 || contenders[0][1] > contenders[1][1] ? contenders[0][0] : null;
}

const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const round1 = (n: number) => Math.round(n * 10) / 10;
