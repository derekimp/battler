#!/usr/bin/env node
// Stand-in for the claude / codex / cursor-agent CLIs, so tests never touch a real subscription.
// Which CLI it pretends to be comes from the name it was invoked as (see ./bin).
// Behaviour knobs (env): FAKE_LOGGED_OUT, FAKE_FAIL (comma-separated CLI names),
// FAKE_DELAY_MS, FAKE_BAD_JSON_ONCE (judge answers in prose first), FAKE_LOG (append argv here).
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";

const cli = basename(process.argv[1]);
const args = process.argv.slice(2);
const listed = (v) => (process.env[v] ?? "").split(",").includes(cli);
if (process.env.FAKE_LOG) appendFileSync(process.env.FAKE_LOG, JSON.stringify({ cli, args }) + "\n");

const stdin = () => (process.stdin.isTTY ? "" : readFileSync(0, "utf8"));
const delay = Number(process.env.FAKE_DELAY_MS ?? 0);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const LEAK_VARS = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "CURSOR_API_KEY"];

function answer(prompt, who) {
  const leaked = LEAK_VARS.filter((v) => process.env[v]);
  if (leaked.length) return `LEAKED ${leaked.join(",")}`;
  if (prompt.includes("Consolidate this debate")) {
    const flag = `${process.env.FAKE_BAD_JSON_ONCE ?? ""}`;
    if (flag && !existsSync(flag)) {
      writeFileSync(flag, "done");
      return "I think Debater A won, honestly.";
    }
    const labels = [...new Set([...prompt.matchAll(/### (Debater [A-Z])/g)].map((m) => m[1]))];
    return JSON.stringify({
      answer: `Consolidated answer by ${who}. **Bold** point.`,
      agreement: "partial",
      consensus: ["Everyone agrees on one thing."],
      disagreements: [{ point: "One open point", sides: [{ debaters: [labels[0]], view: "Yes." }, { debaters: labels.slice(1), view: "No." }] }],
      scorecard: labels.map((d, i) => ({
        debater: d, position: `Position of ${d}`, strength: "Clear", weakness: "Short",
        criteria: { accuracy: 5 - i, reasoning: 4, engagement: 4, calibration: 4 },
      })),
      winner: { debater: labels[0], reason: `${labels[0]} argued best.` },
    });
  }
  const round = prompt.includes("This is ROUND") ? "revised" : "opening";
  return `## ${round === "revised" ? "Revised position" : "Position"}\n${who} ${round} position.\n## Confidence\n70%`;
}

async function main() {
  if (listed("FAKE_LOGGED_OUT")) {
    if (cli === "claude") return console.log(JSON.stringify({ loggedIn: false }));
    if (cli === "codex") return console.error("Not logged in"), process.exit(1);
    return console.log("Not logged in");
  }
  if (cli === "claude" && args[0] === "auth") return console.log(JSON.stringify({ loggedIn: true, authMethod: "claude.ai" }));
  if (cli === "codex" && args[0] === "login") return console.log("Logged in using ChatGPT");
  if (cli === "cursor-agent" && args[0] === "status") return console.log("✓ Logged in as test@example.com");

  await sleep(delay);
  if (listed("FAKE_FAIL")) return console.error(`${cli}: simulated failure`), process.exit(2);

  if (cli === "claude") {
    const model = args.includes("--model") ? args[args.indexOf("--model") + 1] : "default";
    return console.log(JSON.stringify({ is_error: false, result: answer(stdin(), `claude[${model}]`) }));
  }
  if (cli === "codex") {
    const out = args[args.indexOf("-o") + 1];
    const model = args.includes("-m") ? args[args.indexOf("-m") + 1] : "default";
    writeFileSync(out, answer(stdin(), `codex[${model}]`));
    return console.log("tokens used\n123");
  }
  if (cli === "cursor-agent") {
    const model = args[args.indexOf("--model") + 1];
    if (model.includes("bogus")) {
      console.error(`Cannot use this model: ${model}. Available models: auto, grok-4.7-low, grok-4.7-medium, gpt-5.5-medium`);
      process.exit(1);
    }
    return console.log(JSON.stringify({ type: "result", is_error: false, result: answer(args.at(-1), `cursor[${model}]`) }));
  }
}
main();
