/**
 * Debaters backed by locally installed, subscription-authenticated CLIs:
 *   Claude  -> Claude Code  (`claude -p`)        Claude Pro/Max login
 *   GPT     -> Codex CLI    (`codex exec`)       ChatGPT login
 *   Grok    -> Cursor CLI   (`cursor-agent -p`)  Cursor login, Grok model
 *   Gemini  -> Gemini CLI   (`gemini -p`)        Google account login
 *
 * API keys are stripped from the child environment so every call is billed to the
 * subscription login, never to a pay-per-token key that happens to be exported.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { existsSync } from "node:fs";
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
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_GENAI_USE_VERTEXAI",
];

export function subscriptionEnv(): NodeJS.ProcessEnv {
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
  gemini: "install Gemini CLI: npm install -g @google/gemini-cli",
};

// Long battles on slow models (Grok via Cursor adds a cloud environment start) can take a while.
const DEFAULT_TIMEOUT_MS = 8 * 60_000;

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
export function explain(cmd: string, raw: string): string {
  const lines = raw.trim().split("\n");
  // Some CLIs (Codex) echo the prompt around their errors; the ERROR lines are what matter.
  const errors = [...new Set(lines.filter((l) => /^\s*(ERROR|Error|error)\b[:\s]/.test(l)).map(cleanErrorLine))];
  const detail = (errors.length ? errors.slice(-3) : lines.slice(-5))
    .map((l) => (l.length > 300 ? l.slice(0, 300) + "…" : l))
    .join("\n");
  let hint = "";
  if (/cannot use this model|unrecognized_model|issue with the selected model|model.{0,40}(not found|does not exist|not supported|invalid)/i.test(raw)) {
    const grok = raw.match(/Available models:(.*)/)?.[1]?.split(",").map((m) => m.trim()).filter((m) => /grok/.test(m));
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

/** `ERROR: {"error":{"message":"..."}}` → `ERROR: ...` */
function cleanErrorLine(line: string): string {
  const message = line.match(/"message"\s*:\s*"((?:[^"\\]|\\.)*)"/)?.[1];
  return message ? `${line.trim().split(/[:\s]/)[0]}: ${message.replace(/\\"/g, '"')}` : line.trim();
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
    spec: model ? `claude:${model}` : "claude",
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

/** Codex's own model list (cached by the CLI), best first. */
export function codexModelCandidates(): string[] {
  try {
    const home = process.env.CODEX_HOME || join(homedir(), ".codex");
    const cache = JSON.parse(readFileSync(join(home, "models_cache.json"), "utf8"));
    return (cache.models as { slug?: string; visibility?: string; priority?: number; upgrade?: unknown }[])
      .filter((m) => m.slug && m.visibility === "list" && !m.upgrade)
      .sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99))
      .map((m) => m.slug!);
  } catch {
    return [];
  }
}

const CHATGPT_UNSUPPORTED = /not supported when using Codex with a ChatGPT account/i;

/**
 * Codex's default model (from ~/.codex/config.toml) can be one a ChatGPT login can't use. When
 * that happens and the user didn't choose a model, fall back through Codex's own list, and
 * remember what worked for the rest of the run.
 */
let codexWorkingModel: string | undefined;
export const resetCodexFallback = () => void (codexWorkingModel = undefined);

export function codexAgent(model?: string): Agent {
  const once = async (prompt: string, opts: AskOptions, m: string | undefined) => {
    const outFile = join(sandboxDir, `codex-${process.pid}-${Math.random().toString(36).slice(2)}.txt`);
    const args = ["exec", "--skip-git-repo-check", "--ephemeral", "-s", "read-only", "-o", outFile];
    if (m) args.push("-m", m);
    args.push("-");
    const r = await run("codex", args, { stdin: withSystem(prompt, opts.system), signal: opts.signal });
    let text = "";
    try {
      text = readFileSync(outFile, "utf8").trim();
    } catch {}
    rmSync(outFile, { force: true });
    return { r, text };
  };
  return {
    id: "codex",
    name: "GPT",
    spec: model ? `codex:${model}` : "codex",
    async ask(prompt: string, opts: AskOptions = {}) {
      let { r, text } = await once(prompt, opts, model ?? codexWorkingModel);
      if (r.code !== 0 && !model && CHATGPT_UNSUPPORTED.test(r.stderr + r.stdout)) {
        const failed = r.stderr.match(/The '([^']+)' model is not supported/)?.[1] ?? codexWorkingModel;
        for (const candidate of codexModelCandidates().filter((c) => c !== failed).slice(0, 3)) {
          ({ r, text } = await once(prompt, opts, candidate));
          if (r.code === 0) {
            codexWorkingModel = candidate;
            break;
          }
          if (!CHATGPT_UNSUPPORTED.test(r.stderr + r.stdout)) break;
        }
      }
      if (r.code !== 0) throw failure("codex", r);
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

/**
 * Cursor's own Grok. Cursor Pro bills "Cursor Models" (cursor-grok-*, composer-*) separately from
 * "Other Models" (every other model, including the plain grok-4.7-* ones), and the Cursor Models
 * allowance is the one users rarely exhaust, so it's the default.
 */
export const DEFAULT_GROK_MODEL = "cursor-grok-4.6-high";

/** Which Cursor Pro allowance a model draws on. */
export function cursorQuota(model: string): "Cursor Models" | "Other Models" {
  return /^(cursor-|composer)/i.test(model) ? "Cursor Models" : "Other Models";
}

/** The Cursor model behind an agent, if it runs through Cursor. */
export function cursorModelOf(agent: Agent): string | undefined {
  const spec = agent.spec ?? "";
  if (spec.startsWith("cursor:")) return spec.slice("cursor:".length);
  if (spec === "grok") return DEFAULT_GROK_MODEL;
  if (spec.startsWith("grok:")) return spec.slice("grok:".length);
  return undefined;
}

/** Models used when Cursor stands in for a missing Claude Code or Codex CLI. */
export const CURSOR_STAND_INS: Record<"claude" | "codex", string> = {
  claude: "claude-sonnet-5-medium",
  codex: "gpt-5.5-medium",
};

/** Display name for a Cursor model id, by model family. */
export function familyName(model: string): string {
  const m = model.toLowerCase();
  if (/grok/.test(m)) return "Grok";
  if (/claude|opus|sonnet|haiku|fable/.test(m)) return "Claude";
  if (/gpt|codex|^o\d/.test(m)) return "GPT";
  if (/gemini/.test(m)) return "Gemini";
  if (/kimi/.test(m)) return "Kimi";
  if (/composer/.test(m)) return "Composer";
  return model;
}

/** Any model Cursor offers, run through the Cursor CLI on the Cursor subscription. */
export function cursorAgent(model: string, opts: { id?: string; name?: string } = {}): Agent {
  return {
    id: opts.id ?? `cursor:${model}`,
    name: opts.name ?? familyName(model),
    spec: `cursor:${model}`,
    async ask(prompt: string, askOpts: AskOptions = {}) {
      const args = ["-p", "--output-format", "json", "--mode", "ask", "--trust", "--model", model,
        withSystem(prompt, askOpts.system)];
      const r = await run("cursor-agent", args, { signal: askOpts.signal });
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

/**
 * Grok through Cursor. The spec records a model only if one was chosen, so a saved battle that
 * used the default keeps following the default when it's continued later.
 */
export function cursorGrokAgent(model?: string): Agent {
  return { ...cursorAgent(model ?? DEFAULT_GROK_MODEL, { id: "grok", name: "Grok" }), spec: model ? `grok:${model}` : "grok" };
}

/** Grok models that were battler's default in earlier versions, so were never really chosen. */
export const FORMER_GROK_DEFAULTS = ["grok-4.7-medium"];


/**
 * Gemini through the Gemini CLI, signed in with a Google account (free, or Google AI Pro/Ultra).
 * Runs in plan mode, which is read-only. An API-key or Vertex login isn't a subscription, so
 * check() reports it rather than using it.
 */
export function geminiAgent(model?: string): Agent {
  return {
    id: "gemini",
    name: "Gemini",
    spec: model ? `gemini:${model}` : "gemini",
    async ask(prompt: string, opts: AskOptions = {}) {
      const args = ["-p", withSystem(prompt, opts.system), "-o", "json", "--approval-mode", "plan", "--skip-trust"];
      if (model) args.push("-m", model);
      const r = await run("gemini", args, { signal: opts.signal });
      // Log lines can precede the JSON; take the last top-level object.
      const start = r.stdout.lastIndexOf("\n{") + 1;
      let json: { response?: string; error?: { message?: string } };
      try {
        json = JSON.parse(r.stdout.slice(start));
      } catch {
        throw failure("gemini", r);
      }
      if (json.error || r.code !== 0 || !json.response) {
        throw new Error(`gemini: ${explain("gemini", json.error?.message || r.stderr || "empty response")}`);
      }
      return json.response.trim();
    },
    async check() {
      const r = await run("gemini", ["--version"], { timeoutMs: 30_000 }).catch((e: Error) => e);
      if (r instanceof Error) return r.message;
      const home = process.env.BATTLER_GEMINI_HOME || join(homedir(), ".gemini"); // env var: tests only
      let authType: string | undefined;
      try {
        const settings = JSON.parse(readFileSync(join(home, "settings.json"), "utf8"));
        authType = settings?.security?.auth?.selectedType ?? settings?.selectedAuthType;
      } catch {}
      if (authType && !/oauth|google/i.test(authType)) return `signed in with ${authType}, not a Google account; run \`gemini\` and choose Login with Google`;
      if (!existsSync(join(home, "oauth_creds.json"))) return "not logged in; run `gemini` once and choose Login with Google";
      return null;
    },
  };
}

export type AgentId = "claude" | "codex" | "grok" | "gemini";

/** The default line-up, in the order they are preferred as judge. */
export const AGENT_IDS: AgentId[] = ["claude", "codex", "grok", "gemini"];

/** Joins battles when installed, but isn't worth a "skipping" note when it isn't. */
export const OPTIONAL_IDS: AgentId[] = ["gemini"];

const FACTORIES: Record<AgentId, (model?: string) => Agent> = {
  claude: claudeAgent,
  codex: codexAgent,
  grok: cursorGrokAgent,
  gemini: geminiAgent,
};

const ALIASES: Record<string, AgentId> = { gpt: "codex", chatgpt: "codex" };

export function resolveAgentId(name: string): AgentId | undefined {
  const n = name.trim().toLowerCase();
  return (AGENT_IDS as string[]).includes(n) ? (n as AgentId) : ALIASES[n];
}

export function createAgent(id: AgentId, model?: string): Agent {
  return FACTORIES[id](model);
}

/**
 * Parse a debater spec: "claude", "codex:gpt-5.5", "grok:grok-4.7-high", or "cursor:<model>"
 * for any model Cursor offers. `defaultModels` fills in a model the spec leaves out.
 */
export function agentFromSpec(spec: string, defaultModels: Partial<Record<AgentId, string>> = {}): Agent {
  const [rawName, ...rest] = spec.trim().split(":");
  const model = rest.join(":").trim() || undefined;
  if (rawName.trim().toLowerCase() === "cursor") {
    if (!model) throw new Error('"cursor" needs a model, e.g. cursor:claude-sonnet-5-medium (see `cursor-agent --list-models`)');
    return cursorAgent(model);
  }
  const id = resolveAgentId(rawName);
  if (!id) throw new Error(`unknown agent "${rawName}" (choose from ${AGENT_IDS.join(", ")}, or cursor:<model>)`);
  return createAgent(id, model ?? defaultModels[id]);
}
