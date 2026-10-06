import { CRITERIA, CRITERIA_HELP, type Length } from "./verdict.ts";

/**
 * Every battle starts from a clean slate. The CLIs can slip in things about the person (Claude Code
 * adds the account's email, Cursor its user rules) and there's no flag to turn that off, so the
 * prompt tells them to set it aside.
 */
export const FRESH_START =
  "This is a fresh, standalone session: ignore any memory, saved rules or instructions, account details \
or earlier conversations about the person asking, and don't mention them. Answer as you would for anyone.";

export const DEBATER_SYSTEM = `You are one of several AI debaters taking part in a structured debate. \
Argue from your own best judgment: be concrete, cite evidence or reasoning, and state your \
confidence. Do not use tools, do not read or write files, and do not ask clarifying questions; \
if the topic is ambiguous, state the interpretation you are using and proceed. Debaters are \
anonymous: never say which AI model, assistant or company you are. ${FRESH_START} Write in the language the debate topic is written in. Answer in Markdown.`;

export const JUDGE_SYSTEM = `You are an impartial judge consolidating a multi-AI debate. \
You judge arguments on their merits, not on who made them. Do not use tools. ${FRESH_START} \
You reply with a single JSON object and nothing else.`;

/** Word budgets per round. Shorter battles are also noticeably faster. */
const BUDGET: Record<Length, { opening: number; debate: number }> = {
  short: { opening: 150, debate: 200 },
  medium: { opening: 350, debate: 450 },
  long: { opening: 700, debate: 900 },
};

export interface FollowUpContext {
  topic: string;
  answer: string;
  finals: Map<string, string>;
}

/**
 * What a debater is told about the earlier battle before a follow-up question: the old question,
 * the judges' answer, its own final position and everyone else's (under their same labels).
 */
export function followUpBackground(f: FollowUpContext, agentId: string, labels: Map<string, string>): string {
  const own = f.finals.get(agentId);
  const others = [...f.finals]
    .filter(([id]) => id !== agentId && labels.has(id))
    .map(([id, text]) => ({ label: labels.get(id)!, text }))
    .sort((a, b) => a.label.localeCompare(b.label))
    .map((o) => `### ${o.label}\n${o.text}`)
    .join("\n\n");
  return `BACKGROUND: this is a follow-up to an earlier debate you took part in, as ${labels.get(agentId) ?? "one of the debaters"}.

Earlier question:
${f.topic}

The judges' consolidated answer:
${f.answer}
${own ? `\nYour final position then:\n<your_earlier_position>\n${own}\n</your_earlier_position>\n` : ""}${
    others ? `\nThe other debaters' final positions then:\n<earlier_positions>\n${others}\n</earlier_positions>\n` : ""
  }
Build on that debate rather than repeating it. You may change your mind.`;
}

export function openingPrompt(topic: string, length: Length, background?: string): string {
  return `${background ? `${background}\n\n---\n\n` : ""}DEBATE TOPIC:
${topic}

This is the OPENING round${background ? " of the follow-up" : ""}. Give your position independently.

Structure your answer as:
## Position
One or two sentences stating your answer.
## Arguments
Your strongest supporting points (numbered).
## Caveats
Where you might be wrong or what it depends on.
## Confidence
A percentage and one line why.

Keep it under ${BUDGET[length].opening} words.`;
}

export interface Position {
  label: string;
  text: string;
}

export function debatePrompt(topic: string, round: number, own: string, others: Position[], length: Length): string {
  const theirs = others.map((o) => `### ${o.label}\n${o.text}`).join("\n\n");
  return `DEBATE TOPIC:
${topic}

This is ROUND ${round}. Your current position:

<your_position>
${own}
</your_position>

The other debaters' current positions:

<other_positions>
${theirs}
</other_positions>

Engage with them directly. Change your mind where they are right; push back where they are wrong. \
Do not just agree to be agreeable.

Structure your answer as:
## Rebuttals
For each other debater, the weakest point in their argument and why. Refer to them by their full label, e.g. "Debater A".
## Concessions
Points from others you now accept, if any.
## Revised position
Your updated answer, self-contained, as if it were the only thing a reader will see.
## Confidence
A percentage and one line on what changed.

Keep it under ${BUDGET[length].debate} words.`;
}

const JUDGE_LIMITS: Record<Length, string> = {
  short: `- "answer": at most 2 sentences.
- "consensus": at most 3 items, each under 15 words.
- "disagreements": at most 2, each view under 20 words.
- scorecard "position", "strength", "weakness": under 10 words each.
- "winner.reason": one sentence.`,
  medium: `- "answer": one paragraph, at most 80 words.
- "consensus": at most 5 items, each under 25 words.
- "disagreements": at most 3, each view under 35 words.
- scorecard "position", "strength", "weakness": under 18 words each.
- "winner.reason": at most 2 sentences.`,
  long: `- "answer": at most 220 words; use "\\n\\n" between paragraphs if helpful.
- "consensus": at most 8 items, each under 40 words.
- "disagreements": at most 5, each view under 60 words, with the strongest case for each side.
- scorecard "position", "strength", "weakness": under 30 words each.
- "winner.reason": at most 3 sentences.`,
};

export function judgePrompt(
  topic: string,
  history: { round: number; positions: Position[] }[],
  length: Length,
  followUp?: FollowUpContext,
): string {
  const transcript = history
    .map(
      (r) =>
        `## Round ${r.round}${r.round === 1 ? " (opening)" : ""}\n\n` +
        r.positions.map((p) => `### ${p.label}\n${p.text}`).join("\n\n"),
    )
    .join("\n\n---\n\n");
  const labels = history[0].positions.map((p) => `"${p.label}"`).join(", ");
  const context = followUp
    ? `\nThis debate is a follow-up to an earlier one on "${followUp.topic}", whose answer was:\n${followUp.answer}\nJudge how well the debaters answer the follow-up question.\n`
    : "";
  return `DEBATE TOPIC:
${topic}
${context}
Full transcript (debater identities are anonymised):

${transcript}

Consolidate this debate. Reply with ONLY this JSON object, no code fence and no other text:

{
  "answer": "The best-supported answer to the topic. This is what the reader sees first, so lead with the conclusion.",
  "agreement": "strong" | "partial" | "split",
  "consensus": ["Point all or most debaters ended up agreeing on", "..."],
  "disagreements": [
    { "point": "What is still contested",
      "sides": [ { "debaters": ["Debater A"], "view": "Their strongest case" },
                 { "debaters": ["Debater B", "Debater C"], "view": "..." } ] }
  ],
  "scorecard": [
    { "debater": "Debater A", "position": "Final position", "strength": "Strongest contribution",
      "weakness": "Biggest weakness",
      "criteria": { ${CRITERIA.map((c) => `"${c}": 1-5`).join(", ")} } }
  ],
  "winner": { "debater": "Debater A" or "tie", "reason": "Why" }
}

Rules:
- Refer to debaters only by their full labels (${labels}), never by a bare letter such as "B's".
  Include every one of them in "scorecard".
- Rate each debater on every criterion from 1 (poor) to 5 (excellent), judging their whole
  performance with the most weight on their final position:
${CRITERIA.map((c) => `  - ${c}: ${CRITERIA_HELP[c]}`).join("\n")}${
    history.length === 1 ? "\n  This was a single round, so for engagement judge how well they anticipate counterarguments." : ""
  }
  Use the full range; do not give everyone 4s. "winner" should be the debater with the best ratings.
- Base the answer on the debaters' final positions and the strength of their arguments, not on a vote.
- "disagreements" may be empty if they fully converged.
- Plain text inside strings; **bold** and \`code\` are allowed, no other Markdown, no tables.
${JUDGE_LIMITS[length]}`;
}
