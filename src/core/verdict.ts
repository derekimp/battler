import type { BattleResult } from "./types.ts";

/** The judge's structured output. Front ends decide how much of it to show. */
export interface Verdict {
  /** The consolidated answer. May contain **bold** and `code`. */
  answer: string;
  /** How much the debaters ended up agreeing. */
  agreement: "strong" | "partial" | "split";
  consensus: string[];
  disagreements: { point: string; sides: { debaters: string[]; view: string }[] }[];
  scorecard: ScoreEntry[];
  winner: {
    debater: string;
    reason: string;
    /** Panel only: how many judges picked this winner, out of how many voted. */
    votes?: number;
    voters?: number;
    /** How the winner was decided: highest average score, votes (scores were tied), or neither. */
    decidedBy?: "score" | "votes" | "tie";
  };
  /** Panel only: who judged, and whether judges were kept from scoring themselves. */
  panel?: { judges: string[]; selfScoringExcluded: boolean };
}

export interface ScoreEntry {
  debater: string;
  position: string;
  strength: string;
  weakness: string;
  /** 0-10. With criteria, this is computed from them, not chosen by the judge. */
  score: number;
  criteria?: Criteria;
}

/** The scoring checklist. Each criterion is 1-5; the score is their sum halved (so 2-10). */
export const CRITERIA = ["accuracy", "reasoning", "engagement", "calibration"] as const;
export type Criterion = (typeof CRITERIA)[number];
export type Criteria = Record<Criterion, number>;

export const CRITERIA_HELP: Record<Criterion, string> = {
  accuracy: "facts and claims are correct; no overclaiming",
  reasoning: "logic, evidence and concreteness of the argument",
  engagement: "deals with the other debaters' strongest points; concedes and pushes back well",
  calibration: "stated confidence matches the evidence and the caveats",
};

export function scoreFromCriteria(c: Criteria): number {
  return Math.round(CRITERIA.reduce((sum, k) => sum + c[k], 0) * 5) / 10;
}

function parseCriteria(x: any): Criteria | undefined {
  if (!x || typeof x !== "object") return undefined;
  const out = {} as Criteria;
  for (const k of CRITERIA) {
    const n = Number(x[k]);
    if (!Number.isFinite(n)) return undefined;
    out[k] = Math.max(1, Math.min(5, n));
  }
  return out;
}

export type Length = "short" | "medium" | "long";
export const LENGTHS: Length[] = ["short", "medium", "long"];

/**
 * Pull the JSON object out of the judge's reply (models sometimes wrap it in a code fence
 * or add a sentence around it) and check its shape. Returns null if it isn't usable.
 */
export function parseVerdict(text: string): Verdict | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let v: any;
  try {
    v = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (typeof v?.answer !== "string" || !v.answer.trim()) return null;
  const strings = (x: unknown): string[] => (Array.isArray(x) ? x.filter((s) => typeof s === "string") : []);
  return {
    answer: v.answer.trim(),
    agreement: ["strong", "partial", "split"].includes(v.agreement) ? v.agreement : "partial",
    consensus: strings(v.consensus),
    disagreements: (Array.isArray(v.disagreements) ? v.disagreements : [])
      .filter((d: any) => typeof d?.point === "string")
      .map((d: any) => ({
        point: d.point,
        sides: (Array.isArray(d.sides) ? d.sides : [])
          .filter((s: any) => typeof s?.view === "string")
          .map((s: any) => ({ debaters: strings(s.debaters), view: s.view })),
      })),
    scorecard: (Array.isArray(v.scorecard) ? v.scorecard : [])
      .filter((s: any) => typeof s?.debater === "string")
      .map((s: any): ScoreEntry => {
        const criteria = parseCriteria(s.criteria);
        return {
          debater: s.debater,
          position: String(s.position ?? ""),
          strength: String(s.strength ?? ""),
          weakness: String(s.weakness ?? ""),
          score: criteria ? scoreFromCriteria(criteria) : Math.max(0, Math.min(10, Number(s.score) || 0)),
          ...(criteria ? { criteria } : {}),
        };
      }),
    winner: {
      debater: String(v.winner?.debater ?? "tie"),
      reason: String(v.winner?.reason ?? ""),
    },
  };
}

/** Swap "Debater A" for real names once judging is over. */
export function revealNames(text: string, names: Map<string, string>): string {
  return text.replace(/Debater [A-Z]\b/g, (label) => names.get(label) ?? label);
}

/** The verdict with "Debater A" etc. replaced by real names everywhere. */
export function namedVerdict(result: BattleResult): Verdict | null {
  const v = result.verdict;
  if (!v) return null;
  const r = (s: string) => revealNames(s, result.names);
  return {
    answer: r(v.answer),
    agreement: v.agreement,
    consensus: v.consensus.map(r),
    disagreements: v.disagreements.map((d) => ({
      point: r(d.point),
      sides: d.sides.map((s) => ({ debaters: s.debaters.map(r), view: r(s.view) })),
    })),
    scorecard: v.scorecard
      .map((s) => ({ ...s, debater: r(s.debater), position: r(s.position), strength: r(s.strength), weakness: r(s.weakness) }))
      .sort((a, b) => b.score - a.score),
    winner: { ...v.winner, debater: /^tie$/i.test(v.winner.debater) ? "Tie" : r(v.winner.debater), reason: r(v.winner.reason) },
    ...(v.panel ? { panel: { ...v.panel, judges: v.panel.judges } } : {}),
  };
}

/** "GPT wins", "GPT wins (2 of 3 judges)", "Tie", or "No clear winner" for a split panel. */
export function winnerHeadline(v: Verdict): string {
  if (v.winner.debater === "Tie") return v.panel ? "No clear winner" : "Tie";
  const detail = winnerDetail(v);
  return detail ? `${v.winner.debater} wins (${detail})` : `${v.winner.debater} wins`;
}

/** "top score · first choice of 2 of 3 judges", or null for a single judge. */
export function winnerDetail(v: Verdict): string | null {
  if (!v.panel || v.winner.debater === "Tie") return null;
  const first = `first choice of ${v.winner.votes} of ${v.winner.voters} judges`;
  return v.winner.decidedBy === "votes" ? `scores tied; ${first}` : `top score · ${first}`;
}

/** One line on who scored, e.g. "Scored by Claude, GPT and Grok; no judge scored itself." */
export function panelNote(v: Verdict): string | null {
  if (!v.panel) return null;
  const j = v.panel.judges;
  const who = j.length === 1 ? j[0] : `${j.slice(0, -1).join(", ")} and ${j.at(-1)}`;
  return `Scored by ${who}${v.panel.selfScoringExcluded ? "; no judge scored itself" : ""}. Each score is the average of the judges' checklist ratings.`;
}

/**
 * Normalise the debater labels a judge wrote ("debater a", "Debater  B", "Debater C's") and drop
 * entries for debaters that don't exist, so a judge can't invent a "Debater D" row.
 */
export function sanitizeVerdict(v: Verdict | null, valid: Set<string>): Verdict | null {
  if (!v) return null;
  const norm = (s: string) => {
    const m = s.trim().match(/^debater\s*([a-z])\b/i);
    return m ? `Debater ${m[1].toUpperCase()}` : s.trim();
  };
  const keep = (s: string) => valid.has(norm(s));
  const seen = new Set<string>();
  const scorecard = v.scorecard
    .map((e) => ({ ...e, debater: norm(e.debater) }))
    .filter((e) => valid.has(e.debater) && !seen.has(e.debater) && seen.add(e.debater));
  const winner = norm(v.winner.debater);
  return {
    ...v,
    scorecard,
    disagreements: v.disagreements
      .map((d) => ({ ...d, sides: d.sides.map((side) => ({ ...side, debaters: side.debaters.filter(keep).map(norm) })) }))
      .filter((d) => d.sides.some((side) => side.debaters.length || side.view)),
    winner: { ...v.winner, debater: valid.has(winner) ? winner : "tie" },
  };
}
