import type { BattleResult } from "../core/types.ts";
import { CRITERIA, namedVerdict, panelNote, revealNames, winnerDetail } from "../core/verdict.ts";
import { colorNames, debaterColor, inline, visibleWidth, wrap, type Style } from "./term.ts";

function bar(score: number, st: Style, color: number): string {
  const full = Math.floor(score);
  const half = score - full >= 0.5;
  const filled = "█".repeat(full) + (half ? "▌" : "");
  return st.fg(color, filled) + st.dim("░".repeat(10 - full - (half ? 1 : 0)));
}

const fmtScore = (n: number) => (Number.isInteger(n) ? `${n}.0` : n.toFixed(1)).padStart(4);

/** Compare mode: each AI's answer in full, one after another. */
function renderAnswers(result: BattleResult, st: Style, width: number): string {
  const names = [...result.names.values()];
  const paint = (lines: string[]) => inline(lines, st).map((l) => colorNames(l, names, st));
  const out: string[] = [""];
  for (const t of result.rounds.at(-1) ?? []) {
    const color = debaterColor(t.agentName);
    const title = ` ${st.fg(color, st.bold(t.agentName))} ${st.dim(`${Math.round(t.ms / 1000)}s`)} `;
    out.push(`  ${st.fg(color, "──")}${title}${st.fg(color, "─".repeat(Math.max(2, width - 6 - visibleWidth(title))))}`, "");
    for (const raw of revealNames(t.text, result.names).trim().split("\n")) {
      const heading = raw.match(/^#{1,6}\s+(.*)$/);
      if (heading) {
        if (out.at(-1) !== "") out.push("");
        out.push(`  ${st.bold(heading[1])}`);
        continue;
      }
      if (!raw.trim()) {
        if (out.at(-1) !== "") out.push("");
        continue;
      }
      const bullet = raw.match(/^(\s*(?:[-*+]|\d+[.)])\s+)(.*)$/);
      const lead = bullet ? bullet[1].replace(/^\s+/, "").replace(/^[-*+]/, "•") : "";
      const pad = " ".repeat(visibleWidth(lead));
      paint(wrap(bullet ? bullet[2] : raw.trim(), width - 4 - pad.length)).forEach((l, i) => out.push(`  ${i ? pad : lead}${l}`));
    }
    out.push("");
  }
  return out.join("\n");
}

/** Terminal rendering of the verdict. `width` is the full line width to fit in. */
export function renderVerdict(result: BattleResult, st: Style, width: number): string {
  if (result.compare) return renderAnswers(result, st, width);
  const names = [...result.names.values()];
  const paint = (lines: string[]) => inline(lines, st).map((l) => colorNames(l, names, st));
  const v = namedVerdict(result);
  const out: string[] = [""];

  if (!v) {
    // The judge never returned valid JSON: show its prose as-is.
    out.push(...paint(wrap(revealNames(result.verdictText, result.names), width - 4)).map((l) => "  " + l), "");
    return out.join("\n");
  }

  // ── Answer box ──────────────────────────────────────────
  const boxW = width - 2;
  const inner = boxW - 2;
  const agreementColor = { strong: st.green, partial: st.yellow, split: st.red }[v.agreement];
  const title = ` ${st.bold("Verdict")} `;
  const tag = ` ${agreementColor(`${v.agreement} agreement`)} `;
  const dashes = inner - 1 - visibleWidth(title) - visibleWidth(tag) - 1;
  const edge = (s: string) => st.dim(s);
  out.push(`  ${edge("╭─")}${title}${edge("─".repeat(Math.max(1, dashes)))}${tag}${edge("─╮")}`);
  const boxLine = (s: string) => `  ${edge("│")}  ${s}${" ".repeat(Math.max(0, inner - 4 - visibleWidth(s)))}  ${edge("│")}`;
  out.push(boxLine(""));
  for (const l of paint(wrap(v.answer, inner - 4))) out.push(boxLine(l));
  out.push(boxLine(""));
  out.push(`  ${edge("╰" + "─".repeat(inner) + "╯")}`);

  const winnerLine = () => {
    const detail = winnerDetail(v);
    const who =
      v.winner.debater === "Tie"
        ? st.bold(v.panel ? "No clear winner" : "Tie")
        : `${colorNames(st.bold(v.winner.debater), names, st)} ${st.bold("wins")}` + (detail ? st.dim(`  ${detail}`) : "");
    const lead = `  ${st.yellow("★")} ${who}  `;
    const body = paint(wrap(v.winner.reason, width - 6));
    out.push("", lead.trimEnd());
    for (const l of body) out.push(`    ${st.dim(l)}`);
  };

  const note = panelNote(v);
  const noteLines = () => {
    if (note) for (const l of wrap(note, width - 4)) out.push(`  ${st.dim(l)}`);
  };

  if (result.length === "short") {
    winnerLine();
    if (v.scorecard.length) {
      const scores = v.scorecard.map((s) => `${colorNames(s.debater, names, st)} ${fmtScore(s.score).trim()}`).join(st.dim("  ·  "));
      out.push(`    ${scores}`);
    }
    if (note) out.push("");
    noteLines();
    out.push("");
    return out.join("\n");
  }

  const heading = (s: string) => out.push("", `  ${st.bold(s)}`);
  const bullets = (items: string[], bullet: string) => {
    for (const item of items) {
      paint(wrap(item, width - 6)).forEach((l, i) => out.push(`  ${i ? " " : bullet} ${l}`));
    }
  };

  // ── Consensus ───────────────────────────────────────────
  if (v.consensus.length) {
    heading("Agreed");
    bullets(v.consensus, st.green("✓"));
  }

  // ── Disagreements ───────────────────────────────────────
  if (v.disagreements.length) {
    heading("Still debated");
    for (const d of v.disagreements) {
      paint(wrap(d.point, width - 6)).forEach((l, i) => out.push(`  ${i ? " " : st.yellow("≠")} ${st.bold(l)}`));
      const labelW = Math.min(18, Math.max(...d.sides.map((s) => s.debaters.join(", ").length)));
      for (const side of d.sides) {
        const who = side.debaters.join(", ") || "Others";
        const textW = width - 6 - labelW - 2;
        if (who.length > labelW || textW < 24) {
          out.push(`    ${colorNames(who, names, st)}`);
          for (const l of paint(wrap(side.view, width - 8))) out.push(`      ${l}`);
        } else {
          paint(wrap(side.view, textW)).forEach((l, i) =>
            out.push(`    ${i ? " ".repeat(labelW) : colorNames(who, names, st) + " ".repeat(labelW - who.length)}  ${l}`),
          );
        }
      }
      out.push("");
    }
    out.pop();
  }

  // ── Scorecard ───────────────────────────────────────────
  if (v.scorecard.length) {
    heading("Scorecard");
    const nameW = Math.max(...v.scorecard.map((s) => s.debater.length));
    const lead = 2 + nameW + 2 + 10 + 1 + 4 + 3;
    const textW = width - lead;
    for (const s of v.scorecard) {
      const color = debaterColor(s.debater);
      const head = `  ${st.fg(color, st.bold(s.debater.padEnd(nameW)))}  ${bar(s.score, st, color)} ${st.bold(fmtScore(s.score))}   `;
      const w = Math.max(20, textW);
      const lines = paint(wrap(s.position, w));
      if (result.length === "long") {
        const marked = (text: string, mark: string) =>
          paint(wrap(text, w - 2)).map((l, i) => `${i ? " " : mark} ${l}`);
        if (s.strength) lines.push(...marked(s.strength, st.green("+")));
        if (s.weakness) lines.push(...marked(s.weakness, st.red("−")));
        if (s.criteria) {
          const parts = CRITERIA.map((c) => `${c} ${s.criteria![c]}`).join(" · ");
          lines.push(...wrap(parts, w).map((l) => st.dim(l)));
        }
      }
      if (textW < 20) {
        out.push(head.trimEnd());
        for (const l of lines) out.push(`      ${l}`);
      } else {
        lines.forEach((l, i) => out.push(i ? " ".repeat(lead) + l : head + l));
      }
      if (result.length === "long") out.push("");
    }
    if (result.length === "long") out.pop();
    if (note) out.push("");
    noteLines();
  }

  winnerLine();
  out.push("");
  return out.join("\n");
}
