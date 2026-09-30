import type { Agent, BattleResult } from "./types.ts";
import { anonLabel } from "./battle.ts";

function secs(ms: number): string {
  return `${(ms / 1000).toFixed(0)}s`;
}

/** Full Markdown report: verdict first, then the transcript with real names revealed. */
export function renderReport(result: BattleResult, agents: Agent[]): string {
  const key = agents.map((a, i) => `| ${anonLabel(i)} | ${a.name} |`).join("\n");
  const rounds = result.rounds
    .map((turns, i) => {
      const title = i === 0 ? "Round 1: opening statements" : `Round ${i + 1}: debate`;
      const body = turns
        .map((t) => {
          const label = anonLabel(agents.findIndex((a) => a.id === t.agentId));
          return `### ${t.agentName} (${label}) · ${secs(t.ms)}\n\n${t.text}`;
        })
        .join("\n\n");
      return `## ${title}\n\n${body}`;
    })
    .join("\n\n---\n\n");
  const dropped = result.dropped.length
    ? `\n\n> **Dropped:** ${result.dropped.map((d) => `${d.agentName} (round ${d.round}): ${d.error}`).join("; ")}`
    : "";

  return `# Battle: ${result.topic}

*${new Date().toISOString().slice(0, 16).replace("T", " ")} · ${result.rounds.length} round(s) · judged by ${result.judgeName}*${dropped}

# Verdict

${result.verdict}

## Who was who

| Label | Debater |
|---|---|
${key}

---

# Transcript

${rounds}
`;
}
