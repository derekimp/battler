import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Agent, AskOptions } from "../src/core/types.ts";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const FAKE_BIN = join(ROOT, "test", "fixtures", "bin");

/** In-process debater for engine tests: records prompts and answers via `reply`. */
export function fakeAgent(
  id: string,
  reply: (prompt: string, opts: AskOptions) => string | Promise<string> = () => `## Position\n${id} says hi.`,
  name = id,
): Agent & { prompts: string[] } {
  const prompts: string[] = [];
  return {
    id,
    name,
    prompts,
    async ask(prompt, opts = {}) {
      prompts.push(prompt);
      return reply(prompt, opts);
    },
    async check() {
      return null;
    },
  };
}

/** A judge reply that scores every "### Debater X" label found in the prompt. */
export function verdictJson(prompt: string, overrides: Record<string, unknown> = {}): string {
  const labels = [...new Set([...prompt.matchAll(/### (Debater [A-Z])/g)].map((m) => m[1]))];
  return JSON.stringify({
    answer: "The answer.",
    agreement: "strong",
    consensus: ["Point one."],
    disagreements: [],
    scorecard: labels.map((d, i) => ({ debater: d, position: "p", strength: "s", weakness: "w", score: 9 - i })),
    winner: { debater: labels[0], reason: `${labels[0]} was best.` },
    ...overrides,
  });
}

export const identity = <T>(xs: T[]) => [...xs];
