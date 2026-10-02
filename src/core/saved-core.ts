/**
 * Saved battles, the parts that work anywhere (Node, the browser, the Chrome extension).
 * File access lives in saved.ts.
 */
import type { Agent, BattleResult, Turn } from "./types.ts";
import type { Length, Verdict } from "./verdict.ts";
import type { Attachment } from "./links.ts";

export interface SavedBattle {
  version: 1;
  topic: string;
  length: Length;
  createdAt: string;
  agents: { id: string; name: string; spec?: string }[];
  /** Agent id → "Debater A". */
  labels: [string, string][];
  rounds: Turn[][];
  /** The verdict with labels, as the judges wrote it. */
  verdict: Verdict | null;
  verdictText: string;
  judges: string[];
  followUpOf?: string;
  /** Saved after a round, before the verdict: the battle stopped (or is still running). */
  incomplete?: boolean;
  /** Compare mode: the answers side by side, never debated or judged. */
  compare?: boolean;
  /** Shared conversations the question linked to, as the AIs saw them (so continuing keeps them). */
  attachments?: Attachment[];
}

/** A battle that stopped before its verdict, from its rounds so far. */
export function toIncomplete(
  p: { topic: string; length: Length; rounds: Turn[][]; labels: Map<string, string>; followUpOf?: string; attachments?: Attachment[] },
  agents: Agent[],
  createdAt = new Date(),
): SavedBattle {
  return {
    version: 1,
    topic: p.topic,
    length: p.length,
    createdAt: createdAt.toISOString(),
    agents: agents.map((a) => ({ id: a.id, name: a.name, ...(a.spec ? { spec: a.spec } : {}) })),
    labels: [...p.labels],
    rounds: p.rounds,
    verdict: null,
    verdictText: "",
    judges: [],
    ...(p.followUpOf ? { followUpOf: p.followUpOf } : {}),
    ...(p.attachments?.length ? { attachments: p.attachments } : {}),
    incomplete: true,
  };
}

export function toSaved(result: BattleResult, agents: Agent[], createdAt = new Date()): SavedBattle {
  return {
    version: 1,
    topic: result.topic,
    length: result.length,
    createdAt: createdAt.toISOString(),
    agents: agents.map((a) => ({ id: a.id, name: a.name, ...(a.spec ? { spec: a.spec } : {}) })),
    labels: [...(result.labels ?? [])],
    rounds: result.rounds,
    verdict: result.verdict,
    verdictText: result.verdictText,
    judges: result.judges,
    ...(result.followUpOf ? { followUpOf: result.followUpOf } : {}),
    ...(result.compare ? { compare: true } : {}),
    ...(result.attachments?.length ? { attachments: result.attachments } : {}),
  };
}

/** Each debater's last position in a saved battle, by agent id. */
export function finalPositions(saved: SavedBattle): Map<string, string> {
  const finals = new Map<string, string>();
  for (const round of saved.rounds) for (const t of round) finals.set(t.agentId, t.text);
  return finals;
}

/**
 * The consolidated answer of a saved battle, as background for a follow-up. It keeps the
 * "Debater A" labels (not real names), because the debaters only know each other by label.
 */
export function savedAnswer(saved: SavedBattle): string {
  return saved.verdict?.answer ?? saved.verdictText;
}

/** A saved battle in the shape the renderers take, with real names restored. */
export function savedToResult(saved: SavedBattle): BattleResult {
  const nameOf = new Map(saved.agents.map((a) => [a.id, a.name]));
  return {
    topic: saved.topic,
    length: saved.length,
    rounds: saved.rounds,
    verdict: saved.verdict,
    verdictText: saved.verdictText,
    judges: saved.judges,
    names: new Map(saved.labels.map(([id, label]) => [label, nameOf.get(id) ?? label])),
    labels: new Map(saved.labels),
    dropped: [],
    ...(saved.followUpOf ? { followUpOf: saved.followUpOf } : {}),
    ...(saved.compare ? { compare: true } : {}),
    ...(saved.attachments?.length ? { attachments: saved.attachments } : {}),
  };
}

/** Check that parsed JSON is a battle this version can continue. Returns an error message or null. */
export function savedProblem(data: unknown): string | null {
  const d = data as Partial<SavedBattle> | null;
  if (d?.version !== 1 || !Array.isArray(d.rounds) || !Array.isArray(d.agents)) {
    return "isn't a battle saved by this version of battler";
  }
  return null;
}
