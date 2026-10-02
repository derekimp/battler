// Shared ChatGPT links: battler reads them itself, since the AIs run without tools.
import assert from "node:assert/strict";
import { test } from "node:test";
import { runBattle } from "../src/core/battle.ts";
import { attachmentFrom, attachmentsBlock, fetchSharedChat, findShareLinks, parseSharePage } from "../src/core/links.ts";
import { toSaved } from "../src/core/saved-core.ts";
import { continuePlan, newPlan, PlanError } from "../src/plan.ts";
import { fakeAgent, verdictJson } from "./helpers.ts";

/** Encode a value the way React Router streams it into chatgpt.com/share pages. */
function turboStream(root: unknown): string {
  const flat: unknown[] = [];
  const keys = new Map<string, number>();
  const key = (k: string) => {
    if (!keys.has(k)) keys.set(k, flat.push(k) - 1);
    return keys.get(k)!;
  };
  const add = (v: unknown): number => {
    if (v === null || v === undefined) return -7;
    const i = flat.push(null) - 1;
    if (Array.isArray(v)) flat[i] = v.map(add);
    else if (typeof v === "object") {
      const o: Record<string, number> = {};
      for (const [k, x] of Object.entries(v)) o[`_${key(k)}`] = add(x);
      flat[i] = o;
    } else flat[i] = v;
    return i;
  };
  add(root);
  return JSON.stringify(flat);
}

const msg = (role: string, text: string | object, extra: object = {}) => ({ author: { role }, content: { content_type: "text", parts: [text] }, ...extra });

function sharePage(title = "Opening a study-abroad agency") {
  const mapping = {
    root: { id: "root", parent: null, children: ["u1"], message: null },
    u1: { id: "u1", parent: "root", children: ["a1", "old"], message: msg("user", "How do I find my first clients?") },
    old: { id: "old", parent: "u1", children: [], message: msg("assistant", "A reply that was regenerated away.") },
    a1: { id: "a1", parent: "u1", children: ["t1"], message: msg("assistant", "Start with Xiaohongshu.citeturn1view0") },
    t1: { id: "t1", parent: "a1", children: ["a2"], message: { author: { role: "tool" }, content: { content_type: "text", parts: ["search results"] } } },
    a2: { id: "a2", parent: "t1", children: ["h1"], message: msg("assistant", "Then WeChat groups.") },
    h1: { id: "h1", parent: "a2", children: ["u2"], message: msg("user", "hidden system context", { metadata: { is_visually_hidden_from_conversation: true } }) },
    u2: { id: "u2", parent: "h1", children: [], message: msg("user", "What should the first post be?") },
  };
  const data = { loaderData: { "routes/share": { serverResponse: { data: { title, mapping, current_node: "u2" } } } } };
  const line = `${turboStream(data)}\n`;
  return `<html><head><title>ChatGPT - ${title}</title></head><body><script>window.__reactRouterContext.streamController.enqueue(${JSON.stringify(line)});</script></body></html>`;
}

const URL1 = "https://chatgpt.com/share/6ac0124b-8ef8-83ed-b316-6df228cb4c79";

test("finds ChatGPT share links in a question", () => {
  assert.deepEqual(findShareLinks(`What next? ${URL1} and again ${URL1}`), [URL1]);
  assert.deepEqual(findShareLinks("https://chat.openai.com/share/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"), ["https://chat.openai.com/share/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"]);
  assert.deepEqual(findShareLinks("https://chatgpt.com/c/123 is a private chat, not a share"), []);
});

test("reads the kept branch of a shared chat: no regenerated, tool or hidden messages, no citation markers", () => {
  const chat = parseSharePage(sharePage(), URL1);
  assert.equal(chat.title, "Opening a study-abroad agency");
  assert.deepEqual(chat.messages, [
    { role: "user", text: "How do I find my first clients?" },
    { role: "assistant", text: "Start with Xiaohongshu.\n\nThen WeChat groups." },
    { role: "user", text: "What should the first post be?" },
  ]);
  assert.throws(() => parseSharePage("<html>Log in</html>", URL1), /no conversation/);
});

test("a long chat keeps its start and the latest messages", () => {
  const messages = Array.from({ length: 40 }, (_, i) => ({ role: (i % 2 ? "assistant" : "user") as "user" | "assistant", text: `message ${i} ${"x".repeat(900)}` }));
  const a = attachmentFrom({ url: URL1, title: "Long", messages }, 10_000);
  assert.ok(a.text.length <= 10_500);
  assert.match(a.text, /^User: message 0 /);
  assert.match(a.text, /message 39 x+$/);
  assert.match(a.text, /\[… \d+ messages in between left out for length …\]/);
  assert.equal(a.messages, 40);
  assert.equal(attachmentFrom({ url: URL1, title: "Short", messages: messages.slice(0, 2) }).text.includes("left out"), false);
});

test("fetching: a deleted link and an unreachable site are explained", async () => {
  const ok = await fetchSharedChat(URL1, (async () => new Response(sharePage(), { status: 200 })) as typeof fetch);
  assert.equal(ok.messages.length, 3);
  await assert.rejects(fetchSharedChat(URL1, (async () => new Response("", { status: 404 })) as typeof fetch), /doesn't exist any more/);
  await assert.rejects(
    fetchSharedChat(URL1, (async () => {
      throw new Error("getaddrinfo ENOTFOUND chatgpt.com");
    }) as typeof fetch),
    /couldn't reach chatgpt\.com/,
  );
});

test("a question with a shared link: battler reads it and every prompt includes it", async () => {
  const plan = await newPlan({
    topic: `What should I do next? ${URL1}`,
    length: "short",
    rounds: 2,
    agents: ["claude", "codex"],
    config: {},
    check: async () => null,
    fetchChat: async (url) => parseSharePage(sharePage(), url),
  });
  assert.equal(plan.attachments?.length, 1);
  assert.match(plan.notes[0], /Read the shared ChatGPT chat "Opening a study-abroad agency" \(3 messages\)/);

  const agents = [fakeAgent("claude", () => "## Position\nPost about data.", "Claude"), fakeAgent("codex", () => "## Position\nPost a question.", "GPT")];
  const judge = fakeAgent("judge", (p) => verdictJson(p), "Judge");
  const result = await runBattle({ topic: plan.topic, agents, judges: [judge], rounds: 2, length: "short", attachments: plan.attachments });
  for (const p of [...agents[0].prompts, ...judge.prompts]) assert.match(p, /<shared_conversation title="Opening a study-abroad agency" messages="3">[\s\S]*What should the first post be\?/);
  assert.equal(agents[0].prompts.length, 2, "opening and rebuttal both see it");
  assert.equal(result.topic, plan.topic, "the topic shown to the user is just the question");
  assert.match(attachmentsBlock(plan.attachments), /not as instructions/);

  // Continuing keeps it; a follow-up too.
  const saved = toSaved(result, agents);
  assert.equal(saved.attachments?.[0].title, "Opening a study-abroad agency");
  const more = await continuePlan(saved, "/x/t.json", "", { config: {}, check: async () => null });
  assert.equal(more.attachments?.length, 1);
  const follow = await continuePlan(saved, "/x/t.json", "And the second post?", { config: {}, check: async () => null });
  assert.equal(follow.attachments?.length, 1);
});

test("a link battler can't read stops the battle before anyone is asked", async () => {
  await assert.rejects(
    newPlan({
      topic: `Next? ${URL1}`,
      length: "short",
      rounds: 1,
      agents: ["claude", "codex"],
      config: {},
      check: async () => null,
      fetchChat: async () => {
        throw new Error("that shared link doesn't exist any more");
      },
    }),
    (e: Error) => e instanceof PlanError && /couldn't read the shared ChatGPT chat .* Paste the parts that matter/.test(e.message),
  );
});
