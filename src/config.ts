import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** ~/.config/battler/config.json. Every field is optional; command-line flags win. */
export interface Config {
  /** Debaters, e.g. ["claude", "grok"]. Omit to use every CLI that is installed and logged in. */
  agents?: string[];
  judge?: string;
  rounds?: number;
  /** "short" | "medium" | "long" */
  length?: string;
  out?: string;
  /** Open the HTML report in the browser after each battle. */
  open?: boolean;
  /** Model per debater, passed straight to that CLI, e.g. { "grok": "grok-4.7-high" }. */
  models?: Partial<Record<"claude" | "codex" | "grok" | "gemini", string>>;
}

export const CONFIG_PATH = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "battler", "config.json");

export function loadConfig(): Config {
  if (!existsSync(CONFIG_PATH)) return {};
  try {
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("expected a JSON object");
    return raw as Config;
  } catch (err) {
    throw new Error(`invalid config at ${CONFIG_PATH}: ${err instanceof Error ? err.message : err}`);
  }
}
