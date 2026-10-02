# Changelog

## Unreleased

New:

- **Compare mode** (`-c` / **Just compare**): each AI answers once, side by side, with no debate or judging. One message per AI. `battler continue` (or **Have them debate it**) turns a comparison into a full battle.
- **Sharing:** the web app makes an image of a result to copy or download; `battler share` (or **Create a link**) uploads the report as a secret GitHub Gist with your own `gh` login.
- **A clean slate:** debaters and judges are told to ignore anything they know about you (Claude Code adds your account email, Cursor your user rules), so answers aren't tailored to you or your past chats.
- **Linux** is supported and tested in CI. `npx battler "…"` runs it without installing.

Hardening against failures:

- A dropped connection, a 5xx or an overloaded service is retried once; a used-up plan, a missing CLI or a bad model isn't.
- Rounds are saved as they finish. If judging fails, or the battle is stopped, `battler continue` (or the web app's "Judge the rounds so far") judges what's there, completing the same battle.
- The output folder is checked before a battle starts, and a finished verdict is still shown if saving fails.
- Hand-picked debaters and judges are checked before the battle; continuing a battle leaves out debaters that are no longer ready.
- Judges can't add debaters that don't exist; sloppy labels ("debater a") are normalised.
- When every AI fails because you're offline, battler says so.
- Stopping battler (Ctrl+C, `kill`, closing the terminal) also stops the AI CLIs it started; so does stopping `battler serve`.
- Piping into `head` etc. no longer crashes; very long topics are refused clearly; old Node versions get a clear message.
- Chrome extension: a site's own notice (a usage limit, "something went wrong") is treated as a failure, not an answer; a lingering Stop button no longer stalls a reply; progress is saved each round and interrupted battles can be judged later.

## 0.1.0 (2026-09-30)

First public version.

- Debates between Claude (Claude Code), GPT (Codex CLI) and Grok (Cursor CLI), using subscription logins only; API keys are stripped from the environment.
- Grok defaults to Cursor's own `cursor-grok-4.6-high`, which uses Cursor Pro's roomy "Cursor Models" allowance. `--doctor` and battles flag any debater on the "Other Models" allowance.
- Cursor can stand in for a missing Claude Code or Codex, or run any model it offers (`cursor:<model>`).
- Gemini joins automatically when the Gemini CLI is signed in with a Google account (read-only plan mode; API-key logins are refused).
- Blind judging with shuffled "Debater A/B/C" labels.
- Judge panel: every debater judges on a fixed checklist (accuracy, reasoning, engagement, calibration); scores are averaged and nobody scores itself.
- `short`, `medium` and `long` battles.
- Live terminal progress, a styled verdict, and a web report (`--open`) with each round side by side.
- `battler setup` wizard and interactive mode.
- `battler serve`: a local web app with live progress, history, follow-ups and more rounds; `--lan` for phones on the same Wi-Fi, protected by an access token.
- `battler continue`: ask a follow-up question with the last battle as background, or add more rounds to it. Interactive mode offers follow-ups after each verdict.
- Markdown and `--json` output for scripts.
- Chinese, Japanese and Korean topics render correctly in the terminal (double-width characters, line breaks without spaces).
- If Codex defaults to a model a ChatGPT login can't use, battler falls back to one it can.
