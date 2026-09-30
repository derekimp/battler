import assert from "node:assert/strict";
import { test } from "node:test";
import { colorNames, debaterColor, formatDuration, inline, plainPreview, truncate, visibleWidth, wrap, type Style } from "../src/ui/term.ts";

const plain = { on: false } as Style;
const color = { on: true, fg: (c: number, s: string) => `<${c}>${s}</>` } as Style;

test("wrap respects width, ignoring ** and ` markers", () => {
  const lines = wrap("one **two** three `four` five six seven", 15);
  assert.deepEqual(lines, ["one **two** three", "`four` five six", "seven"]);
  for (const l of lines) assert.ok(l.replace(/\*\*|`/g, "").length <= 15);
});

test("wrap hard-breaks words longer than a line and keeps paragraph breaks", () => {
  assert.deepEqual(wrap("aaaaaaaaaa bb", 4), ["aaaa", "aaaa", "aa", "bb"]);
  assert.deepEqual(wrap("a\n\nb", 10), ["a", "", "b"]);
});

test("inline turns markers into ANSI and carries bold across lines", () => {
  const out = inline(["a **b", "c** `d`"], { on: true } as Style);
  assert.equal(out[0], "a \x1b[1mb\x1b[22m");
  assert.equal(out[1], "\x1b[1mc\x1b[22m \x1b[36md\x1b[39m");
  assert.deepEqual(inline(["**x** `y`"], plain), ["x y"]);
});

test("visibleWidth ignores ANSI codes; truncate adds an ellipsis", () => {
  assert.equal(visibleWidth("\x1b[1mhello\x1b[22m"), 5);
  assert.equal(truncate("hello world", 8), "hello w…");
  assert.equal(truncate("short", 8), "short");
});

test("plainPreview prefers the (revised) position section and strips Markdown", () => {
  const md = "## Rebuttals\nDebater B is wrong.\n## Revised position\n**Use** `spaces` - see [docs](http://x).";
  assert.equal(plainPreview(md), "Use spaces - see docs.");
  assert.equal(plainPreview("# Title\n\n- first bullet"), "first bullet");
});

test("colorNames colors whole names only, longest first", () => {
  const s = colorNames("Claude (via Cursor) vs Claude vs Claudette", ["Claude", "Claude (via Cursor)"], color);
  assert.equal(s, `<${debaterColor("Claude")}>Claude (via Cursor)</> vs <173>Claude</> vs Claudette`);
});

test("debater colors are by family", () => {
  assert.equal(debaterColor("Claude (via Cursor)"), debaterColor("Claude"));
  assert.notEqual(debaterColor("GPT"), debaterColor("Grok"));
  assert.equal(debaterColor("Unknown"), 250);
});

test("formatDuration", () => {
  assert.equal(formatDuration(5_400), "5s");
  assert.equal(formatDuration(68_000), "1m 08s");
});

test("CJK characters are two columns wide", () => {
  assert.equal(visibleWidth("可以做"), 6);
  assert.equal(visibleWidth("AI路径"), 6);
  assert.equal(visibleWidth("\x1b[1m机构\x1b[22m ok"), 7);
  assert.equal(visibleWidth("é"), 1, "combining marks take no space");
  assert.equal(visibleWidth("👍"), 2);
});

test("truncate cuts by columns, so live progress rows never wrap", () => {
  const t = truncate("机构可以做，定位是 AI 相关路径规划，不是保送", 20);
  assert.equal(t, "机构可以做，定位是…");
  assert.ok(visibleWidth(t) <= 20);
  for (let w = 2; w < 40; w++) assert.ok(visibleWidth(truncate("中文和English混合的一行很长的文字", w)) <= w, `width ${w}`);
});

test("wrap breaks Chinese text between characters, within the width", () => {
  const text = "可以做，但应定位为“AI相关升学与职业路径规划”，而不是把“CS是进入AI的最好门票”当作口号。**信任**应来自可核对的信息。";
  for (const w of [10, 17, 30, 61]) {
    const lines = wrap(text, w);
    for (const l of lines) assert.ok(visibleWidth(l.replace(/\*\*|`/g, "")) <= w, `"${l}" > ${w}`);
    assert.equal(lines.join(""), text.replace(/\s+/g, ""), "nothing is lost or added");
  }
});

test("a line never starts with closing punctuation", () => {
  // Width 6 fits exactly three characters, so "，" would land at the start of line 2.
  const lines = wrap("可以做，但是", 6);
  assert.ok(lines.every((l) => !/^[，。]/.test(l)), JSON.stringify(lines));
  assert.equal(lines.join(""), "可以做，但是");
});

test("mixed English and Chinese keeps the spaces English needs", () => {
  assert.deepEqual(wrap("Use spaces 而不是 tabs", 40), ["Use spaces 而不是 tabs"]);
  assert.deepEqual(wrap("hello world", 5), ["hello", "world"]);
});
