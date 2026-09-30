import type { Agent, BattleEvent, BattleResult, Turn } from "./types.ts";
import { DEBATER_SYSTEM, JUDGE_SYSTEM, debatePrompt, judgePrompt, openingPrompt, type Position } from "./prompts.ts";

export interface BattleOptions {
  topic: string;
  agents: Agent[];
  judge: Agent;
  /** Total rounds including the opening. 1 = opening only, then judge. */
  rounds: number;
  onEvent?: (e: BattleEvent) => void;
  signal?: AbortSignal;
}

/**
 * Debaters are shown to each other and to the judge as "Debater A/B/C" so that nobody
 * (the judge in particular) scores arguments by brand. The report maps labels back.
 */
export function anonLabel(index: number): string {
  return `Debater ${String.fromCharCode(65 + index)}`;
}

export async function runBattle(opts: BattleOptions): Promise<BattleResult> {
  const { topic, judge, rounds, onEvent = () => {}, signal } = opts;
  const labels = new Map(opts.agents.map((a, i) => [a.id, anonLabel(i)]));
  let active = [...opts.agents];
  const history: Turn[][] = [];
  const dropped: BattleResult["dropped"] = [];

  for (let round = 1; round <= rounds; round++) {
    if (active.length < 2) break;
    const label = round === 1 ? "Opening statements" : `Debate round ${round}`;
    onEvent({ type: "round-start", round, label, agents: active.map((a) => a.name) });

    const prev = history.at(-1);
    const settled = await Promise.allSettled(
      active.map(async (agent): Promise<Turn> => {
        let prompt: string;
        if (round === 1) {
          prompt = openingPrompt(topic);
        } else {
          const own = prev!.find((t) => t.agentId === agent.id)!.text;
          const others = prev!
            .filter((t) => t.agentId !== agent.id)
            .map((t) => ({ label: labels.get(t.agentId)!, text: t.text }));
          prompt = debatePrompt(topic, round, own, others);
        }
        const start = Date.now();
        const text = await agent.ask(prompt, { system: DEBATER_SYSTEM, signal });
        const turn = { agentId: agent.id, agentName: agent.name, round, text, ms: Date.now() - start };
        onEvent({ type: "turn-done", turn });
        return turn;
      }),
    );

    const turns: Turn[] = [];
    settled.forEach((s, i) => {
      if (s.status === "fulfilled") return void turns.push(s.value);
      const error = s.reason instanceof Error ? s.reason.message : String(s.reason);
      dropped.push({ agentName: active[i].name, round, error });
      onEvent({ type: "turn-failed", round, agentName: active[i].name, error });
    });
    if (signal?.aborted) throw new Error("Battle aborted");
    // A debater that fails a round has no current position, so it sits out the rest.
    active = active.filter((a) => turns.some((t) => t.agentId === a.id));
    if (turns.length) history.push(turns);
  }

  const debaters = new Set(history.flat().map((t) => t.agentId));
  if (debaters.size < 2) {
    const reasons = dropped.map((d) => `  - ${d.agentName}: ${d.error}`).join("\n");
    throw new Error(`Need at least 2 working debaters, got ${debaters.size}.\n${reasons}`);
  }

  onEvent({ type: "judge-start", judgeName: judge.name });
  const start = Date.now();
  const positions = history.map((turns, i) => ({
    round: i + 1,
    positions: turns.map((t): Position => ({ label: labels.get(t.agentId)!, text: t.text })),
  }));
  const verdict = await judge.ask(judgePrompt(topic, positions), { system: JUDGE_SYSTEM, signal });
  onEvent({ type: "judge-done", ms: Date.now() - start });

  return { topic, rounds: history, verdict, judgeName: judge.name, dropped };
}
