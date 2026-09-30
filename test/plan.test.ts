import assert from "node:assert/strict";
import { test } from "node:test";
import { cursorGrokAgent, cursorModelOf, DEFAULT_GROK_MODEL } from "../src/adapters/cli-agents.ts";
import type { SavedBattle } from "../src/core/saved-core.ts";
import { continuePlan } from "../src/plan.ts";

const saved = (grokSpec: string): SavedBattle => ({
  version: 1,
  topic: "T?",
  length: "short",
  createdAt: "2026-09-30T00:00:00Z",
  agents: [
    { id: "claude", name: "Claude", spec: "claude" },
    { id: "grok", name: "Grok", spec: grokSpec },
  ],
  labels: [["claude", "Debater A"], ["grok", "Debater B"]],
  rounds: [[{ agentId: "claude", agentName: "Claude", round: 1, text: "a", ms: 1 }, { agentId: "grok", agentName: "Grok", round: 1, text: "b", ms: 1 }]],
  verdict: null,
  verdictText: "",
  judges: ["Claude"],
});

const grokModel = (spec: string) => cursorModelOf(continuePlan(saved(spec), "x.json", "", { config: {} }).agents.find((a) => a.id === "grok")!);

test("the default Grok is saved as the default, not as a specific model", () => {
  assert.equal(cursorGrokAgent().spec, "grok");
  assert.equal(cursorGrokAgent("grok-4.7-high").spec, "grok:grok-4.7-high");
});

test("continuing uses today's default for battles saved with the old default model", () => {
  assert.equal(grokModel("cursor:grok-4.7-medium"), DEFAULT_GROK_MODEL);
  assert.equal(grokModel("grok"), DEFAULT_GROK_MODEL);
});

test("continuing keeps a Grok model that was chosen explicitly", () => {
  assert.equal(grokModel("grok:grok-4.7-high"), "grok-4.7-high");
  assert.equal(grokModel("cursor:grok-4.7-xhigh"), "grok-4.7-xhigh");
});
