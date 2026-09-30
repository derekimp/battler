# Contributing

Thanks for helping. A few things to know:

- **Setup:** `npm install`, then `npm test`. Tests never call a real AI: `test/fixtures/bin` holds fake
  `claude`, `codex` and `cursor-agent` programs that mimic the real CLIs.
- **Run your changes:** `npm run dev -- "a topic"` runs the TypeScript sources directly (Node 23.6+).
- **Before a PR:** `npm run typecheck && npm test && npm run test:dist`.
- **No runtime dependencies.** battler ships as plain Node with zero dependencies; please keep it that way.
- **Adding a new AI:** implement the `Agent` interface (`src/core/types.ts`) in `src/adapters/`, keep it
  subscription-only (no API keys), run it without tools or file access, and add a fake binary for tests.
- **Platform:** macOS is what CI covers today. Linux fixes are welcome.
