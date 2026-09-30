// Checks the built extension in dist/extension (run `npm run build:extension` first).
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { ROOT } from "./helpers.ts";

const EXT = join(ROOT, "dist", "extension");
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : [join(dir, f)]));

test("the manifest is a valid MV3 manifest and every file it names exists", () => {
  const m = JSON.parse(readFileSync(join(EXT, "manifest.json"), "utf8"));
  assert.equal(m.manifest_version, 3);
  assert.deepEqual(m.host_permissions, ["https://chatgpt.com/*", "https://claude.ai/*", "https://cursor.com/*"]);
  for (const f of [m.background.service_worker, m.side_panel.default_path, ...m.content_scripts[0].js, ...Object.values(m.icons)]) {
    assert.ok(existsSync(join(EXT, f as string)), f as string);
  }
});

test("every relative import in the extension resolves", () => {
  for (const f of files(EXT).filter((f) => f.endsWith(".js"))) {
    for (const [, spec] of readFileSync(f, "utf8").matchAll(/from\s+"(\.[^"]+)"/g)) {
      assert.ok(existsSync(resolve(dirname(f), spec)), `${f} imports missing ${spec}`);
    }
  }
});

test("the bundled engine runs a battle", async () => {
  const { runBattle } = await import(join(EXT, "lib", "core", "battle.js"));
  const { toSaved, savedToResult } = await import(join(EXT, "lib", "core", "saved-core.js"));
  const { renderVerdictHtml } = await import(join(EXT, "lib", "ui", "html-report.js"));
  const agent = (id: string, name: string) => ({
    id,
    name,
    async ask(prompt: string) {
      if (!prompt.includes("Consolidate this debate")) return `## Position\n${name} says so.`;
      const labels = [...new Set([...prompt.matchAll(/### (Debater [A-Z])/g)].map((m) => m[1]))];
      return JSON.stringify({
        answer: "An answer.",
        agreement: "strong",
        consensus: [],
        disagreements: [],
        scorecard: labels.map((d, i) => ({ debater: d, position: "p", strength: "s", weakness: "w", criteria: { accuracy: 5 - i, reasoning: 4, engagement: 4, calibration: 4 } })),
        winner: { debater: labels[0], reason: "r" },
      });
    },
    async check() {
      return null;
    },
  });
  const agents = [agent("claude", "Claude"), agent("chatgpt", "ChatGPT")];
  const result = await runBattle({ topic: "T?", agents, judges: agents, rounds: 2, length: "medium" });
  const saved = toSaved(result, agents);
  assert.equal(saved.rounds.length, 2);
  assert.match(renderVerdictHtml(savedToResult(saved)), /An answer\./);
});
