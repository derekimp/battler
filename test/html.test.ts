import assert from "node:assert/strict";
import { test } from "node:test";
import type { BattleResult } from "../src/core/types.ts";
import { parseVerdict } from "../src/core/verdict.ts";
import { renderHtmlReport } from "../src/ui/html-report.ts";
import { escapeHtml, inlineHtml, markdownToHtml } from "../src/ui/markdown.ts";

test("inline Markdown: emphasis, code, links", () => {
  assert.equal(inlineHtml("**bold** and *it* and `a<b`"), "<strong>bold</strong> and <em>it</em> and <code>a&lt;b</code>");
  assert.equal(inlineHtml("[docs](https://x.dev/a)"), '<a href="https://x.dev/a" rel="noopener noreferrer">docs</a>');
  assert.equal(inlineHtml("2 * 3 * 4"), "2 * 3 * 4", "lone asterisks are not emphasis");
  assert.equal(inlineHtml("snake_case_name"), "snake_case_name");
});

test("model output can't inject HTML or scripts", () => {
  const evil = '<script>alert(1)</script> <img src=x onerror=alert(1)> [x](javascript:alert(1)) **<b>**';
  const html = markdownToHtml(evil);
  assert.doesNotMatch(html, /<script|<img|href="javascript/);
  assert.match(html, /&lt;script&gt;/);
  assert.equal(escapeHtml(`"&'`), "&quot;&amp;'");
});

test("block Markdown: headings are demoted, lists, tables, code, quotes", () => {
  const html = markdownToHtml(
    [
      "## Position",
      "Spaces win.",
      "",
      "1. First",
      "2. Second",
      "   - nested",
      "",
      "| A | B |",
      "|---|---|",
      "| 1 | x \\| y |",
      "",
      "```",
      "if (a < b) {}",
      "```",
      "> quoted",
      "---",
    ].join("\n"),
  );
  assert.match(html, /<h4>Position<\/h4>/);
  assert.match(html, /<ol><li>First<\/li><li>Second<br>• nested<\/li><\/ol>/);
  assert.match(html, /<th>A<\/th><th>B<\/th>.*<td>x \| y<\/td>/s);
  assert.match(html, /<pre><code>if \(a &lt; b\) \{\}<\/code><\/pre>/);
  assert.match(html, /<blockquote><p>quoted<\/p><\/blockquote>/);
  assert.match(html, /<hr>/);
});

function result(): BattleResult {
  return {
    topic: "Tabs <or> spaces?",
    length: "medium",
    rounds: [
      [
        { agentId: "claude", agentName: "Claude", round: 1, text: "## Position\n**Spaces.** Debater B is wrong.", ms: 6000 },
        { agentId: "codex", agentName: "GPT", round: 1, text: "## Position\nTabs.", ms: 11000 },
      ],
    ],
    verdict: parseVerdict(
      JSON.stringify({
        answer: "Use **spaces**; Debater B disagrees.",
        agreement: "partial",
        consensus: ["Formatters decide."],
        disagreements: [{ point: "Accessibility", sides: [{ debaters: ["Debater B"], view: "Tabs help." }] }],
        scorecard: [
          { debater: "Debater A", position: "Spaces", strength: "Clear", weakness: "Rigid", criteria: { accuracy: 5, reasoning: 4, engagement: 4, calibration: 4 } },
          { debater: "Debater B", position: "Tabs", strength: "Kind", weakness: "Vague", criteria: { accuracy: 3, reasoning: 3, engagement: 4, calibration: 3 } },
        ],
        winner: { debater: "Debater A", reason: "Debater A was clearer." },
      }),
    ),
    verdictText: "",
    judges: ["Claude"],
    names: new Map([["Debater A", "Claude"], ["Debater B", "GPT"]]),
    dropped: [],
  };
}

test("the HTML report has the verdict, scorecard and transcript, with names revealed", () => {
  const html = renderHtmlReport(result(), new Date("2026-09-29T10:00:00Z"));
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /<title>Tabs &lt;or&gt; spaces\? · battler<\/title>/);
  assert.match(html, /<h1>Tabs &lt;or&gt; spaces\?<\/h1>/);
  assert.match(html, /1 round · medium · judged by Claude · 2026-09-29 10:00/);
  assert.match(html, /Use <strong>spaces<\/strong>; <span class="who" style="--c:#1fa67a">GPT<\/span> disagrees\./);
  assert.match(html, /<span class="who" style="--c:#d97757">Claude<\/span> wins/);
  assert.match(html, /<span class="num">8\.5<\/span>/);
  assert.match(html, /title="accuracy: 5 of 5"/);
  assert.match(html, /<h4>Position<\/h4>\n<p><strong>Spaces\.<\/strong> <span class="who"[^>]*>GPT<\/span> is wrong\.<\/p>/);
  assert.doesNotMatch(html, /Debater [AB]\b(?!\/)/);
});

test("the HTML report falls back to the judge's prose", () => {
  const r = { ...result(), verdict: null, verdictText: "Debater A **won**." };
  assert.match(renderHtmlReport(r), /<p><span class="who"[^>]*>Claude<\/span> <strong>won<\/strong>\.<\/p>/);
});

test("lists continue across blank lines and keep their numbering", () => {
  assert.equal(markdownToHtml("1. a\n\n2. b\n\n3. c"), "<ol><li>a</li><li>b</li><li>c</li></ol>");
  assert.equal(markdownToHtml("3. c\n4. d"), '<ol start="3"><li>c</li><li>d</li></ol>');
  assert.equal(markdownToHtml("- a\n\nNext paragraph."), "<ul><li>a</li></ul>\n<p>Next paragraph.</p>");
  assert.equal(markdownToHtml("- a\n\n1. b"), "<ul><li>a</li></ul>\n<ol><li>b</li></ol>");
});
