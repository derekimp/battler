/**
 * Each battle is saved as JSON next to its reports, so it can be continued later with
 * `battler continue` (more rounds, or a follow-up question). The format and the pure helpers
 * are in saved-core.ts so the browser extension can share them.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { savedProblem, type SavedBattle } from "./saved-core.ts";

export * from "./saved-core.ts";

export function loadSaved(path: string): SavedBattle {
  // Accept the .html or .md report path too.
  const file = path.replace(/\.(html|md)$/, ".json");
  if (!existsSync(file)) throw new Error(`no saved battle at ${file}`);
  const data = JSON.parse(readFileSync(file, "utf8"));
  const problem = savedProblem(data);
  if (problem) throw new Error(`${file} ${problem}`);
  return data as SavedBattle;
}

/** The most recent saved battle in `dir` (file names start with a timestamp). */
export function latestSaved(dir: string): string | null {
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}-.*\.json$/.test(f)).sort();
  return files.length ? join(dir, files.at(-1)!) : null;
}
