import type { BattleEvent } from "../core/types.ts";
import { revealNames } from "../core/verdict.ts";
import { debaterColor, formatDuration, plainPreview, style, termWidth, truncate } from "./term.ts";

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

interface Row {
  name: string;
  started: number;
  state: "running" | "done" | "failed";
  ms?: number;
  note?: string;
}

/**
 * Battle progress on stderr. On a TTY the current phase is a live block (spinners and ticking
 * timers, redrawn in place); otherwise each line is printed once when it is final.
 */
export class Progress {
  private out = process.stderr;
  private st = style(process.stderr);
  private live = Boolean(process.stderr.isTTY);
  private rows: Row[] = [];
  private drawn = 0;
  private frame = 0;
  private timer?: NodeJS.Timeout;
  private errors: string[] = [];
  private totalRounds: number;
  private nameW: number;
  private names: Map<string, string>;

  constructor(opts: { topic: string; agents: string[]; judges: string[]; rounds: number; length: string; skipped: string[] }) {
    const { st } = this;
    this.totalRounds = opts.rounds;
    this.names = new Map();
    this.nameW = Math.max(...opts.agents.map((n) => n.length), ...opts.judges.map((n) => n.length));
    const w = termWidth(this.out);
    const vs = opts.agents.map((n) => st.fg(debaterColor(n), st.bold(n))).join(st.dim(" vs "));
    this.print("");
    for (const s of opts.skipped) this.print(`  ${st.yellow("!")} ${st.dim(s)}`);
    this.print(`  ${vs}`);
    for (const line of wrapPlain(opts.topic, w - 4)) this.print(`  ${st.bold(line)}`);
    this.print(st.dim(`  ${opts.length} · ${opts.rounds} round${opts.rounds > 1 ? "s" : ""} · judged by ${describeJudges(opts.judges)}`));
    if (this.live) {
      this.out.write("\x1b[?25l"); // hide cursor while redrawing
      const restore = () => this.out.write("\x1b[?25h");
      process.once("exit", restore);
    }
  }

  handle(e: BattleEvent): void {
    switch (e.type) {
      case "start":
        this.names = e.names;
        return;
      case "round-start":
        return this.phase(
          `Round ${e.round}/${this.totalRounds} · ${e.round === 1 ? "Opening statements" : "Rebuttals and revisions"}`,
          e.agents,
        );
      case "turn-done":
        return this.update(e.turn.agentName, { state: "done", ms: e.turn.ms, note: revealNames(plainPreview(e.turn.text), this.names) });
      case "turn-failed":
        this.errors.push(`${e.agentName}: ${e.error}`);
        return this.update(e.agentName, { state: "failed", note: e.error.split("\n")[0] });
      case "judge-start":
        return this.phase(e.judges.length > 1 ? "Verdict · judge panel" : "Verdict", e.judges, "judging");
      case "judge-done":
        return this.update(e.judgeName, e.ok ? { state: "done", ms: e.ms, note: "" } : { state: "failed", ms: e.ms, note: "no usable verdict (left out)" });
      case "judge-failed":
        this.errors.push(`${e.judgeName}: ${e.error}`);
        return this.update(e.judgeName, { state: "failed", note: e.error.split("\n")[0] });
    }
  }

  finish(...lines: string[]): void {
    this.settle();
    this.print("", ...lines.map((l) => `  ${this.st.dim(l)}`));
  }

  fail(): void {
    this.settle();
    if (this.live) this.out.write("\x1b[?25h");
  }

  private phase(title: string, names: string[], runningNote = ""): void {
    this.settle();
    this.print("", `  ${this.st.bold(title)}`);
    const now = Date.now();
    this.rows = names.map((name) => ({ name, started: now, state: "running", note: runningNote }));
    this.drawn = 0;
    if (this.live) {
      this.draw();
      this.timer = setInterval(() => this.draw(), 80);
    }
  }

  private update(name: string, patch: Partial<Row>): void {
    const row = this.rows.find((r) => r.name === name);
    if (!row) return;
    Object.assign(row, patch);
    if (this.live) this.draw();
    else this.print(this.render(row));
    if (this.rows.every((r) => r.state !== "running")) this.settle();
  }

  /** Freeze the current block and print any errors from it in full. */
  private settle(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (this.live && this.rows.length) this.draw();
    this.rows = [];
    this.drawn = 0;
    for (const err of this.errors) {
      for (const line of err.split("\n")) this.print(`      ${this.st.dim(line)}`);
    }
    this.errors = [];
  }

  private draw(): void {
    this.frame++;
    let buf = this.drawn ? `\x1b[${this.drawn}A` : "";
    for (const row of this.rows) buf += `\x1b[2K${this.render(row)}\n`;
    this.out.write(buf);
    this.drawn = this.rows.length;
  }

  private render(row: Row): string {
    const { st } = this;
    const icon =
      row.state === "done" ? st.green("✓") : row.state === "failed" ? st.red("✗") : st.cyan(SPINNER[this.frame % SPINNER.length]);
    const secs = formatDuration(row.ms ?? Date.now() - row.started).padStart(6);
    const name = st.fg(debaterColor(row.name), row.name.padEnd(this.nameW));
    const lead = 4 + 2 + this.nameW + 1 + 6 + 2;
    const room = termWidth(this.out, 1000) - lead - 1;
    const note = row.note ? truncate(row.note, room) : "";
    const noteStyled = row.state === "failed" ? st.red(note) : st.dim(note);
    return `    ${icon} ${name} ${st.dim(secs)}  ${noteStyled}`;
  }

  private print(...lines: string[]): void {
    for (const l of lines) this.out.write(l + "\n");
  }
}

function wrapPlain(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (line && line.length + 1 + word.length > width) lines.push(line), (line = word);
    else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  return lines;
}

/** "Claude", or "a panel: Claude, GPT and Grok". */
export function describeJudges(judges: string[]): string {
  if (judges.length === 1) return judges[0];
  return `a panel: ${judges.slice(0, -1).join(", ")} and ${judges.at(-1)}`;
}
