import {
  AGENT_IDS,
  CURSOR_STAND_INS,
  OPTIONAL_IDS,
  agentFromSpec,
  createAgent,
  cursorAgent,
  cursorModelOf,
  cursorQuota,
  familyName,
  type AgentId,
} from "./adapters/cli-agents.ts";
import type { Config } from "./config.ts";
import type { Agent } from "./core/types.ts";

export interface Lineup {
  agents: Agent[];
  /** Human-readable notes about skipped CLIs and stand-ins. */
  notes: string[];
}

export interface LineupDeps {
  create: (id: AgentId, model?: string) => Agent;
  standIn: (id: "claude" | "codex") => Agent;
}

const defaultDeps: LineupDeps = {
  create: createAgent,
  standIn: (id) => {
    const model = CURSOR_STAND_INS[id];
    return cursorAgent(model, { id: `cursor:${id}`, name: `${familyName(model)} (via Cursor)` });
  },
};

/**
 * Everyone who is ready. If Claude Code or Codex isn't, but Cursor is, Cursor runs that
 * model family instead, so a user with only a Cursor subscription still gets a full battle.
 */
export async function autoLineup(config: Config, deps: LineupDeps = defaultDeps): Promise<Lineup> {
  const candidates = AGENT_IDS.map((id) => deps.create(id, config.models?.[id]));
  const problems = new Map(await Promise.all(candidates.map(async (a) => [a.id, await a.check()] as const)));
  const cursorReady = !problems.get("grok");
  const agents: Agent[] = [];
  const notes: string[] = [];
  for (const a of candidates) {
    const problem = problems.get(a.id);
    if (!problem) {
      agents.push(a);
    } else if (cursorReady && (a.id === "claude" || a.id === "codex")) {
      const sub = deps.standIn(a.id);
      agents.push(sub);
      notes.push(`${a.name}'s own CLI isn't ready (${problem.split(";")[0]}), so ${sub.name} is standing in`);
    } else if (!(OPTIONAL_IDS.includes(a.id as AgentId) && /not found on PATH/.test(problem))) {
      notes.push(`Skipping ${a.name}: ${problem}`);
    }
  }
  return { agents, notes };
}

export function explicitLineup(specs: string[], config: Config): Agent[] {
  return dedupeNames(specs.filter((s) => s.trim()).map((s) => agentFromSpec(s, config.models)));
}

/** "Claude" twice (Claude Code and Cursor's Claude) becomes "Claude" and "Claude (via Cursor)". */
export function dedupeNames(agents: Agent[]): Agent[] {
  const seen = new Map<string, number>();
  return agents.map((a) => {
    let name = a.name;
    if (seen.has(name) && a.id.startsWith("cursor:")) name = `${name} (via Cursor)`;
    const n = (seen.get(name) ?? 0) + 1;
    seen.set(name, n);
    if (n > 1) name = `${name} ${n}`;
    return name === a.name ? a : { ...a, name };
  });
}

/** Default judge: Claude, else GPT, else Grok, else whoever debates first. */
export function defaultJudge(agents: Agent[]): Agent {
  for (const family of ["Claude", "GPT", "Grok"]) {
    const found = agents.find((a) => a.name.startsWith(family));
    if (found) return found;
  }
  return agents[0];
}

/**
 * A note for any debater that runs through Cursor on a model billed to Cursor's "Other Models"
 * allowance, which is easy to exhaust (and can then spill into on-demand spend).
 */
export function quotaNote(agents: Agent[]): string | null {
  const other = agents.filter((a) => {
    const model = cursorModelOf(a);
    return model && cursorQuota(model) === "Other Models";
  });
  if (!other.length) return null;
  const list = other.map((a) => `${a.name} (${cursorModelOf(a)})`).join(", ");
  return `${list} ${other.length === 1 ? "uses" : "use"} Cursor's "Other Models" allowance`;
}
