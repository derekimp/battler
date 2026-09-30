import type { BattleResult } from "../core/types.ts";
import { CRITERIA, namedVerdict, panelNote, revealNames, winnerDetail } from "../core/verdict.ts";
import { escapeHtml, inlineHtml, markdownToHtml } from "./markdown.ts";

/** Hex colors per model family, matching the terminal palette. */
const FAMILY_COLORS: Record<string, string> = {
  Claude: "#d97757",
  GPT: "#1fa67a",
  Grok: "#5b8def",
  Gemini: "#9b72f2",
  Kimi: "#14b8c4",
  Composer: "#d4a106",
};
export const htmlColor = (name: string) => FAMILY_COLORS[name.replace(/\s*\(.*\)$/, "")] ?? "#8a8f98";

const secs = (ms: number) => {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
};

/** Wrap every debater name in a colored span. Runs on already-escaped HTML. */
function tagNames(html: string, names: string[]): string {
  if (!names.length) return html;
  const sorted = [...names].sort((a, b) => b.length - a.length).map((n) => escapeHtml(n));
  const re = new RegExp(`\\b(${sorted.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})(?![\\w])`, "g");
  // Only replace in text, never inside tags or attributes.
  return html.replace(/(<[^>]*>)|([^<]+)/g, (m, tag: string | undefined, text: string | undefined) =>
    tag ? tag : text!.replace(re, (n) => `<span class="who" style="--c:${htmlColor(n)}">${n}</span>`),
  );
}

/** A complete, self-contained HTML page for one battle. */
export function renderHtmlReport(result: BattleResult, date = new Date()): string {
  const names = [...result.names.values()];
  const inl = (s: string) => tagNames(inlineHtml(s), names);
  const v = namedVerdict(result);
  const judged =
    result.judges.length === 1
      ? `judged by ${escapeHtml(result.judges[0])}`
      : `judged by a panel of ${result.judges.length}`;

  const chips = names.map((n) => `<span class="chip" style="--c:${htmlColor(n)}">${escapeHtml(n)}</span>`).join("");
  const meta = [
    `${result.rounds.length} round${result.rounds.length === 1 ? "" : "s"}`,
    result.length,
    judged,
    date.toISOString().slice(0, 16).replace("T", " "),
  ].join(" · ");

  let verdictHtml: string;
  if (!v) {
    verdictHtml = `<section class="card verdict"><div class="eyebrow">Verdict</div>${tagNames(markdownToHtml(revealNames(result.verdictText, result.names)), names)}</section>`;
  } else {
    const detail = winnerDetail(v);
    const winnerTitle =
      v.winner.debater === "Tie"
        ? v.panel
          ? "No clear winner"
          : "Tie"
        : `${inl(v.winner.debater)} wins${detail ? ` <span class="muted">(${escapeHtml(detail)})</span>` : ""}`;
    const scoreRows = v.scorecard
      .map((s) => {
        const color = htmlColor(s.debater);
        const crit = s.criteria
          ? `<div class="criteria">${CRITERIA.map(
              (c) =>
                `<span title="${c}: ${s.criteria![c]} of 5"><i>${c}</i><b style="--w:${(s.criteria![c] / 5) * 100}%;--c:${color}"></b><em>${s.criteria![c]}</em></span>`,
            ).join("")}</div>`
          : "";
        return `<div class="score-row">
  <div class="score-head"><span class="name" style="--c:${color}">${escapeHtml(s.debater)}</span>
    <span class="bar"><span style="width:${s.score * 10}%;background:${color}"></span></span>
    <span class="num">${s.score.toFixed(1)}</span></div>
  <div class="score-body">
    ${s.position ? `<p>${inl(s.position)}</p>` : ""}
    ${s.strength ? `<p class="plus"><span>+</span>${inl(s.strength)}</p>` : ""}
    ${s.weakness ? `<p class="minus"><span>−</span>${inl(s.weakness)}</p>` : ""}
    ${crit}
  </div>
</div>`;
      })
      .join("\n");
    const note = panelNote(v);
    const consensus = v.consensus.length
      ? `<div class="card"><h2>Agreed</h2><ul class="checks">${v.consensus.map((c) => `<li>${inl(c)}</li>`).join("")}</ul></div>`
      : "";
    const disputes = v.disagreements.length
      ? `<div class="card"><h2>Still debated</h2>${v.disagreements
          .map(
            (d) =>
              `<div class="dispute"><h3>${inl(d.point)}</h3>${d.sides
                .map((s) => `<p><span class="side">${inl(s.debaters.join(", ") || "Others")}</span> ${inl(s.view)}</p>`)
                .join("")}</div>`,
          )
          .join("")}</div>`
      : "";
    verdictHtml = `
<section class="card verdict">
  <div class="eyebrow">Verdict <span class="pill ${v.agreement}">${v.agreement} agreement</span></div>
  <div class="answer">${v.answer.split(/\n{2,}/).map((p) => `<p>${inl(p)}</p>`).join("")}</div>
</section>
<section class="card winner">
  <div class="star">★</div>
  <div><h2>${winnerTitle}</h2><p>${inl(v.winner.reason)}</p></div>
</section>
${consensus || disputes ? `<section class="two">${consensus}${disputes}</section>` : ""}
${
  v.scorecard.length
    ? `<section class="card"><h2>Scorecard</h2>${scoreRows}${note ? `<p class="note">${escapeHtml(note)}</p>` : ""}</section>`
    : ""
}`;
  }

  const rounds = result.rounds
    .map((turns, i) => {
      const title = i === 0 ? "Opening statements" : "Rebuttals and revisions";
      const cards = turns
        .map(
          (t) => `<article class="turn" style="--c:${htmlColor(t.agentName)}">
  <header><span class="name">${escapeHtml(t.agentName)}</span><span class="muted">${secs(t.ms)}</span></header>
  <div class="md">${tagNames(markdownToHtml(revealNames(t.text, result.names)), names)}</div>
</article>`,
        )
        .join("\n");
      return `<details class="round"${i === result.rounds.length - 1 ? " open" : ""}>
  <summary><span>Round ${i + 1}</span> ${title}</summary>
  <div class="turns">${cards}</div>
</details>`;
    })
    .join("\n");

  const dropped = result.dropped.length
    ? `<p class="dropped">Dropped: ${result.dropped.map((d) => `${escapeHtml(d.agentName)} (round ${d.round}): ${escapeHtml(d.error.split("\n")[0])}`).join("; ")}</p>`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(result.topic)} · battler</title>
<style>${CSS}</style>
</head>
<body>
<main>
<header class="top">
  <div class="brand">battler</div>
  <h1>${escapeHtml(result.topic)}</h1>
  <div class="meta">${chips}<span class="muted">${meta}</span></div>
  ${dropped}
</header>
${verdictHtml}
<section class="transcript">
  <h2>Transcript</h2>
  <p class="muted">Debaters saw each other, and the judges saw them, only as "Debater A/B/C", shuffled each battle. Real names are shown here.</p>
  ${rounds}
</section>
<footer>Made with <strong>battler</strong>: AI subscriptions debating each other.</footer>
</main>
</body>
</html>
`;
}

const CSS = `
:root{--bg:#f6f5f2;--card:#fff;--ink:#1d1d1f;--muted:#6e6e73;--line:#e4e2dc;--soft:#f0eee9;--green:#1f8a5b;--amber:#b7791f;--red:#c0392b;
  font-family:ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color-scheme:light dark}
@media (prefers-color-scheme:dark){:root{--bg:#141416;--card:#1d1d20;--ink:#ececef;--muted:#9a9aa2;--line:#2e2e33;--soft:#26262b;--green:#4cc38a;--amber:#e0a44a;--red:#ef6f5e}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);line-height:1.55;font-size:16px}
main{max-width:1080px;margin:0 auto;padding:40px 20px 64px}
h1{font-size:clamp(26px,4vw,38px);line-height:1.15;margin:6px 0 14px;letter-spacing:-.02em}
h2{font-size:15px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin:0 0 14px}
h3{font-size:16px;margin:0 0 8px}
p{margin:0 0 10px}
.muted{color:var(--muted)}
.brand{font-weight:700;color:var(--muted);font-size:14px;letter-spacing:.02em}
.meta{display:flex;flex-wrap:wrap;gap:8px;align-items:center;font-size:14px}
.chip{border:1.5px solid var(--c);color:var(--c);border-radius:999px;padding:1px 10px;font-weight:600;font-size:13px}
.card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:22px 24px;margin:18px 0}
.eyebrow{display:flex;justify-content:space-between;align-items:center;font-weight:700;margin-bottom:12px}
.pill{font-size:12px;font-weight:600;border-radius:999px;padding:2px 10px;background:var(--soft)}
.pill.strong{color:var(--green)}.pill.partial{color:var(--amber)}.pill.split{color:var(--red)}
.verdict .answer{font-size:clamp(17px,2.2vw,20px);line-height:1.5}
.winner{display:flex;gap:16px;align-items:flex-start}
.winner h2{text-transform:none;letter-spacing:0;font-size:20px;color:var(--ink);margin:0 0 6px}
.winner .muted{font-weight:400;font-size:15px}
.star{font-size:26px;color:var(--amber);line-height:1}
.who{color:var(--c);font-weight:600}
.two{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:18px}
.two .card{margin:0}
section.two{margin:18px 0}
.checks{list-style:none;padding:0;margin:0}
.checks li{padding-left:24px;position:relative;margin-bottom:8px}
.checks li::before{content:"✓";position:absolute;left:0;color:var(--green);font-weight:700}
.dispute{margin-bottom:14px}.dispute:last-child{margin-bottom:0}
.dispute p{margin:0 0 6px;padding-left:12px;border-left:3px solid var(--line)}
.side{font-weight:600;margin-right:4px}
.score-row{padding:14px 0;border-top:1px solid var(--line)}
.score-row:first-of-type{border-top:0;padding-top:0}
.score-head{display:grid;grid-template-columns:minmax(80px,max-content) 1fr 44px;gap:14px;align-items:center}
.name{font-weight:700;color:var(--c)}
.bar{height:10px;background:var(--soft);border-radius:999px;overflow:hidden}
.bar span{display:block;height:100%;border-radius:999px}
.num{font-weight:700;text-align:right;font-variant-numeric:tabular-nums}
.score-body{margin-top:8px;font-size:15px}
.score-body p{margin:0 0 4px}
.plus span,.minus span{display:inline-block;width:16px;font-weight:700}
.plus span{color:var(--green)}.minus span{color:var(--red)}
.criteria{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:4px 18px;margin-top:8px;font-size:13px;color:var(--muted)}
.criteria span{display:grid;grid-template-columns:86px 1fr 26px;align-items:center;gap:8px}
.criteria i{font-style:normal}
.criteria b{height:6px;border-radius:999px;background:linear-gradient(90deg,var(--c) var(--w),var(--soft) var(--w))}
.criteria em{font-style:normal;text-align:right;font-variant-numeric:tabular-nums}
.note{font-size:13px;color:var(--muted);margin:12px 0 0}
.dropped{color:var(--red);font-size:14px}
.transcript{margin-top:36px}
.round{margin:12px 0}
.round summary{cursor:pointer;font-weight:600;padding:8px 0;list-style-position:outside}
.round summary span{color:var(--muted);font-weight:500;margin-right:6px}
.turns{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:14px;margin-top:8px}
.turn{background:var(--card);border:1px solid var(--line);border-top:3px solid var(--c);border-radius:12px;padding:16px 18px;font-size:14.5px;min-width:0}
.turn header{display:flex;justify-content:space-between;margin-bottom:6px}
.md h3,.md h4,.md h5,.md h6{font-size:13px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);margin:14px 0 6px}
.md ul,.md ol{padding-left:20px;margin:0 0 10px}
.md li{margin-bottom:4px}
.md code{background:var(--soft);border-radius:4px;padding:1px 5px;font-size:.92em}
.md pre{background:var(--soft);border-radius:8px;padding:10px 12px;overflow:auto}
.md pre code{background:none;padding:0}
.md blockquote{margin:0 0 10px;padding-left:12px;border-left:3px solid var(--line);color:var(--muted)}
.md a{color:inherit}
.table{overflow-x:auto;margin-bottom:10px}
table{border-collapse:collapse;font-size:13.5px}
th,td{border:1px solid var(--line);padding:4px 8px;text-align:left;vertical-align:top}
footer{margin-top:48px;text-align:center;color:var(--muted);font-size:13px}
@media (max-width:600px){main{padding:24px 16px 48px}.card{padding:18px}.score-head{grid-template-columns:minmax(64px,max-content) 1fr 40px}}
`;
