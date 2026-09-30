import assert from "node:assert/strict";
import { test } from "node:test";
import { renderReport, renderVerdictMarkdown } from "../src/core/report.ts";
import type { BattleResult } from "../src/core/types.ts";
import { parseVerdict, type Length } from "../src/core/verdict.ts";
import { visibleWidth, type Style } from "../src/ui/term.ts";
import { renderVerdict } from "../src/ui/verdict-view.ts";

const plain = { on: false, bold: (s: string) => s, dim: (s: string) => s, italic: (s: string) => s, red: (s: string) => s,
  green: (s: string) => s, yellow: (s: string) => s, cyan: (s: string) => s, fg: (_: number, s: string) => s } as Style;

function result(length: Length, verdictOverride?: object): BattleResult {
  const verdict = parseVerdict(
    JSON.stringify({
      answer: "Debater B is right: **use spaces** with `prettier`. " + "More words here. ".repeat(12),
      agreement: "partial",
      consensus: ["Formatters settle it.", "Debater A conceded alignment."],
      disagreements: [{ point: "Accessibility", sides: [{ debaters: ["Debater A"], view: "Tabs help." }, { debaters: ["Debater B"], view: "Editors can fix spaces." }] }],
      scorecard: [
        { debater: "Debater A", position: "Tabs | sometimes", strength: "Accessibility", weakness: "Alignment", score: 7 },
        { debater: "Debater B", position: "Spaces", strength: "Consistency", weakness: "Rigid", score: 8.5 },
      ],
      winner: { debater: "Debater B", reason: "Debater B was more precise." },
      ...verdictOverride,
    }),
  );
  return {
    topic: "Tabs or spaces?",
    length,
    rounds: [[{ agentId: "c", agentName: "Claude", round: 1, text: "## Position\nDebater B is wrong.", ms: 5000 }]],
    verdict,
    verdictText: "raw",
    judges: ["Claude"],
    names: new Map([["Debater A", "Claude"], ["Debater B", "GPT"]]),
    dropped: [],
  };
}

for (const width of [40, 80, 120]) {
  test(`terminal verdict fits in ${width} columns at every length`, () => {
    for (const length of ["short", "medium", "long"] as const) {
      const out = renderVerdict(result(length), plain, width);
      for (const line of out.split("\n")) assert.ok(visibleWidth(line) <= width, `${length}@${width}: "${line}" is ${visibleWidth(line)}`);
      assert.doesNotMatch(out, /Debater [AB]/, "labels are replaced by names");
    }
  });
}

test("short shows answer and winner; medium adds sections; long adds strengths", () => {
  const short = renderVerdict(result("short"), plain, 90);
  const medium = renderVerdict(result("medium"), plain, 90);
  const long = renderVerdict(result("long"), plain, 90);
  assert.match(short, /GPT wins/);
  assert.match(short, /GPT 8\.5 {2}· {2}Claude 7\.0/);
  assert.doesNotMatch(short, /Agreed|Scorecard/);
  assert.match(medium, /Agreed[\s\S]*Still debated[\s\S]*Scorecard[\s\S]*GPT wins/);
  assert.doesNotMatch(medium, /\+ Consistency/);
  assert.match(long, /\+ Consistency/);
  assert.match(long, /− Rigid/);
});

test("scorecard is sorted by score and bars match", () => {
  const out = renderVerdict(result("medium"), plain, 90);
  assert.ok(out.indexOf("GPT     ████████▌░") < out.indexOf("Claude  ███████░░░"));
});

test("a tie is shown as a tie", () => {
  assert.match(renderVerdict(result("short", { winner: { debater: "tie", reason: "Even." } }), plain, 80), /★ Tie/);
});

test("unparseable verdicts fall back to the judge's prose", () => {
  const r = { ...result("medium"), verdict: null, verdictText: "Debater A won on points." };
  assert.match(renderVerdict(r, plain, 80), /Claude won on points\./);
  assert.equal(renderVerdictMarkdown(r), "Claude won on points.\n");
});

test("markdown verdict: short is compact, medium has a scorecard table with escaped pipes", () => {
  const short = renderVerdictMarkdown(result("short"));
  assert.match(short, /\*\*GPT wins\.\*\* GPT was more precise\./);
  assert.doesNotMatch(short, /## Scorecard/);
  const medium = renderVerdictMarkdown(result("medium"));
  assert.match(medium, /\| GPT \| 8\.5 \| Spaces \|/);
  assert.match(medium, /Tabs \\\| sometimes/);
});

test("report has the verdict, then the transcript with real names", () => {
  const report = renderReport(result("medium"));
  assert.match(report, /^# Tabs or spaces\?/);
  assert.ok(report.indexOf("## Answer") < report.indexOf("# Transcript"));
  assert.match(report, /### Claude · 5s\n\n## Position\nGPT is wrong\./);
});

test("a Chinese verdict stays inside the box at every width", () => {
  const r = result("long", {
    answer: "可以做，但应定位为“AI相关升学与职业路径规划”，而不是把“CS是进入AI的最好门票”当作建立信任的口号：CS可作为AI工程方向本科申请的默认推荐，但科研岗更看数学、统计和研究训练。",
    consensus: ["信任应来自可核对的课程对比、费用、签证和就业信息。"],
    winner: { debater: "Debater B", reason: "Debater B对CS适用范围的界定最精确，反驳最有针对性。" },
  });
  for (const width of [40, 72, 100]) {
    const out = renderVerdict(r, plain, width);
    const lines = out.split("\n");
    for (const line of lines) assert.ok(visibleWidth(line) <= width, `${width}: "${line}" is ${visibleWidth(line)}`);
    // Every line of the box has its right border in the same column.
    const box = lines.filter((l) => l.includes("│"));
    assert.ok(box.length > 2);
    assert.ok(box.every((l) => visibleWidth(l) === visibleWidth(box[0])), `${width}: ragged box`);
  }
});
