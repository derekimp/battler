/**
 * Debaters backed by locally installed, subscription-authenticated CLIs:
 *   Claude  -> Claude Code  (`claude -p`)        Claude Pro/Max login
 *   GPT     -> Codex CLI    (`codex exec`)       ChatGPT login
 *   Grok    -> Cursor CLI   (`cursor-agent -p`)  Cursor login, Grok model
 *
 * API keys are stripped from the child environment so every call is billed to the
 * subscription login, never to a pay-per-token key that happens to be exported.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent, AskOptions } from "../core/types.ts";

const API_KEY_VARS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "OPENAI_API_KEY",
  "CODEX_API_KEY",
  "CURSOR_API_KEY",
];

function subscriptionEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const k of API_KEY_VARS) delete env[k];
  return env;
}

/** Empty working directory so the coding agents have no project files to wander into. */
const sandboxDir = mkdtempSync(join(tmpdir(), "battler-"));
process.on("exit", () => rmSync(sandboxDir, { recursive: true, force: true }));

interface RunResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

const INSTALL_HINTS: Record<string, string> = {
  claude: "install Claude Code: https://claude.com/claude-code",
  codex: "install Codex CLI: npm install -g @openai/codex",
  "cursor-agent": "install Cursor CLI: curl https://cursor.com/install -fsS | bash",
};

const DEFAULT_TIMEOUT_MS = 5 * 60_000;

function run(
  cmd: string,
  args: string[],
  opts: { stdin?: string; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: sandboxDir,
      env: subscriptionEnv(),
      stdio: ["pipe", "pipe", "pipe"],
      signal: opts.signal,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`${cmd} timed out after ${(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS) / 1000}s`));
    }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    child.on("error", (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(err.code === "ENOENT" ? new Error(`\`${cmd}\` not found on PATH; ${INSTALL_HINTS[cmd] ?? "install it first"}`) : err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code });
    });
    child.stdin.end(opts.stdin ?? "");
  });
}

/**
 * These CLIs change often, so turn their raw errors into something a user can act on.
 * Long lines (cursor-agent prints every model it knows) are clipped.
 */
function explain(cmd: string, raw: string): string {
  const detail = raw
    .trim()
    .split("\n")
    .slice(-5)
    .map((l) => (l.length > 300 ? l.slice(0, 300) + "…" : l))
    .join("\n");
  let hint = "";
  if (/cannot use this model|unrecognized_model|issue with the selected model|model.{0,40}(not found|does not exist|not supported|invalid)/i.test(raw)) {
    const grok = raw.match(/Available models:(.*)/)?.[1]?.split(",").map((m) => m.trim()).filter((m) => /^grok-/.test(m));
    hint = `the configured model isn't available to your ${cmd} login. Pick another with --agents or the "models" setting in the config file`;
    // cursor-agent's raw message lists every model it has; the Grok subset is all that's useful.
    if (grok?.length) return `${hint}. Grok models your Cursor account offers: ${grok.join(", ")}`;
  } else if (/unknown (option|argument)|unexpected argument|unrecognized (option|argument)|error: option/i.test(raw)) {
    hint = `${cmd} rejected a flag battler uses, so its command-line interface has probably changed. Update ${cmd} and battler`;
  } else if (/rate.?limit|usage limit|quota|too many requests|\b429\b/i.test(raw)) {
    hint = `you've hit your ${cmd} subscription usage limit. Try again later or leave this debater out`;
  } else if (/not logged in|log ?in required|unauthori[sz]ed|authenticat/i.test(raw)) {
    hint = "not logged in. Run `battler --doctor` for instructions";
  }
  return hint ? `${hint}\n    ${detail.replace(/\n/g, "\n    ")}` : detail;
}

function failure(cmd: string, r: RunResult): Error {
  const detail = explain(cmd, r.stderr || r.stdout);
  return new Error(`${cmd} exited with code ${r.code}${detail ? `: ${detail}` : ""}`);
}

/** For backends without a system-prompt flag. */
function withSystem(prompt: string, system?: string): string {
  return system ? `${system}\n\n---\n\n${prompt}` : prompt;
}

export function claudeAgent(model?: string): Agent {
  return {
    id: "claude",
    name: "Claude",
    async ask(prompt: string, opts: AskOptions = {}) {
      const args = [
        "-p",
        "--output-format", "json",
        "--tools", "",
        "--strict-mcp-config",
        "--no-session-persistence",
      ];
      if (opts.system) args.push("--system-prompt", opts.system);
      if (model) args.push("--model", model);
      const r = await run("claude", args, { stdin: prompt, signal: opts.signal });
      let json: { result?: string; is_error?: boolean };
      try {
        json = JSON.parse(r.stdout);
      } catch {
        throw failure("claude", r);
      }
      if (json.is_error || r.code !== 0 || !json.result) {
        throw new Error(`claude: ${explain("claude", json.result || r.stderr || "empty response")}`);
      }
      return json.result.trim();
    },
    async check() {
      const r = await run("claude", ["auth", "status"], { timeoutMs: 30_000 }).catch((e: Error) => e);
      if (r instanceof Error) return r.message;
      try {
        const s = JSON.parse(r.stdout);
        if (!s.loggedIn) return "not logged in; run `claude` and sign in with your Claude account";
        if (s.authMethod !== "claude.ai") return `logged in via ${s.authMethod}, not a Claude subscription`;
        return null;
      } catch {
        return failure("claude auth status", r).message;
      }
    },
  };
}

export function codexAgent(model?: string): Agent {
  return {
    id: "codex",
    name: "GPT",
    async ask(prompt: string, opts: AskOptions = {}) {
      const outFile = join(sandboxDir, `codex-${process.pid}-${Math.random().toString(36).slice(2)}.txt`);
      const args = ["exec", "--skip-git-repo-check", "--ephemeral", "-s", "read-only", "-o", outFile];
      if (model) args.push("-m", model);
      args.push("-");
      const r = await run("codex", args, { stdin: withSystem(prompt, opts.system), signal: opts.signal });
      if (r.code !== 0) throw failure("codex", r);
      let text = "";
      try {
        text = readFileSync(outFile, "utf8").trim();
      } catch {}
      rmSync(outFile, { force: true });
      if (!text) throw failure("codex (empty response)", r);
      return text;
    },
    async check() {
      const r = await run("codex", ["login", "status"], { timeoutMs: 30_000 }).catch((e: Error) => e);
      if (r instanceof Error) return r.message;
      const out = (r.stdout + r.stderr).trim();
      if (r.code !== 0) return "not logged in; run `codex login`";
      if (!/chatgpt/i.test(out)) return `logged in, but not with ChatGPT (${out})`;
      return null;
    },
  };
}

export const DEFAULT_GROK_MODEL = "grok-4.7-medium";

export function cursorGrokAgent(model = DEFAULT_GROK_MODEL): Agent {
  return {
    id: "grok",
    name: "Grok",
    async ask(prompt: string, opts: AskOptions = {}) {
      const args = ["-p", "--output-format", "json", "--mode", "ask", "--trust", "--model", model,
        withSystem(prompt, opts.system)];
      const r = await run("cursor-agent", args, { signal: opts.signal });
      let json: { result?: string; is_error?: boolean };
      try {
        json = JSON.parse(r.stdout.trim().split("\n").at(-1)!);
      } catch {
        throw failure("cursor-agent", r);
      }
      if (json.is_error || r.code !== 0 || !json.result) {
        throw new Error(`cursor-agent: ${explain("cursor-agent", json.result || r.stderr || "empty response")}`);
      }
      return json.result.trim();
    },
    async check() {
      const r = await run("cursor-agent", ["status"], { timeoutMs: 30_000 }).catch((e: Error) => e);
      if (r instanceof Error) return r.message;
      if (r.code !== 0 || /not logged in/i.test(r.stdout) || !/logged in/i.test(r.stdout)) {
        return "not logged in; run `cursor-agent login`";
      }
      return null;
    },
  };
}

export type AgentId = "claude" | "codex" | "grok";

/** In the order they are preferred as judge. */
export const AGENT_IDS: AgentId[] = ["claude", "codex", "grok"];

const FACTORIES: Record<AgentId, (model?: string) => Agent> = {
  claude: claudeAgent,
  codex: codexAgent,
  grok: cursorGrokAgent,
};

const ALIASES: Record<string, AgentId> = { gpt: "codex", chatgpt: "codex", cursor: "grok" };

export function resolveAgentId(name: string): AgentId | undefined {
  const n = name.trim().toLowerCase();
  return (AGENT_IDS as string[]).includes(n) ? (n as AgentId) : ALIASES[n];
}

export function createAgent(id: AgentId, model?: string): Agent {
  return FACTORIES[id](model);
}
