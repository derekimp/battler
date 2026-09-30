import type { Agent, BattleEvent, BattleResult, Turn } from "./types.ts";
import { DEBATER_SYSTEM, JUDGE_SYSTEM, debatePrompt, followUpBackground, judgePrompt, openingPrompt, type Position } from "./prompts.ts";
import { mergePanel, type JudgeVerdict } from "./panel.ts";
import { isTransient, looksOffline, message } from "./errors.ts";
import { parseVerdict, sanitizeVerdict, type Length } from "./verdict.ts";

export interface BattleOptions {
  topic: string;
  agents: Agent[];
  /**
   * One judge, or several for a panel. Panel judges should be the debaters themselves, so that
   * with 3+ debaters each judge's scores for its own turns can be left out.
   */
  judges: Agent[];
  /**
   * Rounds to run. For a new battle this includes the opening (1 = opening only, then judge);
   * when resuming it's how many more rounds to add.
   */
  rounds: number;
  length: Length;
  onEvent?: (e: BattleEvent) => void;
  signal?: AbortSignal;
  /** Decides which debater gets which label. Random by default; tests pass a fixed order. */
  shuffle?: <T>(items: T[]) => T[];
  /** Fixed labels (agent id → "Debater A"), so a continued battle keeps the letters it had. */
  labels?: Map<string, string>;
  /** Keep debating an earlier battle on the same topic: the rounds it already has. */
  resume?: Turn[][];
  /** Answer a follow-up question, with an earlier battle as background. */
  followUp?: FollowUp;
  /** Wait before retrying a call that failed with a hiccup (network, 5xx). Tests pass 0. */
  retryDelayMs?: number;
}

export interface FollowUp {
  /** The earlier battle's topic and consolidated answer. */
  topic: string;
  answer: string;
  /** Each debater's final position in the earlier battle, by agent id. */
  finals: Map<string, string>;
}

/**
 * Debaters are shown to each other and to the judge as "Debater A/B/C" so that nobody
 * (the judge in particular) scores arguments by brand. Labels are shuffled every battle so
 * "Debater A" is not always the same model. The report maps labels back.
 */
export function anonLabel(index: number): string {
  return `Debater ${String.fromCharCode(65 + index)}`;
}

export function randomShuffle<T>(items: T[]): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
  });

export async function runBattle(opts: BattleOptions): Promise<BattleResult> {
  const { topic, length, onEvent = () => {}, signal, shuffle = randomShuffle, followUp, retryDelayMs = 3000 } = opts;

  /** Ask, and if it fails with a hiccup (not a used-up plan or a missing CLI), ask once more. */
  const ask = async (agent: Agent, prompt: string, system: string, round: number | "verdict") => {
    try {
      return await agent.ask(prompt, { system, signal });
    } catch (err) {
      if (!isTransient(err) || signal?.aborted) throw err;
      onEvent({ type: "retry", agentName: agent.name, round, error: message(err) });
      await sleep(retryDelayMs, signal);
      if (signal?.aborted) throw err;
      return await agent.ask(prompt, { system, signal });
    }
  };
  const labels = opts.labels ?? new Map(shuffle(opts.agents).map((a, i) => [a.id, anonLabel(i)]));
  const names = new Map(opts.agents.map((a) => [labels.get(a.id)!, a.name]));
  onEvent({ type: "start", names });
  const history: Turn[][] = opts.resume ? opts.resume.map((r) => [...r]) : [];
  // When resuming, only debaters who have a position in the last round can carry on.
  let active = history.length ? opts.agents.filter((a) => history.at(-1)!.some((t) => t.agentId === a.id)) : [...opts.agents];
  const dropped: BattleResult["dropped"] = [];
  const first = history.length + 1;
  const last = history.length + opts.rounds;

  for (let round = first; round <= last; round++) {
    if (active.length < 2) break;
    const label = round === 1 ? "Opening statements" : `Debate round ${round}`;
    onEvent({ type: "round-start", round, total: last, label, agents: active.map((a) => a.name) });

    const prev = history.at(-1);
    const settled = await Promise.allSettled(
      active.map(async (agent): Promise<Turn> => {
        let prompt: string;
        if (round === 1) {
          prompt = openingPrompt(topic, length, followUp && followUpBackground(followUp, agent.id, labels));
        } else {
          const own = prev!.find((t) => t.agentId === agent.id)!.text;
          const others = prev!
            .filter((t) => t.agentId !== agent.id)
            .map((t) => ({ label: labels.get(t.agentId)!, text: t.text }))
            .sort((a, b) => a.label.localeCompare(b.label));
          prompt = debatePrompt(topic, round, own, others, length);
        }
        const start = Date.now();
        const text = await ask(agent, prompt, DEBATER_SYSTEM, round);
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
    if (turns.length) {
      history.push(turns);
      onEvent({ type: "round-done", round, history: history.map((r) => [...r]), names, labels });
    }
  }

  const debaters = new Set(history.flat().map((t) => t.agentId));
  if (debaters.size < 2) {
    if (dropped.length && dropped.every((d) => looksOffline(d.error))) {
      throw new Error("Can't reach the AI services. Check your internet connection and try again.");
    }
    const reasons = dropped.map((d) => `  - ${d.agentName}: ${d.error}`).join("\n");
    throw new Error(`Need at least 2 working debaters, got ${debaters.size}.\n${reasons}`);
  }

  const positions = history.map((turns, i) => ({
    round: i + 1,
    positions: turns
      .map((t): Position => ({ label: labels.get(t.agentId)!, text: t.text }))
      .sort((a, b) => a.label.localeCompare(b.label)),
  }));
  const prompt = judgePrompt(topic, positions, length, followUp);

  // A judge whose own debate turns failed probably can't judge either (unless that leaves nobody).
  const healthy = opts.judges.filter((j) => !dropped.some((d) => d.agentName === j.name));
  const judges = healthy.length ? healthy : opts.judges;
  onEvent({ type: "judge-start", judges: judges.map((j) => j.name) });
  const settled = await Promise.allSettled(
    judges.map(async (judge) => {
      const start = Date.now();
      const validLabels = new Set(labels.values());
      let text = await ask(judge, prompt, JUDGE_SYSTEM, "verdict");
      let verdict = sanitizeVerdict(parseVerdict(text), validLabels);
      if (!verdict) {
        // One retry: models occasionally answer in prose despite the instructions.
        text = await ask(
          judge,
          `${prompt}\n\nYour previous reply was not a valid JSON object. Reply again with ONLY the JSON object.`,
          JUDGE_SYSTEM,
          "verdict",
        );
        verdict = sanitizeVerdict(parseVerdict(text), validLabels);
      }
      onEvent({ type: "judge-done", judgeName: judge.name, ms: Date.now() - start, ok: Boolean(verdict) });
      return { judge, text, verdict };
    }),
  );
  if (signal?.aborted) throw new Error("Battle aborted");

  const done = settled.flatMap((s, i) => {
    if (s.status === "fulfilled") return [s.value];
    const error = s.reason instanceof Error ? s.reason.message : String(s.reason);
    onEvent({ type: "judge-failed", judgeName: judges[i].name, error });
    return [];
  });
  if (!done.length) {
    const reason = settled.find((s) => s.status === "rejected") as PromiseRejectedResult;
    throw new Error(`No judge could deliver a verdict: ${reason.reason instanceof Error ? reason.reason.message : reason.reason}`);
  }

  const parsed: JudgeVerdict[] = done
    .filter((d) => d.verdict)
    .map((d) => ({ judgeId: d.judge.id, judgeName: d.judge.name, verdict: d.verdict! }));
  // Scoring yourself is only left out when there are enough debaters for it to be fair to everyone.
  const excludeSelf = parsed.length > 1 && debaters.size >= 3;
  const verdict = parsed.length ? mergePanel(parsed, labels, excludeSelf) : null;
  if (verdict && parsed.length === 1) delete verdict.panel;

  return {
    topic,
    length,
    rounds: history,
    verdict,
    verdictText: done[0].text,
    judges: (parsed.length ? parsed.map((p) => p.judgeName) : [done[0].judge.name]),
    names,
    labels,
    dropped,
    ...(followUp ? { followUpOf: followUp.topic } : {}),
    ...(opts.resume?.length ? { resumedFrom: opts.resume.length } : {}),
  };
}
