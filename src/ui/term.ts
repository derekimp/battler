/** Small, dependency-free terminal styling: colors, ANSI-aware wrapping, inline **bold** / `code`. */

const colorEnabled = (stream: NodeJS.WriteStream) =>
  Boolean(stream.isTTY) && !("NO_COLOR" in process.env) && process.env.TERM !== "dumb";

export interface Style {
  on: boolean;
  bold(s: string): string;
  dim(s: string): string;
  italic(s: string): string;
  red(s: string): string;
  green(s: string): string;
  yellow(s: string): string;
  cyan(s: string): string;
  fg(code: number, s: string): string;
}

export function style(stream: NodeJS.WriteStream): Style {
  const on = colorEnabled(stream);
  const wrap = (open: string, close: string) => (s: string) => (on ? `\x1b[${open}m${s}\x1b[${close}m` : s);
  return {
    on,
    bold: wrap("1", "22"),
    dim: wrap("2", "22"),
    italic: wrap("3", "23"),
    red: wrap("31", "39"),
    green: wrap("32", "39"),
    yellow: wrap("33", "39"),
    cyan: wrap("36", "39"),
    fg: (code, s) => (on ? `\x1b[38;5;${code}m${s}\x1b[39m` : s),
  };
}

/** 256-color code per debater, so each one is recognisable throughout the output. */
const DEBATER_COLORS: Record<string, number> = { Claude: 173, GPT: 78, Grok: 111, Gemini: 141, Kimi: 44, Composer: 220 };
/** Keyed on the family, so "Claude (via Cursor)" is still Claude-colored. */
export const debaterColor = (name: string) => DEBATER_COLORS[name.replace(/\s*\(.*\)$/, "")] ?? 250;

const ANSI = /\x1b\[[0-9;]*m/g;
export const visibleWidth = (s: string) => [...s.replace(ANSI, "")].length;

export function truncate(s: string, width: number): string {
  const chars = [...s];
  if (chars.length <= width) return s;
  return width <= 1 ? "…".slice(0, width) : chars.slice(0, width - 1).join("").trimEnd() + "…";
}

/**
 * Plain one-line preview of a debater's turn: the first line of its (revised) position section
 * if it has one, else the first non-heading line, with Markdown markers stripped.
 */
export function plainPreview(markdown: string): string {
  const lines = markdown.split("\n");
  const section = lines.findIndex((l) => /^\s*#+\s*(revised )?position\b/i.test(l));
  const body = section >= 0 ? lines.slice(section + 1) : lines;
  const line = body.find((l) => l.trim() && !/^\s*#/.test(l)) ?? "";
  return line
    .replace(/\*\*|__|`/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^\s*([-*]|\d+\.)\s+/, "")
    .trim();
}

/** Width of text as it will render, i.e. without the ** and ` markers. */
const markupWidth = (s: string) => [...s.replace(/\*\*|`/g, "")].length;

/** Word-wrap text that may contain **bold** / `code` markers. Paragraph breaks are kept. */
export function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  for (const para of text.split(/\n/)) {
    if (!para.trim()) {
      out.push("");
      continue;
    }
    let line = "";
    for (let word of para.split(/\s+/).filter(Boolean)) {
      while (markupWidth(word) > width) {
        // Hard-break words longer than a whole line (URLs, paths).
        if (line) out.push(line), (line = "");
        out.push(word.slice(0, width));
        word = word.slice(width);
      }
      if (!line) line = word;
      else if (markupWidth(line) + 1 + markupWidth(word) <= width) line += " " + word;
      else out.push(line), (line = word);
    }
    if (line) out.push(line);
  }
  return out;
}

/**
 * Render **bold** and `code` markers on already-wrapped lines. Emphasis may span lines, so the
 * open/closed state is carried across and every line is closed off on its own.
 */
export function inline(lines: string[], st: Style): string[] {
  let bold = false;
  let code = false;
  return lines.map((line) => {
    let out = (bold ? "\x1b[1m" : "") + (code ? "\x1b[36m" : "");
    for (let i = 0; i < line.length; i++) {
      if (line.startsWith("**", i) && !code) {
        bold = !bold;
        out += bold ? "\x1b[1m" : "\x1b[22m";
        i++;
      } else if (line[i] === "`") {
        code = !code;
        out += code ? "\x1b[36m" : "\x1b[39m";
      } else out += line[i];
    }
    out += (bold ? "\x1b[22m" : "") + (code ? "\x1b[39m" : "");
    return st.on ? out : out.replace(ANSI, "");
  });
}

/** Color every occurrence of each debater's name. */
export function colorNames(s: string, names: string[], st: Style): string {
  if (!st.on || !names.length) return s;
  // Longest first, so "Claude (via Cursor)" wins over "Claude"; no trailing \b because names may end in ")".
  const sorted = [...names].sort((a, b) => b.length - a.length);
  const re = new RegExp(`\\b(${sorted.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})(?![\\w])`, "g");
  return s.replace(re, (n) => st.fg(debaterColor(n), n));
}

export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

export function termWidth(stream: NodeJS.WriteStream, max = 100): number {
  return Math.max(40, Math.min(stream.columns || 80, max));
}
