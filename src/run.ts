/** Run a planned battle and save everything about it: Markdown, HTML report, and JSON for `continue`. */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runBattle } from "./core/battle.ts";
import { renderReport } from "./core/report.ts";
import { toSaved, type SavedBattle } from "./core/saved.ts";
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
}

export async function runPlan(
  plan: Plan,
  opts: { outDir: string; onEvent?: (e: BattleEvent) => void; signal?: AbortSignal; now?: () => Date },
): Promise<RunOutput> {
  const result = await runBattle({
    topic: plan.topic,
    agents: plan.agents,
    judges: plan.judges,
    rounds: plan.rounds,
    length: plan.length,
    labels: plan.labels,
    resume: plan.resume,
    followUp: plan.followUp,
    signal: opts.signal,
    onEvent: opts.onEvent,
  });
  if (plan.followUpOf && !result.followUpOf) result.followUpOf = plan.followUpOf;

  const now = opts.now?.() ?? new Date();
  mkdirSync(opts.outDir, { recursive: true });
  const id = `${now.toISOString().slice(0, 19).replace(/[:T]/g, "-")}-${battleSlug(plan.topic)}`;
  const mdFile = join(opts.outDir, `${id}.md`);
  const htmlFile = join(opts.outDir, `${id}.html`);
  const jsonFile = join(opts.outDir, `${id}.json`);
  const saved = toSaved(result, plan.agents, now);
  writeFileSync(mdFile, renderReport(result));
  writeFileSync(htmlFile, renderHtmlReport(result));
  writeFileSync(jsonFile, JSON.stringify(saved, null, 2) + "\n");
  return { result, saved, id, mdFile, htmlFile, jsonFile };
}
