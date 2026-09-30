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
// Like the real ones, Grok (via Cursor) is the slowest and Claude the quickest.
const delay = Number(process.env.FAKE_DELAY_MS ?? 0) * ({ claude: 1, codex: 1.6, "cursor-agent": 2.4 }[cli] ?? 1) * (0.7 + Math.random() * 0.6);
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
    if (process.env.FAKE_RICH) {
      return JSON.stringify({
        answer: "**Start with a modular monolith.** Most small teams ship faster with one deployable and clear internal modules, and can split out a service later when a boundary is proven. Adopt services early only for clearly different workloads such as GPU jobs.",
        agreement: "strong",
        consensus: ["Microservices mainly solve multi-team coordination problems small teams don't have yet.", "Module boundaries should be enforced from day one so a later split is cheap."],
        disagreements: [{ point: "How costly is splitting later?", sides: [{ debaters: [labels[0]], view: "Bounded and predictable if modules own their data." }, { debaters: labels.slice(1), view: "Data gravity makes the first extraction expensive; plan for it early." }] }],
        scorecard: labels.map((d, i) => ({ debater: d, position: ["Monolith first, split on proven boundaries", "Monolith first, enforce data ownership early", "Monolith by default, services for odd workloads"][i % 3], strength: ["Clear decision rule", "Sharp point on data ownership", "Concrete examples"][i % 3], weakness: ["Understated migration cost", "Slightly abstract", "Overconfident early on"][i % 3], criteria: { accuracy: 5 - (i % 2), reasoning: 4 + (i === 1 ? 1 : 0), engagement: 4, calibration: 3 + (i % 2) } })),
        winner: { debater: labels[1] ?? labels[0], reason: `${labels[1] ?? labels[0]} made the sharpest point about data ownership and changed its mind where the others were right.` },
      });
    }
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
  if (process.env.FAKE_RICH) {
    const name = { claude: "Claude", codex: "GPT", "cursor-agent": "Grok" }[cli];
    return [
      round === "revised" ? "## Rebuttals\n**Debater A** overstates the migration cost; a monolith with clear modules splits cleanly later.\n" : "",
      `## ${round === "revised" ? "Revised position" : "Position"}`,
      `${name} thinks **a modular monolith** is the right default for most small teams, with a few services only where a boundary is obvious.`,
      "## Arguments",
      "1. **Fewer moving parts.** One deploy, one database, local transactions.",
      "2. **Boundaries are unclear early.** Splitting too soon bakes in the wrong seams.",
      "3. **Tooling is cheap now,** but the `distributed-systems tax` is not: retries, idempotency, tracing.",
      "## Caveats",
      "- Different scaling needs (GPU work, spiky batch jobs) can justify a service on day one.",
      "## Confidence",
      `${70 + Math.floor(Math.random() * 20)}%, because the evidence is mostly practitioner experience.`,
    ].join("\n");
  }
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
  if (cli === "gemini" && args[0] === "--version") return console.log("0.62.0");

  await sleep(delay);
  if (listed("FAKE_FAIL")) return console.error(`${cli}: simulated failure`), process.exit(2);

  if (cli === "claude") {
    const model = args.includes("--model") ? args[args.indexOf("--model") + 1] : "default";
    return console.log(JSON.stringify({ is_error: false, result: answer(stdin(), `claude[${model}]`) }));
  }
  if (cli === "codex") {
    const out = args[args.indexOf("-o") + 1];
    const model = args.includes("-m") ? args[args.indexOf("-m") + 1] : (process.env.FAKE_CODEX_DEFAULT ?? "default");
    if ((process.env.FAKE_CODEX_UNSUPPORTED ?? "").split(",").includes(model)) {
      // Like the real Codex: the prompt is echoed around the error.
      const prompt = stdin();
      console.error(`user\n${prompt.slice(-200)}\nwarning: Model metadata for \`${model}\` not found.`);
      const err = JSON.stringify({ type: "error", status: 400, error: { type: "invalid_request_error", message: `The '${model}' model is not supported when using Codex with a ChatGPT account.` } });
      console.error(`ERROR: ${err}\nERROR: ${err}`);
      process.exit(1);
    }
    writeFileSync(out, answer(stdin(), `codex[${model}]`));
    return console.log("tokens used\n123");
  }
  if (cli === "gemini") {
    const model = args.includes("-m") ? args[args.indexOf("-m") + 1] : "default";
    // Like the real one: a log line, then the JSON result.
    console.log("Loaded cached credentials.");
    return console.log(JSON.stringify({ response: answer(args[args.indexOf("-p") + 1], `gemini[${model}]`), stats: {} }, null, 2));
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
