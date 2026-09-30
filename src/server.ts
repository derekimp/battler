/**
 * `battler serve`: a local web UI. The page talks to this server, which runs battles with the
 * same CLIs and subscriptions as the terminal, and streams progress back over Server-Sent Events.
 *
 * Security: it listens on 127.0.0.1 only, unless --lan. Every API call must carry an
 * `X-Battler` header (which a cross-site page can't send without a CORS preflight we never
 * approve), the Host header must be ours (no DNS rebinding), and with --lan every request
 * needs the random token printed at startup.
 */
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AGENT_IDS, CURSOR_STAND_INS, createAgent, cursorModelOf, cursorQuota } from "./adapters/cli-agents.ts";
import type { Config } from "./config.ts";
import { loadSaved, savedToResult, type SavedBattle } from "./core/saved.ts";
import type { BattleEvent } from "./core/types.ts";
import { namedVerdict, revealNames, winnerHeadline } from "./core/verdict.ts";
import { continuePlan, newPlan, PlanError, type Plan } from "./plan.ts";
import { runPlan, type BattleError } from "./run.ts";
import { htmlColor, REPORT_CSS, renderRoundsHtml, renderTurnHtml, renderVerdictHtml } from "./ui/html-report.ts";
import { plainPreview } from "./ui/term.ts";

export interface ServeOptions {
  port: number;
  /** "127.0.0.1" normally; "0.0.0.0" with --lan. */
  host: string;
  outDir: string;
  config: Config;
  /** Required on every request when set (LAN mode). */
  token?: string;
  /** For tests: replaces the CLI readiness checks. */
  checkAgents?: () => Promise<AgentStatus[]>;
}

export interface AgentStatus {
  id: string;
  name: string;
  color: string;
  ready: boolean;
  problem: string | null;
  model?: string;
  allowance?: string;
  /** How to run this family through Cursor if its own CLI isn't ready. */
  standInSpec?: string;
}

const WEB_DIR = fileURLToPath(new URL("../web/", import.meta.url));

interface Job {
  id: string;
  events: object[];
  listeners: Set<(e: object) => void>;
  done: boolean;
  controller: AbortController;
}

async function defaultCheckAgents(config: Config): Promise<AgentStatus[]> {
  return Promise.all(
    AGENT_IDS.map(async (id) => {
      const agent = createAgent(id, config.models?.[id]);
      const problem = await agent.check();
      const model = cursorModelOf(agent);
      return {
        id,
        name: agent.name,
        color: htmlColor(agent.name),
        ready: !problem,
        problem,
        ...(model ? { model, allowance: cursorQuota(model) } : {}),
        ...(id === "claude" || id === "codex" ? { standInSpec: `cursor:${CURSOR_STAND_INS[id]}` } : {}),
      };
    }),
  );
}

/** One line of history for the sidebar. */
function summary(id: string, saved: SavedBattle) {
  const result = savedToResult(saved);
  const v = namedVerdict(result);
  return {
    id,
    topic: saved.topic,
    createdAt: saved.createdAt,
    length: saved.length,
    rounds: saved.rounds.length,
    followUpOf: saved.followUpOf ?? null,
    debaters: saved.agents.map((a) => ({ name: a.name, color: htmlColor(a.name) })),
    winner: v ? (v.winner.debater === "Tie" ? null : v.winner.debater) : null,
    headline: saved.incomplete ? "interrupted" : v ? winnerHeadline(v) : null,
    incomplete: Boolean(saved.incomplete),
  };
}

/** Everything the page needs to show a finished battle. */
function detail(id: string, saved: SavedBattle) {
  const result = savedToResult(saved);
  return {
    ...summary(id, saved),
    judges: saved.judges,
    verdictHtml: renderVerdictHtml(result),
    roundsHtml: renderRoundsHtml(result),
    reportUrl: `/reports/${encodeURIComponent(id)}.html`,
  };
}

const ID = /^[\w\p{L}\p{N}.-]+$/u;

export function startServer(opts: ServeOptions): Server & { stopAll(): void } {
  const jobs = new Map<string, Job>();
  let statusCache: { at: number; value: AgentStatus[] } | null = null;
  const checkAgents = opts.checkAgents ?? (() => defaultCheckAgents(opts.config));

  const savedPath = (id: string) => join(opts.outDir, `${id}.json`);
  const listSaved = () => {
    if (!existsSync(opts.outDir)) return [];
    return readdirSync(opts.outDir)
      .filter((f) => /^\d{4}-\d{2}-\d{2}-.*\.json$/.test(f))
      .sort()
      .reverse()
      .flatMap((f) => {
        const id = f.replace(/\.json$/, "");
        try {
          return [summary(id, loadSaved(savedPath(id)))];
        } catch {
          return [];
        }
      });
  };

  function allowedHost(req: IncomingMessage): boolean {
    if (opts.token) return true; // LAN mode is guarded by the token instead
    const host = (req.headers.host ?? "").replace(/:\d+$/, "");
    return ["localhost", "127.0.0.1", "[::1]"].includes(host);
  }

  function hasToken(req: IncomingMessage, url: URL): boolean {
    if (!opts.token) return true;
    return url.searchParams.get("t") === opts.token || req.headers["x-battler-token"] === opts.token;
  }

  const send = (res: ServerResponse, status: number, body: unknown, type = "application/json; charset=utf-8") => {
    res.writeHead(status, {
      "content-type": type,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    });
    res.end(type.startsWith("application/json") ? JSON.stringify(body) : (body as string));
  };

  async function readJson(req: IncomingMessage): Promise<any> {
    let raw = "";
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > 100_000) throw new PlanError("request too large");
    }
    try {
      return raw ? JSON.parse(raw) : {};
    } catch {
      throw new PlanError("invalid JSON");
    }
  }

  function startJob(plan: Plan): Job {
    const job: Job = { id: randomBytes(8).toString("hex"), events: [], listeners: new Set(), done: false, controller: new AbortController() };
    jobs.set(job.id, job);
    const emit = (e: object) => {
      const ev = { ...e, at: Date.now() };
      job.events.push(ev);
      for (const l of job.listeners) l(ev);
    };
    let names = new Map<string, string>();
    emit({
      type: "plan",
      topic: plan.topic,
      followUpOf: plan.followUp?.topic ?? plan.followUpOf ?? null,
      length: plan.length,
      firstRound: (plan.resume?.length ?? 0) + 1,
      totalRounds: (plan.resume?.length ?? 0) + plan.rounds,
      debaters: plan.agents.map((a) => ({ name: a.name, color: htmlColor(a.name) })),
      judges: plan.judges.map((j) => j.name),
      // File paths mean nothing in the browser: the follow-up line already says what this continues.
      notes: plan.notes.flatMap((n) => {
        if (!n.startsWith("Continuing ")) return [n];
        const so = n.match(/(\d+) rounds? so far/);
        return so ? [`Picking up after ${so[1]} round${so[1] === "1" ? "" : "s"}; everyone rebuts the latest positions.`] : [];
      }),
    });
    const onEvent = (e: BattleEvent) => {
      switch (e.type) {
        case "start":
          names = e.names;
          return;
        case "turn-done":
          return emit({
            type: "turn-done",
            round: e.turn.round,
            agentName: e.turn.agentName,
            ms: e.turn.ms,
            preview: revealNames(plainPreview(e.turn.text), names),
            html: renderTurnHtml(e.turn, names),
          });
        case "round-done":
          return; // saved by runPlan; nothing for the page
        default:
          return emit(e);
      }
    };
    runPlan(plan, { outDir: opts.outDir, onEvent, signal: job.controller.signal })
      .then((out) => emit({ type: "done", battle: detail(out.id, out.saved), ...(out.saveError ? { warning: `Couldn't save this battle: ${out.saveError}` } : {}) }))
      .catch((err: BattleError) =>
        emit({
          type: "error",
          // The terminal's "`battler continue` will…" hint; the page offers a button instead.
          message: job.controller.signal.aborted ? "Stopped." : err.message.replace(/\nThe \d+ rounds? so far are saved;.*$/s, ""),
          // Rounds saved before the failure can still be judged.
          ...(err.savedId ? { savedId: err.savedId } : {}),
        }),
      )
      .finally(() => {
        job.done = true;
        for (const l of job.listeners) l({ type: "end" });
        // Keep finished jobs briefly for late subscribers, then forget them.
        setTimeout(() => jobs.delete(job.id), 10 * 60_000).unref();
      });
    return job;
  }

  async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL) {
    const path = url.pathname;
    const method = req.method ?? "GET";

    if (method === "GET" && path === "/api/status") {
      if (!statusCache || Date.now() - statusCache.at > 30_000 || url.searchParams.has("refresh")) {
        statusCache = { at: Date.now(), value: await checkAgents() };
      }
      const agents = statusCache.value;
      const ready = agents.filter((a) => a.ready).length;
      const cursorReady = agents.some((a) => a.id === "grok" && a.ready);
      return send(res, 200, {
        agents,
        canBattle: ready >= 2 || cursorReady,
        defaults: {
          length: opts.config.length ?? "medium",
          rounds: opts.config.rounds ?? 2,
          judge: opts.config.judge ?? null,
        },
        outDir: opts.outDir,
      });
    }

    if (method === "GET" && path === "/api/battles") return send(res, 200, { battles: listSaved() });

    const battleMatch = path.match(/^\/api\/battles\/([^/]+)$/);
    if (method === "GET" && battleMatch) {
      const id = decodeURIComponent(battleMatch[1]);
      if (!ID.test(id) || !existsSync(savedPath(id))) return send(res, 404, { error: "No such battle." });
      return send(res, 200, detail(id, loadSaved(savedPath(id))));
    }

    if (method === "POST" && path === "/api/battles") {
      const body = await readJson(req);
      let plan: Plan;
      if (body.continueFrom) {
        const id = String(body.continueFrom);
        if (!ID.test(id) || !existsSync(savedPath(id))) return send(res, 404, { error: "No such battle to continue." });
        plan = await continuePlan(loadSaved(savedPath(id)), savedPath(id), body.more ? "" : String(body.question ?? ""), {
          length: body.length,
          rounds: body.rounds === undefined ? undefined : Number(body.rounds),
          config: opts.config,
          judge: body.judge ?? undefined,
        });
      } else {
        plan = await newPlan({
          topic: String(body.topic ?? ""),
          length: String(body.length ?? opts.config.length ?? "medium"),
          rounds: Number(body.rounds ?? opts.config.rounds ?? 2),
          agents: Array.isArray(body.agents) ? body.agents.map(String) : undefined,
          judge: body.judge ?? undefined,
          config: opts.config,
        });
      }
      const job = startJob(plan);
      return send(res, 202, { jobId: job.id });
    }

    const eventsMatch = path.match(/^\/api\/jobs\/([a-f0-9]+)\/events$/);
    if (method === "GET" && eventsMatch) {
      const job = jobs.get(eventsMatch[1]);
      if (!job) return send(res, 404, { error: "No such job." });
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
      const write = (e: object) => res.write(`data: ${JSON.stringify(e)}\n\n`);
      for (const e of job.events) write(e);
      if (job.done) {
        write({ type: "end" });
        return res.end();
      }
      const listener = (e: object) => {
        write(e);
        if ((e as { type: string }).type === "end") res.end();
      };
      job.listeners.add(listener);
      const ping = setInterval(() => res.write(": ping\n\n"), 15_000);
      req.on("close", () => {
        clearInterval(ping);
        job.listeners.delete(listener);
      });
      return;
    }

    const cancelMatch = path.match(/^\/api\/jobs\/([a-f0-9]+)\/cancel$/);
    if (method === "POST" && cancelMatch) {
      const job = jobs.get(cancelMatch[1]);
      if (!job) return send(res, 404, { error: "No such job." });
      job.controller.abort();
      return send(res, 200, { ok: true });
    }

    return send(res, 404, { error: "Not found." });
  }

  const STATIC: Record<string, [string, string]> = {
    "/": ["index.html", "text/html; charset=utf-8"],
    "/assets/app.js": ["app.js", "text/javascript; charset=utf-8"],
    "/assets/app.css": ["app.css", "text/css; charset=utf-8"],
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (!allowedHost(req)) return send(res, 403, { error: "Forbidden host." });
      // The page and its assets are harmless; data and actions need the token in LAN mode.
      const guarded = url.pathname.startsWith("/api/") || url.pathname.startsWith("/reports/");
      if (guarded && !hasToken(req, url)) {
        return send(res, 401, { error: "Open the address with the access token printed in the terminal (…?t=…)." });
      }

      if (url.pathname.startsWith("/api/")) {
        // Cross-site pages can't set this header without a preflight, which we never approve.
        if (req.headers["x-battler"] !== "1" && !(req.method === "GET" && url.pathname.endsWith("/events"))) {
          return send(res, 403, { error: "Missing X-Battler header." });
        }
        const origin = req.headers.origin;
        if (origin && new URL(origin).host !== req.headers.host) return send(res, 403, { error: "Cross-origin request refused." });
        return await handleApi(req, res, url);
      }

      if (req.method === "GET" && url.pathname === "/assets/report.css") return send(res, 200, REPORT_CSS(), "text/css; charset=utf-8");
      const report = url.pathname.match(/^\/reports\/([^/]+)\.html$/);
      if (req.method === "GET" && report) {
        const id = decodeURIComponent(report[1]);
        const file = join(opts.outDir, `${id}.html`);
        if (!ID.test(id) || !existsSync(file)) return send(res, 404, "Not found.", "text/plain; charset=utf-8");
        return send(res, 200, readFileSync(file, "utf8"), "text/html; charset=utf-8");
      }
      const asset = STATIC[url.pathname];
      if (req.method === "GET" && asset) return send(res, 200, readFileSync(join(WEB_DIR, asset[0]), "utf8"), asset[1]);
      return send(res, 404, "Not found.", "text/plain; charset=utf-8");
    } catch (e) {
      if (e instanceof PlanError) return send(res, 400, { error: e.message });
      return send(res, 500, { error: (e as Error).message });
    }
  });
  return Object.assign(server.listen(opts.port, opts.host), {
    /** Abort every running battle (which stops the CLIs they started). */
    stopAll() {
      for (const job of jobs.values()) if (!job.done) job.controller.abort();
    },
  });
}
