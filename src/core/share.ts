/**
 * Sharing a battle: the few facts that fit on an image card, and a link to the full report as a
 * secret GitHub Gist (made with the user's own `gh` login).
 */
import { spawn } from "node:child_process";
import { renderReport } from "./report.ts";
import type { BattleResult } from "./types.ts";
import { namedVerdict, revealNames, winnerHeadline } from "./verdict.ts";
import { plainPreview } from "../ui/term.ts";

export const PROJECT_URL = "github.com/derekimp/battler";

export interface ShareCard {
  topic: string;
  followUpOf: string | null;
  compare: boolean;
  /** "GPT wins", "Tie"… (debates only) */
  headline: string | null;
  winner: string | null;
  /** The consolidated answer, plain text (debates only). */
  answer: string | null;
  agreement: string | null;
  scores: { name: string; score: number }[];
  /** Each AI's position in a line or two (comparisons, and debates without a parsed verdict). */
  positions: { name: string; text: string }[];
}

const plain = (s: string) =>
  s
    .replace(/\*\*|__|`/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();

export function shareCard(result: BattleResult): ShareCard {
  const v = namedVerdict(result);
  const positions = (result.rounds.at(-1) ?? []).map((t) => ({ name: t.agentName, text: plainPreview(revealNames(t.text, result.names)) }));
  return {
    topic: result.topic,
    followUpOf: result.followUpOf ?? null,
    compare: Boolean(result.compare),
    headline: v ? winnerHeadline(v) : null,
    winner: v && v.winner.debater !== "Tie" ? v.winner.debater : null,
    answer: v ? plain(v.answer) : null,
    agreement: v?.agreement ?? null,
    scores: v ? v.scorecard.map((s) => ({ name: s.debater, score: s.score })) : [],
    positions,
  };
}

/** The Markdown that goes in a shared gist: the full report, plus where it came from. */
export function shareMarkdown(result: BattleResult): string {
  return `${renderReport(result).trimEnd()}\n\n---\n\n*Made with [battler](https://${PROJECT_URL}): Claude, ChatGPT and Grok debating each other, using your own subscriptions.*\n`;
}

/**
 * Upload the report as a secret gist with `gh` and return its URL. Secret means unlisted: anyone
 * with the link can read it.
 */
export function createGist(markdown: string, filename: string, description: string, gh = "gh"): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(gh, ["gist", "create", "--filename", filename, "--desc", description, "-"], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e: NodeJS.ErrnoException) =>
      reject(new Error(e.code === "ENOENT" ? "Sharing a link needs the GitHub CLI: brew install gh, then gh auth login." : e.message)),
    );
    child.on("close", (code) => {
      const url = out.match(/https:\/\/gist\.github\.com\/\S+/)?.[0];
      if (code === 0 && url) return resolve(url);
      if (/auth login|not logged|authenticat/i.test(err)) return reject(new Error("Sign in to GitHub first: gh auth login"));
      reject(new Error(`Couldn't create the gist: ${(err || out).trim().split("\n").at(-1) || `gh exited with ${code}`}`));
    });
    child.stdin.end(markdown);
  });
}
