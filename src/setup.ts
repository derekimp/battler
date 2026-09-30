/**
 * `battler setup`: get a new user from nothing to their first battle. Checks each CLI, offers to
 * install or log in to what's missing (always asking first), saves preferences, and offers a test run.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { AGENT_IDS, createAgent, type AgentId } from "./adapters/cli-agents.ts";
import { CONFIG_PATH, type Config } from "./config.ts";
import type { Choice, Prompter } from "./ui/prompt.ts";
import { debaterColor, style } from "./ui/term.ts";

interface Tool {
  tool: string;
  company: string;
  install: [string, string[]];
  login: [string, string[]];
  binary: string;
}

export const TOOLS: Record<AgentId, Tool> = {
  claude: {
    tool: "Claude Code",
    company: "a Claude Pro or Max plan",
    install: ["npm", ["install", "-g", "@anthropic-ai/claude-code"]],
    login: ["claude", ["auth", "login", "--claudeai"]],
    binary: "claude",
  },
  codex: {
    tool: "Codex CLI",
    company: "a ChatGPT plan",
    install: ["npm", ["install", "-g", "@openai/codex"]],
    login: ["codex", ["login"]],
    binary: "codex",
  },
  grok: {
    tool: "Cursor CLI",
    company: "a Cursor plan (it can also stand in for Claude and GPT)",
    install: ["sh", ["-c", "curl https://cursor.com/install -fsS | bash"]],
    login: ["cursor-agent", ["login"]],
    binary: "cursor-agent",
  },
};

export interface SetupDeps {
  prompt: Prompter;
  /** Runs a command attached to the terminal; resolves with its exit code. */
  run(cmd: string, args: string[]): Promise<number>;
  /** Status per CLI: null when ready, otherwise the problem. */
  check(): Promise<Record<AgentId, string | null>>;
  log(line?: string): void;
  configPath: string;
  /** Runs a short test battle. */
  testBattle(): Promise<number>;
}

const st = style(process.stderr);

export const defaultSetupDeps = (prompt: Prompter): SetupDeps => ({
  prompt,
  run: (cmd, args) =>
    new Promise((resolve) => {
      const child = spawn(cmd, args, { stdio: "inherit" });
      child.on("error", () => resolve(127));
      child.on("close", (code) => resolve(code ?? 1));
    }),
  async check() {
    const entries = await Promise.all(AGENT_IDS.map(async (id) => [id, await createAgent(id).check()] as const));
    return Object.fromEntries(entries) as Record<AgentId, string | null>;
  },
  log: (line = "") => process.stderr.write(line + "\n"),
  configPath: CONFIG_PATH,
  testBattle: () =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, [process.argv[1], "-s", "Is a hot dog a sandwich?"], { stdio: "inherit" });
      child.on("close", (code) => resolve(code ?? 1));
    }),
});

const NAMES: Record<AgentId, string> = { claude: "Claude", codex: "GPT", grok: "Grok" };

/** Cursor's installer puts the binary in ~/.local/bin, which isn't always on PATH yet. */
function adoptLocalBin(binary: string): boolean {
  const dir = join(homedir(), ".local", "bin");
  const onPath = (process.env.PATH ?? "").split(":").includes(dir);
  if (!onPath && existsSync(join(dir, binary))) {
    process.env.PATH = `${dir}:${process.env.PATH}`;
    return true;
  }
  return false;
}

export async function runSetup(deps: SetupDeps): Promise<number> {
  const { prompt, log } = deps;
  log();
  log(`  ${st.bold("Welcome to battler.")}`);
  log(st.dim("  It runs the AI command-line tools you're signed in to, so battles use your subscriptions, never API keys."));
  log(st.dim("  You need at least two of them, or just Cursor, which can play every part."));

  const showStatus = (status: Record<AgentId, string | null>) => {
    log();
    for (const id of AGENT_IDS) {
      const t = TOOLS[id];
      const name = st.fg(debaterColor(NAMES[id]), st.bold(NAMES[id].padEnd(7)));
      const problem = status[id];
      log(`  ${problem ? st.red("✗") : st.green("✓")} ${name}${t.tool.padEnd(13)}${problem ? st.dim(problem.split(";")[0]) : st.dim("ready")}`);
    }
    log();
  };

  let status = await deps.check();
  showStatus(status);
  const localBinNotes: string[] = [];

  for (const id of AGENT_IDS) {
    const problem = status[id];
    if (!problem) continue;
    const t = TOOLS[id];
    if (/not found on PATH/.test(problem)) {
      const cmd = [t.install[0], ...t.install[1]].join(" ");
      if (!(await prompt.confirm(`Install ${t.tool} (for ${NAMES[id]}, needs ${t.company})? It runs: ${cmd}`, false))) continue;
      const code = await deps.run(...t.install);
      if (code !== 0) {
        log(st.red(`  Installing ${t.tool} failed (exit code ${code}). You can run it yourself: ${cmd}`));
        continue;
      }
      if (adoptLocalBin(t.binary)) localBinNotes.push(t.tool);
    }
    const after = (await deps.check())[id];
    if (after && !/not found on PATH/.test(after)) {
      if (!(await prompt.confirm(`Log in to ${t.tool} with ${t.company}? This opens your browser.`, true))) continue;
      const code = await deps.run(...t.login);
      if (code !== 0) log(st.red(`  Logging in to ${t.tool} didn't finish. You can run it yourself: ${t.login.flat().join(" ")}`));
    }
  }

  status = await deps.check();
  const ready = AGENT_IDS.filter((id) => !status[id]);
  const cursorReady = ready.includes("grok");
  if (ready.length < AGENT_IDS.length) showStatus(status);
  for (const tool of localBinNotes) {
    log(st.yellow(`  ${tool} was installed to ~/.local/bin. Add it to your PATH so it works in new terminals:`));
    log(`    echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc`);
  }

  if (ready.length < 2 && !cursorReady) {
    log(st.red("  battler needs at least two of these CLIs, or Cursor on its own. Run `battler setup` again when they're installed."));
    return 1;
  }
  const lineup = AGENT_IDS.map((id) => (status[id] ? (cursorReady && id !== "grok" ? `${NAMES[id]} (via Cursor)` : null) : NAMES[id])).filter(Boolean);
  log(`  ${st.green("✓")} ${st.bold("You're ready:")} ${lineup.join(" vs ")}`);
  log();

  // Preferences.
  let existing: Config = {};
  try {
    if (existsSync(deps.configPath)) existing = JSON.parse(readFileSync(deps.configPath, "utf8"));
  } catch {}
  const lengths: Choice<string>[] = [
    { value: "short", label: "short", hint: "a two-sentence answer and a winner, about a minute" },
    { value: "medium", label: "medium", hint: "answer, agreements, disagreements, scorecard, 2-3 minutes" },
    { value: "long", label: "long", hint: "in-depth, with every debater's strengths and weaknesses" },
  ];
  const current = lengths.findIndex((l) => l.value === (existing.length ?? "medium"));
  const length = await prompt.select("Default length?", lengths, current < 0 ? 1 : current);
  const open = await prompt.confirm("Open each battle's report in your browser when it's done?", existing.open ?? true);
  const config: Config = { ...existing, length, open };
  mkdirSync(dirname(deps.configPath), { recursive: true });
  writeFileSync(deps.configPath, JSON.stringify(config, null, 2) + "\n");
  log(st.dim(`  Saved to ${deps.configPath.replace(homedir(), "~")}`));
  log();

  if (await prompt.confirm("Run a quick test battle now? (short, about a minute)", true)) {
    return deps.testBattle();
  }
  log(`  Start a battle any time:  ${st.bold('battler "your question"')}`);
  log();
  return 0;
}
