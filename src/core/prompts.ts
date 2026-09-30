export const DEBATER_SYSTEM = `You are one of several AI debaters taking part in a structured debate. \
Argue from your own best judgment: be concrete, cite evidence or reasoning, and state your \
confidence. Do not use tools, do not read or write files, and do not ask clarifying questions; \
if the topic is ambiguous, state the interpretation you are using and proceed. Answer in Markdown.`;

export const JUDGE_SYSTEM = `You are an impartial judge consolidating a multi-AI debate. \
You judge arguments on their merits, not on who made them. Do not use tools. Answer in Markdown.`;

export function openingPrompt(topic: string): string {
  return `DEBATE TOPIC:
${topic}

This is the OPENING round. Give your position independently.

Structure your answer as:
## Position
One or two sentences stating your answer.
## Arguments
Your strongest supporting points (numbered).
## Caveats
Where you might be wrong or what it depends on.
## Confidence
A percentage and one line why.

Keep it under 400 words.`;
}

export interface Position {
  label: string;
  text: string;
}

export function debatePrompt(topic: string, round: number, own: string, others: Position[]): string {
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
For each other debater, the weakest point in their argument and why (name them).
## Concessions
Points from others you now accept, if any.
## Revised position
Your updated answer, self-contained, as if it were the only thing a reader will see.
## Confidence
A percentage and one line on what changed.

Keep it under 500 words.`;
}

export function judgePrompt(topic: string, history: { round: number; positions: Position[] }[]): string {
  const transcript = history
    .map(
      (r) =>
        `## Round ${r.round}${r.round === 1 ? " (opening)" : ""}\n\n` +
        r.positions.map((p) => `### ${p.label}\n${p.text}`).join("\n\n"),
    )
    .join("\n\n---\n\n");
  return `DEBATE TOPIC:
${topic}

Full transcript (debater identities are anonymised):

${transcript}

Produce the consolidated result:

## Answer
The best-supported answer to the topic, in a short paragraph. This is what the user will read first.
## Consensus
Points all or most debaters ended up agreeing on.
## Open disagreements
Points still contested, with the strongest case on each side.
## Scorecard
A table: debater | final position (one line) | strongest contribution | biggest weakness | score out of 10.
## Winner
Which debater argued best and why, in two sentences. "Tie" is allowed.`;
}
