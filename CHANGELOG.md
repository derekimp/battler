# Changelog

## 0.1.0 (unreleased)

First public version.

- Debates between Claude (Claude Code), GPT (Codex CLI) and Grok (Cursor CLI), using subscription logins only; API keys are stripped from the environment.
- Cursor can stand in for a missing Claude Code or Codex, or run any model it offers (`cursor:<model>`).
- Blind judging with shuffled "Debater A/B/C" labels.
- Judge panel: every debater judges on a fixed checklist (accuracy, reasoning, engagement, calibration); scores are averaged and nobody scores itself.
- `short`, `medium` and `long` battles.
- Live terminal progress, a styled verdict, and a web report (`--open`) with each round side by side.
- `battler setup` wizard and interactive mode.
- `battler continue`: ask a follow-up question with the last battle as background, or add more rounds to it. Interactive mode offers follow-ups after each verdict.
- Markdown and `--json` output for scripts.
- Chinese, Japanese and Korean topics render correctly in the terminal (double-width characters, line breaks without spaces).
- If Codex defaults to a model a ChatGPT login can't use, battler falls back to one it can.
