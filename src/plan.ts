/**
 * Turning a request (from the terminal or the web UI) into a runnable battle: who debates, who
 * judges, how long, and whether it continues an earlier battle.
 */
import { relative } from "node:path";
import { agentFromSpec } from "./adapters/cli-agents.ts";
import type { Config } from "./config.ts";
import type { FollowUp } from "./core/battle.ts";
import { finalPositions, savedAnswer, type SavedBattle } from "./core/saved.ts";
import type { Agent, Turn } from "./core/types.ts";
import { LENGTHS, type Length } from "./core/verdict.ts";
import { truncate } from "./ui/term.ts";
import { autoLineup, defaultJudge, explicitLineup, quotaNote } from "./lineup.ts";

/** A problem with the request itself, with a message meant for the user. */
export class PlanError extends Error {}

/** Everything needed to run one battle. */
export interface Plan {
  topic: string;
  agents: Agent[];
  judges: Agent[];
  rounds: number;
  length: Length;
  /** Things worth telling the user before it starts (skipped CLIs, stand-ins, allowances). */
  notes: string[];
  labels?: Map<string, string>;
  resume?: Turn[][];
  followUp?: FollowUp;
  /** Carried over from a continued battle that was itself a follow-up. */
  followUpOf?: string;
}

export const displayPath = (f: string) => (relative(process.cwd(), f).startsWith("..") ? f : relative(process.cwd(), f));

function checkLength(length: string): Length {
  if (!LENGTHS.includes(length as Length)) throw new PlanError(`length must be one of ${LENGTHS.join(", ")}`);
  return length as Length;
}

function checkRounds(rounds: number): number {
  if (!Number.isInteger(rounds) || rounds < 1 || rounds > 5) throw new PlanError("rounds must be 1-5");
  return rounds;
}

/** Judges: a panel of the debaters themselves, or one agent. Short battles default to one to save usage. */
export function pickJudges(agents: Agent[], length: Length, requested: string | undefined, config: Config): Agent[] {
  const spec = requested ?? (length === "short" ? undefined : "panel");
  if (spec?.trim().toLowerCase() === "panel") {
    const lead = defaultJudge(agents);
    return [lead, ...agents.filter((a) => a !== lead)];
  }
  try {
    return [spec ? agentFromSpec(spec, config.models) : defaultJudge(agents)];
  } catch (e) {
    throw new PlanError((e as Error).message);
  }
}

/** A new battle. Without `agents`, everyone whose CLI is ready debates (Cursor stands in if needed). */
export async function newPlan(req: {
  topic: string;
  length: string;
  rounds: number;
  agents?: string[];
  judge?: string;
  config: Config;
}): Promise<Plan> {
  const topic = req.topic.trim();
  if (!topic) throw new PlanError("no topic given");
  const length = checkLength(req.length);
  const rounds = checkRounds(req.rounds);
  let agents: Agent[];
  let notes: string[] = [];
  if (req.agents) {
    try {
      agents = explicitLineup(req.agents, req.config);
    } catch (e) {
      throw new PlanError((e as Error).message);
    }
  } else {
    ({ agents, notes } = await autoLineup(req.config));
    if (agents.length < 2) {
      throw new PlanError(
        `need at least 2 AI CLIs installed and logged in (or just Cursor).\n  ${notes.join("\n  ")}\n\n  Run \`battler setup\` to install and log in step by step.`,
      );
    }
  }
  if (new Set(agents.map((a) => a.id)).size !== agents.length) throw new PlanError("each debater can only appear once");
  if (agents.length < 2) throw new PlanError("need at least 2 debaters");
  if (agents.length > 6) throw new PlanError("at most 6 debaters");
  const note = quotaNote(agents);
  return {
    topic,
    agents,
    judges: pickJudges(agents, length, req.judge ?? req.config.judge, req.config),
    rounds,
    length,
    notes: note ? [...notes, note] : notes,
  };
}

/**
 * Continue a saved battle: with a question, a follow-up debate that has the earlier one as
 * background; without, more rounds on the same topic. Same debaters, same labels.
 */
export function continuePlan(
  saved: SavedBattle,
  from: string,
  question: string,
  opts: { length?: string; rounds?: number; config: Config; judge?: string },
): Plan {
  const agents = saved.agents.map((a) => {
    try {
      return { ...agentFromSpec(a.spec ?? a.id), id: a.id, name: a.name };
    } catch (e) {
      throw new PlanError(`can't recreate ${a.name} from ${displayPath(from)}: ${(e as Error).message}`);
    }
  });
  const length = checkLength(opts.length ?? saved.length);
  const labels = new Map(saved.labels);
  const judges = pickJudges(agents, length, opts.judge ?? opts.config.judge, opts.config);
  const source = `Continuing ${displayPath(from.replace(/\.json$/, ".html"))}`;
  const note = quotaNote(agents);
  if (question.trim()) {
    return {
      topic: question.trim(),
      agents,
      judges,
      length,
      labels,
      rounds: checkRounds(opts.rounds ?? opts.config.rounds ?? 2),
      followUp: { topic: saved.topic, answer: savedAnswer(saved), finals: finalPositions(saved) },
      notes: note ? [source, note] : [source],
    };
  }
  const so = `${saved.rounds.length} round${saved.rounds.length === 1 ? "" : "s"} so far`;
  return {
    topic: saved.topic,
    agents,
    judges,
    length,
    labels,
    rounds: checkRounds(opts.rounds ?? 1),
    resume: saved.rounds,
    followUpOf: saved.followUpOf,
    notes: note ? [`${source} · ${so}`, note] : [`${source} · ${so}`],
  };
}

/** File-name part for a topic: letters in any script (a Chinese topic keeps its Chinese), ~40 columns. */
export function battleSlug(topic: string): string {
  const slug = topic.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "");
  return truncate(slug, 41).replace(/…$/, "").replace(/-$/, "") || "battle";
}
