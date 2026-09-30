/**
 * A small, dependency-free Markdown → HTML renderer for debate turns. It covers what models
 * actually write (headings, lists, emphasis, code, tables, quotes, links) and escapes
 * everything else, so model output can never inject HTML into the report.
 */

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function inlineHtml(text: string): string {
  const codes: string[] = [];
  let s = text.replace(/`([^`]+)`/g, (_, c: string) => `\u0000${codes.push(c) - 1}\u0000`);
  s = escapeHtml(s)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/__(.+?)__/g, "<strong>$1</strong>")
    .replace(/(^|[^*\w])\*(?!\s)(.+?)(?<!\s)\*(?!\w)/g, "$1<em>$2</em>")
    .replace(/(^|[^_\w])_(?!\s)(.+?)(?<!\s)_(?!\w)/g, "$1<em>$2</em>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" rel="noopener noreferrer">$1</a>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i: string) => `<code>${escapeHtml(codes[Number(i)])}</code>`);
}

const isTableRow = (l: string) => /^\s*\|.*\|\s*$/.test(l);
const cells = (l: string) => l.trim().replace(/^\||\|$/g, "").split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));

export function markdownToHtml(md: string): string {
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    const fence = line.match(/^\s*(```|~~~)/);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence[1])) body.push(lines[i++]);
      i++;
      out.push(`<pre><code>${escapeHtml(body.join("\n"))}</code></pre>`);
      continue;
    }
    const heading = line.match(/^\s*(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (heading) {
      // Debate turns use ## for their sections; keep them below the report's own headings.
      const level = Math.min(6, heading[1].length + 2);
      out.push(`<h${level}>${inlineHtml(heading[2])}</h${level}>`);
      i++;
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      out.push("<hr>");
      i++;
      continue;
    }
    if (/^\s*>/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) body.push(lines[i++].replace(/^\s*>\s?/, ""));
      out.push(`<blockquote>${markdownToHtml(body.join("\n"))}</blockquote>`);
      continue;
    }
    if (isTableRow(line) && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1]) && lines[i + 1].includes("-")) {
      const head = cells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && isTableRow(lines[i])) rows.push(cells(lines[i++]));
      out.push(
        `<div class="table"><table><thead><tr>${head.map((h) => `<th>${inlineHtml(h)}</th>`).join("")}</tr></thead><tbody>` +
          rows.map((r) => `<tr>${r.map((c) => `<td>${inlineHtml(c)}</td>`).join("")}</tr>`).join("") +
          "</tbody></table></div>",
      );
      continue;
    }
    const listItem = /^\s*([-*+]|\d+[.)])\s+/;
    if (listItem.test(line)) {
      const ordered = /^\s*\d/.test(line);
      const start = ordered ? parseInt(line.trim(), 10) : 1;
      const sameKind = (l: string) => listItem.test(l) && !/^\s{2,}/.test(l) && /^\s*\d/.test(l) === ordered;
      const items: string[] = [];
      while (i < lines.length) {
        const l = lines[i];
        if (sameKind(l)) items.push(l.replace(listItem, ""));
        else if (/^\s{2,}\S/.test(l) && items.length) items[items.length - 1] += "\n" + l.replace(/^\s{2,}([-*+]|\d+[.)])\s+/, "• ").trim();
        else if (!l.trim()) {
          // Models often put blank lines between items; the list continues if the next item follows.
          let j = i;
          while (j < lines.length && !lines[j].trim()) j++;
          if (j < lines.length && sameKind(lines[j])) {
            i = j;
            continue;
          }
          break;
        } else break;
        i++;
      }
      const tag = ordered ? "ol" : "ul";
      const startAttr = ordered && start !== 1 ? ` start="${start}"` : "";
      out.push(`<${tag}${startAttr}>${items.map((it) => `<li>${it.split("\n").map(inlineHtml).join("<br>")}</li>`).join("")}</${tag}>`);
      continue;
    }
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^\s*(#{1,6}\s|```|~~~|>|([-*+]|\d+[.)])\s)/.test(lines[i]) &&
      !isTableRow(lines[i])
    ) {
      para.push(lines[i++].trim());
    }
    if (!para.length) para.push(lines[i++].trim());
    out.push(`<p>${inlineHtml(para.join(" "))}</p>`);
  }
  return out.join("\n");
}
