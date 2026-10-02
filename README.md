# battler

[![CI](https://github.com/derekimp/battler/actions/workflows/ci.yml/badge.svg)](https://github.com/derekimp/battler/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/battler)](https://www.npmjs.com/package/battler)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](https://github.com/derekimp/battler/blob/main/LICENSE)

**Make your AI subscriptions debate each other, then get one consolidated answer.**

Claude, ChatGPT and Grok (and Gemini, if you have it) each answer your question, read each other's
answers, argue, and revise. Then they judge each other blind: every AI scores the others against the
same checklist, and battler turns that into one verdict: the best-supported answer, where they agree,
where they still disagree, and who argued best.

No API keys and no per-token bills. battler drives the official tools you're already signed in to, so
every call uses the subscriptions you already pay for.

**[Website](https://derekimp.github.io/battler/)** · **[Latest release](https://github.com/derekimp/battler/releases/latest)**

![The battler web app: Claude, GPT and Grok debate "Is it still worth learning to code in 2026?", then judge each other and show a verdict and scorecard](https://raw.githubusercontent.com/derekimp/battler/main/docs/demo-web.gif)

<sub>A real battle in the web app, with the waiting sped up. [MP4 version](https://github.com/derekimp/battler/blob/main/docs/demo-web.mp4).</sub>

## Why battler

- **Uses what you already pay for.** Claude Pro/Max, ChatGPT and Cursor subscriptions, through their own
  official CLIs. API keys are stripped from the environment so nothing is billed per token.
- **A real debate, not just side-by-side answers.** Each AI answers alone, then reads the others, rebuts,
  concedes and revises. You can ask follow-ups and add rounds. (When side by side is all you want, `-c`
  compares in one quick round.)
- **Blind, fair judging.** Debaters are "Debater A/B/C" (shuffled every battle), every AI judges, nobody scores
  itself, and the score comes from a fixed checklist rather than the judge's gut.
- **Local.** Everything runs on your computer. Battles are saved as files you own, and sharing one (an image,
  or a link) is up to you.

## Quick start

```bash
npm install -g battler
battler setup      # checks your AI CLIs, helps install and sign in, runs a test battle
battler serve      # opens the web app
```

Just trying it? `npx battler "your question"` runs it without installing anything.

Or stay in the terminal:

```bash
battler "Is it still worth learning to code in 2026?"
```

![battler in the terminal: "Is a hot dog a sandwich?", Grok wins](https://raw.githubusercontent.com/derekimp/battler/main/docs/demo-terminal.gif)

## Requirements

- **macOS or Linux** (Windows isn't supported yet)
- **Node.js 22** or newer
- At least **two** of these, each signed in with a subscription, **or just Cursor**:

| Debater | Tool | Install | Sign in with |
|---|---|---|---|
| Claude | Claude Code (`claude`) | [claude.com/claude-code](https://claude.com/claude-code) | Claude Pro or Max: run `claude` and log in |
| GPT | Codex CLI (`codex`) | `npm install -g @openai/codex` | ChatGPT: `codex login` |
| Grok | Cursor CLI (`cursor-agent`) | `curl https://cursor.com/install -fsS \| bash` | Cursor: `cursor-agent login` |
| Gemini *(optional)* | Antigravity CLI (`agy`) | `curl -fsSL https://antigravity.google/cli/install.sh \| bash` | Google account: run `agy` once and sign in |

`battler setup` does all of this with you, asking before each install or sign-in. `battler --doctor` shows
what's ready at any time.

### Who debates

With no `--agents` flag, battler uses whatever is ready:

| You have | Debaters |
|---|---|
| Claude Code, Codex and Cursor | Claude, GPT, Grok (plus Gemini if it's signed in) |
| Claude Code and Codex | Claude, GPT |
| One of Claude Code / Codex, plus Cursor | Cursor stands in for the missing one, e.g. Claude, GPT (via Cursor), Grok |
| Only Cursor | Claude (via Cursor), GPT (via Cursor), Grok |

## The web app

```bash
battler serve
```

Opens `http://localhost:4747`: type a question (or pick an example), choose debaters and length, and watch
each answer arrive live, round by round, then the verdict and scorecard. Battles land in the history
sidebar, and a bar at the bottom asks a follow-up, adds a round, or **shares** it as an image or a link.
**Just compare** skips the debate and shows each AI's answer side by side.

- It runs only on your computer, with the same CLIs as the terminal, and saves battles to the same folder.
- **From your phone:** `battler serve --lan` prints a link with a one-time access token for your Wi-Fi.
  Anyone with that link can start battles on your subscriptions, so keep it private.
- `--port 5000` picks another port; `--no-open` doesn't open the browser.

## The terminal

```bash
battler                                               # asks for the topic and length, then offers follow-ups
battler "Is Rust better than Go for backend services?"
battler -s "Tabs or spaces?"                          # short: a quick answer and a winner, ~1 min
battler -c "Best way to learn SQL?"                   # just compare: each answers once, side by side
battler -L "Should we rewrite the monolith?"          # long: an in-depth verdict
battler -r 3 "…"                                      # more debate rounds
battler --open "…"                                    # open the report in your browser afterwards
battler -a claude,grok -j codex "…"                   # choose debaters and a single judge
battler -a claude:opus,codex,grok:cursor-grok-4.6-xhigh "…"   # a model per debater
pbpaste | battler                                     # topic from stdin
```

### Follow-ups and more rounds

Every battle is saved, so you can keep it going:

```bash
battler continue "What if they mainly want to build websites?"   # a follow-up question
battler continue                                                   # one more round, same topic
battler continue -r 2                                              # two more rounds
battler continue --from battles/…-tabs-or-spaces.html "…"          # a specific battle, not the latest
```

- **A follow-up** is a new debate on your new question. Each AI first sees the earlier question, the judges'
  answer, its own final position and everyone else's. Same debaters, same "Debater A/B/C" letters.
- **More rounds** pick up where the debate stopped; the judges then score the whole debate again.
- **After a comparison** (`-c`), `battler continue` has them debate those answers and judge, turning it into
  a full battle. A follow-up question to a comparison is compared too (add `-c` or not, it carries over).

### Comparing instead of debating

`battler -c "…"` (or **Just compare** in the web app) asks each AI once and shows the answers side by side:
no rebuttals, no judges. It's the fastest way to see how they differ and uses one message per AI. If you
want a verdict after all, `battler continue` (or **Have them debate it**) picks up from those answers.

### Sharing

- **Web app:** **Share** under a battle makes an image of the result (question, winner, answer, scores, or
  each AI's position for a comparison) to copy or download, and can **create a link** to the full report.
- **Terminal:** `battler share` uploads your latest battle's report (or `--from` another) as a **secret
  GitHub Gist** with your own `gh` login and prints the link. Secret means unlisted: anyone with the link can
  read it. Needs the [GitHub CLI](https://cli.github.com) (`gh auth login`).

### Output

The verdict is drawn in the terminal; piped, it's Markdown (`battler "…" > answer.md`), and `--json` gives
structured output for scripts. Each battle also saves to `./battles/` a web report (`.html`), the same as
Markdown (`.md`), and the battle itself (`.json`, used by `battler continue`).

### Options

| Option | Default | |
|---|---|---|
| `-a, --agents` | every ready CLI | Debaters, comma-separated `name[:model]`: `claude`, `codex` (or `gpt`), `grok`, `gemini`, or `cursor:<model>` for any model Cursor offers |
| `-j, --judge` | `panel` (short: one judge) | `panel`: every debater judges. Or one agent, same format as `--agents` |
| `-l, --length` | `medium` | `short`, `medium` or `long` (shorthands `-s`, `-m`, `-L`) |
| `-r, --rounds` | 2 | Rounds including the opening, 1-5 |
| `-c, --compare` | | Just compare: one round, answers side by side, no judging |
| `-o, --out` | `./battles` | Where battles are saved |
| `--open` | | Open the web report afterwards |
| `--from` | the latest battle | With `continue`: which battle (its `.html`, `.md` or `.json`) |
| `--json` | | Print the verdict as JSON |
| `--doctor` | | Check each CLI is installed and on a subscription login |

| Length | Debaters write (opening / rebuttal) | Verdict shows |
|---|---|---|
| `short` | ~150 / 200 words | a 1-2 sentence answer, the winner and scores |
| `medium` | ~350 / 450 words | an answer, what they agree on, what's still debated, a scorecard, the winner |
| `long` | ~700 / 900 words | all of that in more depth, plus each debater's strongest and weakest point |

### Config file

Defaults live in `~/.config/battler/config.json`. Every field is optional; flags override them.

```json
{
  "agents": ["claude", "codex", "grok"],
  "judge": "panel",
  "rounds": 2,
  "length": "medium",
  "open": true,
  "out": "~/battles",
  "models": { "claude": "opus", "grok": "cursor-grok-4.6-xhigh" }
}
```

Model names go straight to each CLI. If one isn't available to your account, battler says so (for Grok it
lists the models your Cursor plan offers).

## The Chrome extension (beta)

Prefer the chat websites to CLIs? The extension runs battles in your own browser tabs: it opens ChatGPT and
Claude in temporary/incognito chats and Grok through [cursor.com/agents](https://cursor.com/agents), types each
prompt, waits for the reply and reads it back, all from a side panel with the same verdict, history and
follow-ups. A **copy & paste** mode does the same with you carrying the messages, for when a site changes.

It isn't in the Chrome Web Store yet. To try it:

1. Download `battler-extension-*.zip` from the [latest release](https://github.com/derekimp/battler/releases/latest)
   and unzip it (or build it yourself with `npm run build:extension`, which makes `dist/extension`).
2. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked** and pick the unzipped
   `battler-extension` folder.
3. Sign in to chatgpt.com, claude.ai and cursor.com, then click the battler icon.

> Automating a chat website is a grey area in most providers' terms of service. The extension only acts when
> you start a battle, in visible tabs, one message at a time; copy & paste mode avoids automation entirely.

## How a battle works

1. **Opening:** every debater answers on its own, in parallel.
2. **Debate** (round 2 on): each sees the others' latest positions, rebuts the weakest points, concedes what it
   should, and revises its own position.
3. **Verdict:** the judges return the answer, the points of consensus, the open disagreements, and a 1-5 rating
   for each debater on a fixed checklist.

### Scoring

| Criterion | What it measures |
|---|---|
| Accuracy | Facts and claims are correct; no overclaiming |
| Reasoning | Logic, evidence and concreteness |
| Engagement | Deals with the other debaters' strongest points; concedes and pushes back well |
| Calibration | Stated confidence matches the evidence and the caveats |

- The score out of 10 is computed by battler, not chosen by the judge: the four ratings added up and halved.
- **Panel** (default for medium and long): every debater judges; with three or more, a judge's ratings of
  itself are thrown away; ratings are averaged.
- **The winner is the top of the scorecard.** The judges' first choices break a tie; if they're split too,
  it's a tie.
- **Blind:** debaters and judges only see "Debater A/B/C", shuffled each battle, and debaters are told never to
  say which model they are. Judges can still prefer arguments that reason the way they do, so treat scores as
  informed opinion; the answer, consensus and disagreements are the most reliable part.
- If a debater errors or hits a usage limit, it drops out and the battle continues as long as two remain.

## Subscriptions, usage and privacy

- **Subscriptions only.** `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `CURSOR_API_KEY`, `GEMINI_API_KEY` and similar
  variables are removed before each CLI starts, so an exported key is never billed. Gemini runs through
  Antigravity CLI signed in with your Google account; a Gemini CLI signed in with an API key is refused.
- **Usage.** A medium battle with three debaters makes 9 calls (3 opening + 3 rebuttals + 3 judges); a short
  one makes 7. Each extra round adds one call per debater. They count against your plans' normal limits, the
  same as typing the prompts yourself.
- **Sandboxed.** The CLIs are coding agents, so battler runs them with no tools (Claude), read-only (Codex,
  Gemini CLI; Antigravity CLI's headless mode refuses every tool) or in ask mode (Cursor), in an empty temporary folder. They never see your files.
- **A clean slate every time.** Each AI is told to ignore what it knows about you (Claude Code passes it
  your account email, Cursor your user rules) and answer as it would for anyone. The extension uses
  ChatGPT's temporary chats and Claude's incognito mode, which leave memory out.
- **Terms.** battler invokes each vendor's official CLI in its documented non-interactive mode. You're
  responsible for using your accounts within Anthropic's, OpenAI's, Cursor's and Google's terms.

### Cursor allowances

Cursor Pro splits its included usage in two, and battler's defaults are chosen around that:

| Allowance | Models | battler uses it for |
|---|---|---|
| **Cursor Models** | Cursor's own: `cursor-grok-*`, `composer-*` | Grok, by default (`cursor-grok-4.6-high`) |
| **Other Models** | everything else, including `grok-4.7-*` and Claude, GPT and Gemini models | only if you pick one, or when Cursor stands in for a missing Claude Code or Codex |

`battler --doctor` shows which allowance each Cursor-backed debater uses, and a battle warns before it draws on
"Other Models". Once an allowance runs out, Cursor bills on-demand spend if you've enabled it, so consider
setting a spend limit in Cursor's settings.

## Troubleshooting

| You see | What to do |
|---|---|
| `not found on PATH` | Install that CLI (the message says how), or run `battler setup` |
| `not logged in` | Sign in to that CLI (`battler --doctor` says how) |
| `you've hit your … usage limit` | That plan's limit is used up for now; battler continues without that debater |
| `model isn't available to your … login` | Pick another model with `-a name:model` or `"models"` in the config |
| A debater is slow | Grok via Cursor is usually the slowest; `-a grok:cursor-grok-4.6-high-fast` is quicker |
| A battle stopped before the verdict | Its rounds are saved: `battler continue` (or "Judge it now" in the web app or extension) judges them |
| `Can't reach the AI services` | You look offline; check your connection |
| The Chrome extension's panel is blank | Reload it at `chrome://extensions`; the panel says what failed |

Found a bug? [Open an issue](https://github.com/derekimp/battler/issues) with the output of `battler --doctor`.

## Development

```bash
npm install
npm run dev -- "topic"      # run the TypeScript sources directly (Node 23.6+)
npm test                    # unit and end-to-end tests (fake CLIs; no real AI calls)
npm run typecheck
npm run test:dist           # the same tests against the built dist/
npm run build:extension     # the Chrome extension, in dist/extension
```

```
src/core/       battle engine, prompts, judging panel, reports (knows nothing about CLIs or browsers)
src/adapters/   debaters backed by the CLIs
src/plan.ts     turning a request into a battle (lineup, judges, follow-ups)
src/run.ts      running a battle and saving it
src/cli.ts      the terminal front end        src/server.ts  `battler serve`
src/ui/         terminal rendering and the HTML report
web/            the web app (plain HTML/CSS/JS, no build step)
extension/      the Chrome extension (side panel + content script)
test/           node:test suites; test/fixtures has fake claude/codex/cursor-agent/gemini programs
scripts/demo/   how the demo GIFs were recorded
```

See [CONTRIBUTING.md](https://github.com/derekimp/battler/blob/main/CONTRIBUTING.md) and [CHANGELOG.md](https://github.com/derekimp/battler/blob/main/CHANGELOG.md).

## License

MIT
