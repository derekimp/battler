/** Run a planned battle and save everything about it: Markdown, HTML report, and JSON for `continue`. */
import { accessSync, constants, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runBattle } from "./core/battle.ts";
import { message } from "./core/errors.ts";
import { renderReport } from "./core/report.ts";
import { toIncomplete, toSaved, type SavedBattle } from "./core/saved-core.ts";
import type { BattleEvent, BattleResult } from "./core/types.ts";
import { battleSlug, type Plan } from "./plan.ts";
import { renderHtmlReport } from "./ui/html-report.ts";

export interface RunOutput {
  result: BattleResult;
  saved: SavedBattle;
  /** The saved battle's id: its file name without extension. */
  id: string;
  mdFile: string;
  htmlFile: string;
  jsonFile: string;
  /** Set when the battle finished but its files couldn't be written. */
  saveError?: string;
}

/** A battle that failed after some rounds were saved: say how to pick it up again. */
export class BattleError extends Error {
  savedId?: string;
  jsonFile?: string;
  constructor(message: string, savedId?: string, jsonFile?: string) {
    super(message);
    this.savedId = savedId;
    this.jsonFile = jsonFile;
  }
}

/** Make sure battles can be saved before spending anyone's plan on one. */
export function ensureWritable(outDir: string): void {
  try {
    mkdirSync(outDir, { recursive: true });
    accessSync(outDir, constants.W_OK);
  } catch (e) {
    throw new BattleError(`can't save battles in ${outDir}: ${message(e)}. Pick another folder with --out.`);
  }
}

function newId(outDir: string, topic: string, now: Date): string {
  const base = `${now.toISOString().slice(0, 19).replace(/[:T]/g, "-")}-${battleSlug(topic)}`;
  let id = base;
  for (let n = 2; existsSync(join(outDir, `${id}.json`)); n++) id = `${base}-${n}`;
  return id;
}

export async function runPlan(
  plan: Plan,
  opts: { outDir: string; onEvent?: (e: BattleEvent) => void; signal?: AbortSignal; now?: () => Date; retryDelayMs?: number },
): Promise<RunOutput> {
  ensureWritable(opts.outDir);
  const now = opts.now?.() ?? new Date();
  const id = plan.replaces ?? newId(opts.outDir, plan.topic, now);
  const mdFile = join(opts.outDir, `${id}.md`);
  const htmlFile = join(opts.outDir, `${id}.html`);
  const jsonFile = join(opts.outDir, `${id}.json`);
  let savedRounds = 0;

  // Save the rounds as they finish, so a failure later (or Ctrl+C) doesn't lose them.
  const onEvent = (e: BattleEvent) => {
    if (e.type === "round-done") {
      try {
        const partial = toIncomplete(
          { topic: plan.topic, length: plan.length, rounds: e.history, labels: e.labels, followUpOf: plan.followUp?.topic ?? plan.followUpOf },
          plan.agents,
          now,
        );
        writeFileSync(jsonFile, JSON.stringify(partial, null, 2) + "\n");
        savedRounds = e.history.length;
      } catch {
        // Best effort; the final save reports problems.
      }
    }
    opts.onEvent?.(e);
  };

  let result: BattleResult;
  try {
    result = await runBattle({
      topic: plan.topic,
      agents: plan.agents,
      judges: plan.judges,
      rounds: plan.rounds,
      length: plan.length,
      labels: plan.labels,
      resume: plan.resume,
      followUp: plan.followUp,
      signal: opts.signal,
      onEvent,
      retryDelayMs: opts.retryDelayMs,
    });
  } catch (e) {
    // A comparison is a single round, so there's nothing earlier to pick up.
    const hint =
      savedRounds && !plan.compare
        ? `\n${savedRounds === 1 ? "The first round is" : `The ${savedRounds} rounds so far are`} saved; \`battler continue\` will have them judged.`
        : "";
    const resumable = savedRounds && !plan.compare;
    throw new BattleError(`${message(e)}${hint}`, resumable ? id : undefined, resumable ? jsonFile : undefined);
  }
  if (plan.followUpOf && !result.followUpOf) result.followUpOf = plan.followUpOf;

  const saved = toSaved(result, plan.agents, now);
  let saveError: string | undefined;
  try {
    writeFileSync(jsonFile, JSON.stringify(saved, null, 2) + "\n");
    writeFileSync(mdFile, renderReport(result));
    writeFileSync(htmlFile, renderHtmlReport(result));
  } catch (e) {
    saveError = message(e);
  }
  return { result, saved, id, mdFile, htmlFile, jsonFile, ...(saveError ? { saveError } : {}) };
}
