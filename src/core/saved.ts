/**
 * Each battle is saved as JSON next to its reports, so it can be continued later with
 * `battler continue` (more rounds, or a follow-up question).
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Agent, BattleResult, Turn } from "./types.ts";
import type { Length, Verdict } from "./verdict.ts";

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
  };
}

export function loadSaved(path: string): SavedBattle {
  // Accept the .html or .md report path too.
  const file = path.replace(/\.(html|md)$/, ".json");
  if (!existsSync(file)) throw new Error(`no saved battle at ${file}`);
  const data = JSON.parse(readFileSync(file, "utf8"));
  if (data?.version !== 1 || !Array.isArray(data.rounds) || !Array.isArray(data.agents)) {
    throw new Error(`${file} isn't a battle saved by this version of battler`);
  }
  return data as SavedBattle;
}

/** The most recent saved battle in `dir` (file names start with a timestamp). */
export function latestSaved(dir: string): string | null {
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}-.*\.json$/.test(f)).sort();
  return files.length ? join(dir, files.at(-1)!) : null;
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
  };
}
