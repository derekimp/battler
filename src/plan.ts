/**
 * Turning a request (from the terminal or the web UI) into a runnable battle: who debates, who
 * judges, how long, and whether it continues an earlier battle.
 */
import { basename, relative } from "node:path";
import { agentFromSpec, FORMER_GROK_DEFAULTS } from "./adapters/cli-agents.ts";
import type { Config } from "./config.ts";
import type { FollowUp } from "./core/battle.ts";
import { finalPositions, savedAnswer, type SavedBattle } from "./core/saved.ts";
import type { Agent, Turn } from "./core/types.ts";
import { LENGTHS, type Length } from "./core/verdict.ts";
import { truncate } from "./ui/term.ts";
import { autoLineup, defaultJudge, explicitLineup, quotaNote } from "./lineup.ts";

/** Prompts carry the topic on the command line for some CLIs; keep it well inside OS limits. */
export const MAX_TOPIC = 10_000;

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
  /** Save under this battle id, replacing it (finishing an interrupted battle). */
  replaces?: string;
}

export const displayPath = (f: string) => (relative(process.cwd(), f).startsWith("..") ? f : relative(process.cwd(), f));

function checkLength(length: string): Length {
  if (!LENGTHS.includes(length as Length)) throw new PlanError(`length must be one of ${LENGTHS.join(", ")}`);
  return length as Length;
}

function checkRounds(rounds: number, min = 1): number {
  if (!Number.isInteger(rounds) || rounds < min || rounds > 5) throw new PlanError(`rounds must be ${min}-5`);
  return rounds;
}

type Checker = (agent: Agent) => Promise<string | null>;
const defaultCheck: Checker = (a) => a.check();

/** Readiness problems, by agent id, for agents that aren't ready. */
async function problems(agents: Agent[], check: Checker): Promise<Map<string, string>> {
  const unique = [...new Map(agents.map((a) => [a.id, a])).values()];
  const results = await Promise.all(unique.map(async (a) => [a, await check(a).catch((e: Error) => e.message)] as const));
  return new Map(results.filter(([, p]) => p).map(([a, p]) => [a.id, `${a.name}: ${p}`]));
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
  check?: Checker;
}): Promise<Plan> {
  const topic = req.topic.trim();
  if (!topic) throw new PlanError("no topic given");
  if (topic.length > MAX_TOPIC) throw new PlanError(`the topic is ${topic.length.toLocaleString()} characters; keep it under ${MAX_TOPIC.toLocaleString()}`);
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
  const judges = pickJudges(agents, length, req.judge ?? req.config.judge, req.config);
  // Hand-picked debaters and judges get checked before anyone's plan is spent on the battle.
  const toCheck = [...(req.agents ? agents : []), ...judges.filter((j) => !agents.some((a) => a.id === j.id))];
  if (toCheck.length) {
    const found = await problems(toCheck, req.check ?? defaultCheck);
    if (found.size) throw new PlanError(`not ready:\n  ${[...found.values()].join("\n  ")}\n\n  Run \`battler --doctor\` for details.`);
  }
  const note = quotaNote(agents);
  return { topic, agents, judges, rounds, length, notes: note ? [...notes, note] : notes };
}

/**
 * Continue a saved battle: with a question, a follow-up debate that has the earlier one as
 * background; without, more rounds on the same topic (or, for a battle that stopped before its
 * verdict, just the judging). Same debaters and labels, minus any that aren't ready any more.
 */
export async function continuePlan(
  saved: SavedBattle,
  from: string,
  question: string,
  opts: { length?: string; rounds?: number; config: Config; judge?: string; check?: Checker },
): Promise<Plan> {
  const all = saved.agents.map((a) => {
    try {
      return { ...agentFromSpec(currentSpec(a)), id: a.id, name: a.name };
    } catch (e) {
      throw new PlanError(`can't recreate ${a.name} from ${displayPath(from)}: ${(e as Error).message}`);
    }
  });
  const unready = await problems(all, opts.check ?? defaultCheck);
  const agents = all.filter((a) => !unready.has(a.id));
  if (agents.length < 2) {
    throw new PlanError(`can't continue: fewer than 2 of its debaters are ready.\n  ${[...unready.values()].join("\n  ")}`);
  }
  const length = checkLength(opts.length ?? saved.length);
  const labels = new Map(saved.labels);
  const judges = pickJudges(agents, length, opts.judge ?? opts.config.judge, opts.config);
  const source = `Continuing ${displayPath(from.replace(/\.json$/, ".html"))}`;
  const extra = [...unready.values()].map((p) => `Leaving out ${p}`);
  const note = quotaNote(agents);
  const notes = (first: string) => [first, ...extra, ...(note ? [note] : [])];
  if (question.trim().length > MAX_TOPIC) throw new PlanError(`the question is too long; keep it under ${MAX_TOPIC.toLocaleString()} characters`);
  if (question.trim()) {
    const answer = saved.incomplete ? "(That debate stopped before the judges gave a verdict.)" : savedAnswer(saved);
    return {
      topic: question.trim(),
      agents,
      judges,
      length,
      labels,
      rounds: checkRounds(opts.rounds ?? opts.config.rounds ?? 2),
      followUp: { topic: saved.topic, answer, finals: finalPositions(saved) },
      notes: notes(source),
    };
  }
  const so = `${saved.rounds.length} round${saved.rounds.length === 1 ? "" : "s"} so far`;
  // A battle that stopped before its verdict gets judged; a finished one gets another round.
  const rounds = checkRounds(opts.rounds ?? (saved.incomplete ? 0 : 1), saved.incomplete ? 0 : 1);
  return {
    topic: saved.topic,
    agents,
    judges,
    length,
    labels,
    rounds,
    resume: saved.rounds,
    followUpOf: saved.followUpOf,
    ...(saved.incomplete ? { replaces: basename(from).replace(/\.(json|html|md)$/, "") } : {}),
    notes: notes(`${source} · ${so}${saved.incomplete && rounds === 0 ? " · judging it now" : ""}`),
  };
}

/**
 * The spec to recreate a saved debater with. Battles saved by earlier versions recorded Grok's
 * default model explicitly; those follow today's default instead of pinning the old one.
 */
function currentSpec(a: { id: string; spec?: string }): string {
  const spec = a.spec ?? a.id;
  if (a.id === "grok" && FORMER_GROK_DEFAULTS.some((m) => spec === `cursor:${m}`)) return "grok";
  return spec;
}

/** File-name part for a topic: letters in any script (a Chinese topic keeps its Chinese), ~40 columns. */
export function battleSlug(topic: string): string {
  const slug = topic.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "");
  return truncate(slug, 41).replace(/…$/, "").replace(/-$/, "") || "battle";
}
