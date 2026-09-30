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
  rounds: Turn[][];
  verdict: string;
  judgeName: string;
  /** Agents that failed and were dropped, with the reason. */
  dropped: { agentName: string; round: number; error: string }[];
}

export type BattleEvent =
  | { type: "round-start"; round: number; label: string; agents: string[] }
  | { type: "turn-done"; turn: Turn }
  | { type: "turn-failed"; round: number; agentName: string; error: string }
  | { type: "judge-start"; judgeName: string }
  | { type: "judge-done"; ms: number };
