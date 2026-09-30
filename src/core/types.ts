import type { Length, Verdict } from "./verdict.ts";

/**
 * A debater. Adapters (terminal CLIs today, browser tabs later) implement this;
 * the battle engine only ever talks to this interface.
 *
 * Each call is stateless: the engine puts the full debate context into the prompt,
 * so an adapter never has to manage sessions.
 */
export interface Agent {
  id: string;
  /** Display name, e.g. "Claude". */
  name: string;
  ask(prompt: string, opts?: AskOptions): Promise<string>;
  /** Cheap readiness check (installed + logged in). Returns an error message or null. */
  check(): Promise<string | null>;
}

export interface AskOptions {
  /** Replaces the agent's default system prompt where the backend supports it. */
  system?: string;
  signal?: AbortSignal;
}

export interface Turn {
  agentId: string;
  agentName: string;
  round: number;
  text: string;
  ms: number;
}

export interface BattleResult {
  topic: string;
  length: Length;
  rounds: Turn[][];
  /** Parsed verdict, or null if the judge never produced valid JSON (see verdictText). */
  verdict: Verdict | null;
  /** The lead judge's raw reply, shown if no judge produced valid JSON. */
  verdictText: string;
  /** Judges whose verdicts were used; the first is the lead. */
  judges: string[];
  /** "Debater A" -> real name. */
  names: Map<string, string>;
  /** Agents that failed and were dropped, with the reason. */
  dropped: { agentName: string; round: number; error: string }[];
}

export type BattleEvent =
  | { type: "start"; names: Map<string, string> }
  | { type: "round-start"; round: number; label: string; agents: string[] }
  | { type: "turn-done"; turn: Turn }
  | { type: "turn-failed"; round: number; agentName: string; error: string }
  | { type: "judge-start"; judges: string[] }
  | { type: "judge-done"; judgeName: string; ms: number; ok: boolean }
  | { type: "judge-failed"; judgeName: string; error: string };
