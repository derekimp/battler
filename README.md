# battler

**Make your AI subscriptions debate each other, then get one consolidated answer.**

Claude, ChatGPT and Grok each answer your question, read each other's answers, argue, and revise.
A judge then writes up the best-supported answer, where they agree, where they still disagree, and who argued best.

No API keys and no per-token bills. battler drives the official command-line tools you're already
signed in to, so every call uses the subscriptions you already pay for.

```
$ battler "Should a solo developer building a SaaS MVP choose Postgres or SQLite?"
⚔️  Should a solo developer building a SaaS MVP choose Postgres or SQLite?
   Claude vs GPT vs Grok · 2 round(s) · judge: Claude

Opening statements (waiting on Claude, GPT, Grok)
  ✓ Claude  18s  Default to **Postgres**, specifically a managed instance such as Neon, Supabase, RDS, or …
  ✓ GPT     20s  A solo developer building a typical hosted, multi-tenant SaaS MVP should default to **man…
  ✓ Grok    37s  For a typical multi-tenant SaaS MVP in 2026, start on managed Postgres. Treat SQLite as t…

Debate round 2 (waiting on Claude, GPT, Grok)
  ✓ Claude  22s  **Debater B:** The 85% confidence doesn't fit B's own caveats. B concedes that SQLite sui…
  ✓ GPT     26s  **Debater A:** Your weakest claim is that SQLite produces contention errors “Postgres use…
  ✓ Grok    66s  **Debater A.** The weakest point is argument 4: one Postgres replacing Redis, a queue, an…

Verdict (Claude is judging)
  ✓ done 28s

## Answer
For a solo developer building a conventional hosted, multi-tenant SaaS MVP, **default to managed
Postgres**, especially if more than one process will write to the database. **SQLite is a
first-class alternative, not a niche one.** Choose it if you deliberately run on one server with a
persistent disk… The deciding factor is **deployment topology and write concurrency**, not
feature lists or user count.

## Consensus …   ## Open disagreements …   ## Scorecard …   ## Winner …
```

## Requirements

- Node.js 20 or newer
- At least **two** of these CLIs, each signed in with a subscription:

| Debater | CLI | Install | Sign in with |
|---|---|---|---|
| Claude | Claude Code (`claude`) | [claude.com/claude-code](https://claude.com/claude-code) | Claude Pro or Max: run `claude` and log in |
| GPT | Codex CLI (`codex`) | `npm install -g @openai/codex` | ChatGPT: `codex login` |
| Grok | Cursor CLI (`cursor-agent`) | `curl https://cursor.com/install -fsS \| bash` | Cursor: `cursor-agent login` |

## Install

```bash
git clone https://github.com/<you>/battler.git
cd battler
npm install          # also builds dist/
npm link             # puts `battler` on your PATH
battler --doctor     # shows which CLIs are ready
```

## Usage

```bash
battler "Is Rust better than Go for backend services?"
battler -r 3 "Should we rewrite the monolith?"        # more debate rounds
battler -a claude,grok -j codex "Tabs or spaces?"     # choose debaters and judge
battler -a claude:opus,codex,grok:grok-4.7-high "…"   # pick a model per debater
pbpaste | battler                                      # topic from stdin
```

The verdict is printed to stdout, so you can pipe it (`battler "…" > answer.md`).
The full transcript, including every round and who was who, is saved to `./battles/`.

| Option | Default | |
|---|---|---|
| `-a, --agents` | every ready CLI | Debaters, comma-separated `name[:model]`. Names: `claude`, `codex` (or `gpt`), `grok` |
| `-j, --judge` | claude, else codex, else grok | Who writes the verdict |
| `-r, --rounds` | 2 | Total rounds including the opening, 1-5 |
| `-o, --out` | `./battles` | Where transcripts are saved |
| `--doctor` | | Check each CLI is installed and on a subscription login |

### Config file

Set defaults in `~/.config/battler/config.json` (or `$XDG_CONFIG_HOME/battler/config.json`). Every field is optional, and flags override it.

```json
{
  "agents": ["claude", "codex", "grok"],
  "judge": "claude",
  "rounds": 2,
  "out": "~/battles",
  "models": { "claude": "opus", "grok": "grok-4.7-high" }
}
```

Model names are passed straight to each CLI. If one isn't available to your account, battler says so,
and for Grok it lists the models your Cursor plan offers.

## How a battle works

1. **Opening:** every debater answers the topic on its own, in parallel.
2. **Debate** (rounds 2+): each debater sees the others' latest positions, rebuts the weakest points, concedes what it should, and revises its own position.
3. **Verdict:** the judge writes the answer, the points of consensus, the open disagreements, a scorecard and a winner.

Debaters appear to each other and to the judge only as "Debater A/B/C", so arguments are judged on merit, not brand.
If a debater errors or hits a usage limit, it is dropped and the battle continues as long as two remain.

## Subscriptions, usage and privacy

- **Subscriptions only.** `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `CURSOR_API_KEY` and similar variables are removed before each CLI starts, so an exported key is never billed.
- **Usage.** A default battle with three debaters makes 7 calls (3 opening + 3 debate + 1 verdict). Each counts against that service's normal subscription limits, the same as if you'd typed the prompts yourself. Each extra round adds one call per debater.
- **Sandboxed.** The CLIs are coding agents, so battler runs them without tools (Claude), read-only (Codex) or in ask mode (Cursor), inside an empty temporary folder. They never see your files.
- **Terms.** battler only invokes each vendor's official CLI in its documented non-interactive mode. You are responsible for using your accounts within Anthropic's, OpenAI's and Cursor's terms, and heavy automated use may hit their rate limits.

## Project layout

```
src/core/       battle engine, prompts, report (knows nothing about CLIs)
src/adapters/   Agent implementations. cli-agents.ts drives the three CLIs
src/cli.ts      terminal front end
src/config.ts   config file loader
```

Development: `npm run dev -- "topic"` runs the TypeScript sources directly (Node 23.6+), and `npm run build` compiles to `dist/`.

## License

MIT
