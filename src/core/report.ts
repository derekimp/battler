import type { BattleResult } from "./types.ts";
import { CRITERIA, namedVerdict, panelNote, revealNames, winnerHeadline } from "./verdict.ts";

function secs(ms: number): string {
  return `${Math.round(ms / 1000)}s`;
}

const judgedBy = (judges: string[]) =>
  judges.length === 1 ? judges[0] : `a panel of ${judges.slice(0, -1).join(", ")} and ${judges.at(-1)}`;

const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n+/g, " ");

/** The verdict as Markdown. Short battles get the answer and winner only. */
export function renderVerdictMarkdown(result: BattleResult): string {
  const v = namedVerdict(result);
  if (!v) return revealNames(result.verdictText, result.names).trim() + "\n";

  const winner = `**${winnerHeadline(v)}.**`;
  const parts = [`## Answer\n\n${v.answer}\n\n*Agreement: ${v.agreement}*`];
  if (result.length === "short") {
    const scores = v.scorecard.map((s) => `${s.debater} ${s.score}`).join(" · ");
    parts.push(`${winner} ${v.winner.reason}${scores ? `\n\n${scores}` : ""}`);
    return parts.join("\n\n") + "\n";
  }
  if (v.consensus.length) parts.push(`## Agreed\n\n${v.consensus.map((c) => `- ${c}`).join("\n")}`);
  if (v.disagreements.length) {
    const items = v.disagreements.map(
      (d) => `- **${d.point}**\n${d.sides.map((s) => `  - *${s.debaters.join(", ") || "Others"}:* ${s.view}`).join("\n")}`,
    );
    parts.push(`## Still debated\n\n${items.join("\n")}`);
  }
  if (v.scorecard.length) {
    const withCriteria = v.scorecard.every((s) => s.criteria);
    const extra = withCriteria ? CRITERIA.map((c) => ` ${c[0].toUpperCase() + c.slice(1)} |`).join("") : "";
    const rows = v.scorecard.map(
      (s) =>
        `| ${s.debater} | ${s.score} |${withCriteria ? CRITERIA.map((c) => ` ${s.criteria![c]} |`).join("") : ""} ${cell(s.position)} | ${cell(s.strength)} | ${cell(s.weakness)} |`,
    );
    const header = `| Debater | Score |${extra} Final position | Strongest point | Weakest point |`;
    const rule = `|${"---|".repeat(5 + (withCriteria ? CRITERIA.length : 0))}`;
    const note = panelNote(v);
    parts.push(`## Scorecard\n\n${header}\n${rule}\n${rows.join("\n")}${note ? `\n\n*${note}*` : ""}`);
  }
  parts.push(`## Winner\n\n${winner} ${v.winner.reason}`);
  return parts.join("\n\n") + "\n";
}

/** Full Markdown report: verdict first, then the transcript with real names revealed. */
export function renderReport(result: BattleResult): string {
  const rounds = result.rounds
    .map((turns, i) => {
      const title = i === 0 ? "Round 1: opening statements" : `Round ${i + 1}: rebuttals and revisions`;
      const body = turns
        .map((t) => `### ${t.agentName} · ${secs(t.ms)}\n\n${revealNames(t.text, result.names)}`)
        .join("\n\n");
      return `## ${title}\n\n${body}`;
    })
    .join("\n\n---\n\n");
  const dropped = result.dropped.length
    ? `\n\n> **Dropped:** ${result.dropped.map((d) => `${d.agentName} (round ${d.round}): ${d.error.split("\n")[0]}`).join("; ")}`
    : "";
  const debaters = [...result.names.values()].join(" vs ");

  return `# ${result.topic}

*${debaters} · ${result.rounds.length} round(s) · ${result.length} · judged by ${judgedBy(result.judges)} · ${new Date().toISOString().slice(0, 16).replace("T", " ")}*${dropped}

${renderVerdictMarkdown(result)}
---

# Transcript

Debaters saw each other, and the judges saw them, only as "Debater A/B/C" (shuffled each battle). Real names are shown here.

${rounds}
`;
}
