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

// Characters a terminal draws two columns wide: CJK ideographs, kana, hangul, fullwidth forms,
// CJK punctuation and most emoji.
const WIDE = "\\u1100-\\u115F\\u2E80-\\u303E\\u3041-\\u33FF\\u3400-\\u4DBF\\u4E00-\\u9FFF\\uA000-\\uA4CF\\uAC00-\\uD7A3\\uF900-\\uFAFF\\uFE30-\\uFE4F\\uFF00-\\uFF60\\uFFE0-\\uFFE6\\u{1F300}-\\u{1F64F}\\u{1F900}-\\u{1F9FF}\\u{20000}-\\u{3FFFD}";
const WIDE_CHAR = new RegExp(`[${WIDE}]`, "u");
const ZERO_WIDTH = /[\u0300-\u036F\u200B-\u200F\uFE00-\uFE0F]/u;

/** Columns one character takes in a terminal. */
export function charWidth(ch: string): number {
  if (ZERO_WIDTH.test(ch)) return 0;
  return WIDE_CHAR.test(ch) ? 2 : 1;
}

const textWidth = (s: string) => {
  let w = 0;
  for (const ch of s) w += charWidth(ch);
  return w;
};

/** Columns a string takes on screen, ignoring ANSI color codes. */
export const visibleWidth = (s: string) => textWidth(s.replace(ANSI, ""));

/** Cut plain text to at most `width` columns, ending in "…" if anything was cut. */
export function truncate(s: string, width: number): string {
  if (textWidth(s) <= width) return s;
  if (width <= 1) return "…".slice(0, width);
  let out = "";
  let w = 0;
  for (const ch of s) {
    const cw = charWidth(ch);
    if (w + cw > width - 1) break;
    out += ch;
    w += cw;
  }
  return out.trimEnd() + "…";
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
const markupWidth = (s: string) => textWidth(s.replace(/\*\*|`/g, ""));

/** Split `s` so the head is at most `width` columns (markers count as zero). */
function splitAtWidth(s: string, width: number): [string, string] {
  let w = 0;
  let i = 0;
  const chars = [...s];
  for (; i < chars.length; i++) {
    const ch = chars[i];
    const cw = ch === "`" || (ch === "*" && (chars[i + 1] === "*" || chars[i - 1] === "*")) ? 0 : charWidth(ch);
    if (w + cw > width) break;
    w += cw;
  }
  return [chars.slice(0, Math.max(1, i)).join(""), chars.slice(Math.max(1, i)).join("")];
}

// Tokens: whitespace, a single wide character (lines may break between CJK characters), or a
// run of anything else (a word).
const TOKEN = new RegExp(`\\s+|[${WIDE}]|[^\\s${WIDE}]+`, "gu");
// CJK and Western closing punctuation must not start a line.
const NO_LINE_START = /^[，。、：；！？）」』】》〉,.!?;:)\]}%]/u;

/**
 * Word-wrap text that may contain **bold** / `code` markers to `width` columns. Paragraph breaks
 * are kept. Handles CJK text, which is double width and has no spaces between words.
 */
export function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  for (const para of text.split(/\n/)) {
    if (!para.trim()) {
      out.push("");
      continue;
    }
    let line = "";
    let space = false;
    const flush = () => {
      if (line) out.push(line);
      line = "";
      space = false;
    };
    for (let tok of para.match(TOKEN) ?? []) {
      if (/^\s+$/.test(tok)) {
        space = line.length > 0;
        continue;
      }
      // Words longer than a whole line (URLs, paths) are hard-broken.
      while (markupWidth(tok) > width) {
        flush();
        const [head, rest] = splitAtWidth(tok, width);
        out.push(head);
        tok = rest;
      }
      const sep = space && line ? " " : "";
      if (line && markupWidth(line) + sep.length + markupWidth(tok) > width) {
        if (!sep && NO_LINE_START.test(tok)) {
          // Carry the previous character down so the punctuation isn't alone at the start.
          const chars = [...line];
          const carried = chars.pop()!;
          line = chars.join("");
          flush();
          line = carried + tok;
          continue;
        }
        flush();
        line = tok;
        continue;
      }
      line += sep + tok;
      space = false;
    }
    flush();
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
