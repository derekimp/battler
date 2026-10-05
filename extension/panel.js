// battler side panel: set up a battle, run it with the shared engine against your own tabs
// (or copy & paste), and show progress, the verdict and history.
import { runBattle } from "./lib/core/battle.js";
import { attachmentFrom, fetchSharedChat, findShareLinks } from "./lib/core/links.js";
import { finalPositions, savedAnswer, savedToResult, toIncomplete, toSaved } from "./lib/core/saved-core.js";
import { namedVerdict } from "./lib/core/verdict.js";
import { htmlColor, renderRoundsHtml, renderTurnHtml, renderVerdictHtml } from "./lib/ui/html-report.js";
import { escapeHtml as esc } from "./lib/ui/markdown.js";
import { manualAgent, siteStatuses, tabAgent } from "./agents.js";
import { SITES, siteById } from "./sites.js";

const $ = (sel, el = document) => el.querySelector(sel);
const view = $("#view");

const LENGTHS = [
  { value: "short", title: "Quick", hint: "~1 min" },
  { value: "medium", title: "Standard", hint: "2–3 min" },
  { value: "long", title: "Deep", hint: "5+ min" },
];
const EXAMPLES = ["Is a hot dog a sandwich?", "Python or JavaScript first?", "Rent or buy a home in 2026?"];
const HISTORY_LIMIT = 50;

const prefs = { selected: new Set(SITES.map((s) => s.id)), mode: "auto", length: "medium", rounds: 2, topic: "" };
const ROUNDS = [
  { value: 1, title: "1 round", hint: "answers only, then judged" },
  { value: 2, title: "2 rounds", hint: "one rebuttal (best value)" },
  { value: 3, title: "3 rounds", hint: "two rebuttals, in depth" },
];
let statuses = {};
let running = null; // { controller }

/* ── Storage ───────────────────────────────────────────────────────────── */
async function loadPrefs() {
  const { prefs: p } = await chrome.storage.local.get("prefs");
  if (p) Object.assign(prefs, p, { selected: new Set(p.selected ?? SITES.map((s) => s.id)) });
}
const savePrefs = () =>
  chrome.storage.local.set({ prefs: { selected: [...prefs.selected], mode: prefs.mode, length: prefs.length, rounds: prefs.rounds } });

async function history() {
  const { battles = [] } = await chrome.storage.local.get("battles");
  return battles;
}
/** Save (or update) a battle in history. Pass the id from an earlier save to replace it. */
async function saveBattle(saved, id = `${Date.now()}`) {
  const rest = (await history()).filter((b) => b.id !== id);
  await chrome.storage.local.set({ battles: [{ id, saved }, ...rest].slice(0, HISTORY_LIMIT) });
  return id;
}

/* ── Small helpers ─────────────────────────────────────────────────────── */
let toastTimer;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 3500);
}
function setTab(which) {
  for (const t of ["new", "history"]) {
    if (t === which) $(`#tab-${t}`).setAttribute("aria-current", "page");
    else $(`#tab-${t}`).removeAttribute("aria-current");
  }
}
const timeAgo = (iso) => {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(iso).toLocaleDateString();
};
function removeFollowBar() {
  $(".followbar")?.remove();
}

/* ── New battle ────────────────────────────────────────────────────────── */
function siteLine(site) {
  const s = statuses[site.id];
  if (prefs.mode === "manual") return { cls: "", text: "You'll copy & paste" };
  if (!s) return { cls: "", text: "Checking…" };
  if (s.ready) return { cls: "ok", text: "Signed in" };
  if (s.loggedIn === false) return { cls: "bad", text: "Sign in first", action: "Open" };
  if (!s.open) return { cls: "", text: "Opens a tab when needed", action: "Open" };
  return { cls: "bad", text: "Couldn't read the page", action: "Open" };
}

function renderNew() {
  if (running) return renderRunningNotice();
  setTab("new");
  removeFollowBar();
  view.innerHTML = `
    <h1 class="title">What should they debate?</h1>
    <p class="lede">ChatGPT, Claude and Grok answer in your own tabs, argue, then judge each other blind.</p>
    <form class="composer" id="form">
      <textarea id="topic" placeholder="Ask anything…" maxlength="2000">${esc(prefs.topic)}</textarea>
    </form>
    <div class="examples">${EXAMPLES.map((e) => `<button type="button" data-ex="${esc(e)}">${esc(e)}</button>`).join("")}</div>

    <div class="section">
      <div class="label">Debaters <button type="button" id="recheck">Check again</button></div>
      <div id="sites">${SITES.map((site) => {
        const line = siteLine(site);
        return `<label class="site" style="--c:${site.color}">
          <input type="checkbox" data-site="${site.id}" ${prefs.selected.has(site.id) ? "checked" : ""}>
          <span><span class="nm"><span class="dot"></span>${esc(site.name)}${site.via ? ` <small class="muted">via ${esc(site.via)}</small>` : ""}</span><span class="st ${line.cls}">${esc(line.text)}</span></span>
          ${line.action ? `<button type="button" class="open" data-open="${site.id}">${line.action}</button>` : "<span></span>"}
        </label>`;
      }).join("")}</div>
    </div>

    <div class="section">
      <div class="label">How battler talks to them</div>
      <div class="seg" role="radiogroup" id="mode">
        <button type="button" role="radio" data-mode="auto" aria-checked="${prefs.mode === "auto"}"><b>Automatic</b>types in the tabs for you</button>
        <button type="button" role="radio" data-mode="manual" aria-checked="${prefs.mode === "manual"}"><b>Copy &amp; paste</b>you carry the messages</button>
      </div>
      <p class="help">${
        prefs.mode === "auto"
          ? "battler works in its own background tabs, tucked into a collapsed “battler” group, and uses temporary chats, so your history stays clean. If a site changes and automatic stops working, switch to copy &amp; paste."
          : "battler shows each message to send; you paste it into the site and paste the reply back. Slower, but works even when a site changes."
      }</p>
    </div>

    <div class="section">
      <div class="label">Length</div>
      <div class="seg" role="radiogroup" id="lengths">${LENGTHS.map(
        (l) => `<button type="button" role="radio" data-length="${l.value}" aria-checked="${prefs.length === l.value}"><b>${l.title}</b>${l.hint}</button>`,
      ).join("")}</div>
    </div>

    <div class="section">
      <div class="label">Rounds</div>
      <div class="seg" role="radiogroup" id="rounds-pick">${ROUNDS.map(
        (r) => `<button type="button" role="radio" data-rounds="${r.value}" aria-checked="${prefs.rounds === r.value}"><b>${r.title}</b>${r.hint}</button>`,
      ).join("")}</div>
    </div>

    <div class="startbar">
      <button class="btn primary block" id="start">Start battle <span class="kbd">⌘↵</span></button>
      <p class="fine" id="cost"></p>
    </div>`;

  const topic = $("#topic");
  topic.focus();
  topic.addEventListener("input", () => {
    prefs.topic = topic.value;
    update();
  });
  topic.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) start();
  });
  view.querySelectorAll("[data-ex]").forEach((b) =>
    b.addEventListener("click", () => {
      topic.value = prefs.topic = b.dataset.ex;
      update();
    }),
  );
  view.querySelectorAll("[data-site]").forEach((c) =>
    c.addEventListener("change", () => {
      c.checked ? prefs.selected.add(c.dataset.site) : prefs.selected.delete(c.dataset.site);
      savePrefs();
      update();
    }),
  );
  view.querySelectorAll("[data-open]").forEach((b) =>
    b.addEventListener("click", async (e) => {
      e.preventDefault();
      const site = siteById(b.dataset.open);
      await chrome.tabs.create({ url: site.home, active: true });
    }),
  );
  $("#recheck").addEventListener("click", refreshStatuses);
  $("#mode").addEventListener("click", (e) => {
    const b = e.target.closest("[data-mode]");
    if (!b) return;
    prefs.mode = b.dataset.mode;
    savePrefs();
    renderNew();
  });
  $("#lengths").addEventListener("click", (e) => {
    const b = e.target.closest("[data-length]");
    if (!b) return;
    prefs.length = b.dataset.length;
    view.querySelectorAll("[data-length]").forEach((x) => x.setAttribute("aria-checked", String(x === b)));
    savePrefs();
    update();
  });
  $("#rounds-pick").addEventListener("click", (e) => {
    const b = e.target.closest("[data-rounds]");
    if (!b) return;
    prefs.rounds = Number(b.dataset.rounds);
    view.querySelectorAll("[data-rounds]").forEach((x) => x.setAttribute("aria-checked", String(x === b)));
    savePrefs();
    update();
  });
  $("#start").addEventListener("click", start);

  function update() {
    const n = prefs.selected.size;
    const calls = n * prefs.rounds + (prefs.length === "short" ? 1 : n);
    $("#cost").textContent =
      n < 2 ? "Pick at least 2 debaters." : `About ${calls} messages across your accounts. Keep this panel open while it runs.`;
    $("#start").disabled = n < 2 || !prefs.topic.trim();
  }
  update();

  function start() {
    if ($("#start").disabled) return;
    const topicText = prefs.topic.trim();
    prefs.topic = "";
    runLive({ topic: topicText, siteIds: SITES.filter((s) => prefs.selected.has(s.id)).map((s) => s.id), length: prefs.length, rounds: prefs.rounds });
  }
}

async function refreshStatuses() {
  if (prefs.mode === "manual") return;
  statuses = await siteStatuses();
  if (!running && $("#sites")) renderNew();
}

function renderRunningNotice() {
  toast("A battle is running. Stop it or let it finish first.");
}

/* ── Running a battle ──────────────────────────────────────────────────── */
function makeAgents(siteIds, mode) {
  return siteIds.map((id) => {
    const site = siteById(id);
    return mode === "manual" ? manualAgent(site, requestFromUser) : tabAgent(site, { onProgress });
  });
}

/** Judges: every debater for Standard/Deep (lead: Claude, then ChatGPT, then Grok); one for Quick. */
function pickJudges(agents, length) {
  const order = ["claude", "chatgpt", "grok"];
  const sorted = [...agents].sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  return length === "short" ? [sorted[0]] : sorted;
}

let pendingManual = new Map(); // key -> { site, prompt, resolve }

/** Copy & paste mode: show a "your turn" card and wait for the pasted reply. */
function requestFromUser(site, prompt) {
  return new Promise((resolve) => {
    const key = `${site.id}:${Date.now()}`;
    pendingManual.set(key, { site, prompt, resolve });
    renderManual(key);
  });
}

function renderManual(key) {
  const req = pendingManual.get(key);
  if (!req) return;
  // Put it in the debater's pending card if there is one, otherwise in the judging area.
  const host = view.querySelector(`.turn.pending[data-site="${req.site.id}"] .md`) ?? $("#manual-slot");
  if (!host) return;
  const box = document.createElement("div");
  box.className = "manual";
  box.style.setProperty("--c", req.site.color);
  box.innerHTML = `
    <p><strong>Your turn:</strong> send this to ${esc(req.site.name)} (a new or temporary chat is best), then paste its full reply below.</p>
    <div class="row">
      <button class="btn small" data-copy>Copy message</button>
      <button class="btn small" data-go>Open ${esc(req.site.name)} ↗</button>
    </div>
    <textarea placeholder="Paste ${esc(req.site.name)}'s reply here"></textarea>
    <div class="row" style="margin:8px 0 0"><button class="btn small primary" data-done disabled>Use this reply</button></div>`;
  host.append(box);
  const ta = $("textarea", box);
  $("[data-copy]", box).addEventListener("click", async () => {
    await navigator.clipboard.writeText(req.prompt);
    toast("Copied. Paste it into " + req.site.name + ".");
  });
  $("[data-go]", box).addEventListener("click", () => chrome.tabs.create({ url: req.site.newChat, active: true }));
  ta.addEventListener("input", () => ($("[data-done]", box).disabled = !ta.value.trim()));
  $("[data-done]", box).addEventListener("click", () => {
    pendingManual.delete(key);
    box.remove();
    req.resolve(ta.value.trim());
  });
}

function onProgress(siteId, chars) {
  const el = view.querySelector(`.turn.pending[data-site="${siteId}"] [data-chars]`);
  if (el) el.textContent = chars ? ` · ${chars.toLocaleString()} characters so far` : "";
}

/**
 * Run a battle and render it live. `continueFrom` (a saved battle) with `question` makes it a
 * follow-up; with `more` it adds a round to the same debate.
 */
async function runLive({ topic, siteIds, length, rounds, continueFrom, question, more }) {
  removeFollowBar();
  setTab("new");
  const agents = makeAgents(siteIds, prefs.mode);
  const judges = pickJudges(agents, length);
  const controller = new AbortController();
  running = { controller };
  // Judging an interrupted battle completes that same entry rather than adding another.
  const battleId = more && continueFrom?.saved.incomplete ? continueFrom.id : `${Date.now()}`;
  pendingManual = new Map();
  const colorOf = (name) => siteById(agents.find((a) => a.name === name)?.id)?.color ?? htmlColor(name);

  const followUpOf = continueFrom ? (more ? continueFrom.saved.followUpOf : continueFrom.saved.topic) : undefined;
  const resume = more ? continueFrom.saved.rounds : undefined;
  const firstRound = (resume?.length ?? 0) + 1;
  const total = (resume?.length ?? 0) + rounds;
  const steps = [];
  for (let r = firstRound; r <= total; r++) steps.push(`<span data-step="r${r}">${r === 1 ? "Opening" : `Round ${r}`}</span>`);
  steps.push('<span data-step="verdict">Verdict</span>');

  view.innerHTML = `
    <div class="head">
      <button class="back" id="leave">← New battle</button>
      ${followUpOf ? `<p class="muted followup">↳ Follow-up to: ${esc(followUpOf)}</p>` : ""}
      <h1>${esc(topic)}</h1>
      <div id="attached"></div>
      <div class="chips">${agents.map((a) => `<span class="chip" style="--c:${colorOf(a.name)}">${esc(a.name)}</span>`).join("")}
        <span class="muted">${LENGTHS.find((l) => l.value === length).title} · ${prefs.mode === "manual" ? "copy & paste" : "automatic"}</span></div>
      <div class="steps">${steps.join("")}</div>
    </div>
    <div id="verdict-slot"></div>
    <div id="manual-slot"></div>
    <div id="rounds"></div>
    <p><button class="btn small" id="stop" style="color:var(--red)">Stop</button></p>`;

  const setStep = (key) => {
    const items = [...view.querySelectorAll(".steps span")];
    const i = items.findIndex((s) => s.dataset.step === key);
    items.forEach((s, j) => {
      s.classList.toggle("done", j < i);
      s.classList.toggle("active", j === i);
    });
  };
  $("#stop").addEventListener("click", () => controller.abort());
  $("#leave").addEventListener("click", () => {
    if (!running || confirm("Stop this battle?")) {
      controller.abort();
      running = null;
      renderNew();
    }
  });

  // The AIs can't open links (temporary chats, no browsing asked for), so read shared ChatGPT
  // chats here and give everyone the text. A follow-up keeps the earlier battle's.
  const attachments = [...(continueFrom?.saved.attachments ?? [])];
  const showAttached = () =>
    ($("#attached").innerHTML = attachments
      .map((a) => `<p class="muted followup">📎 They read your shared ChatGPT chat “${esc(a.title)}” · ${a.messages} messages</p>`)
      .join(""));
  showAttached();
  for (const url of more ? [] : findShareLinks(question ?? topic).slice(0, 3)) {
    $("#attached").insertAdjacentHTML("beforeend", `<p class="muted followup" id="reading">Reading your shared ChatGPT chat…</p>`);
    try {
      attachments.push(attachmentFrom(await fetchSharedChat(url)));
      showAttached();
    } catch (e) {
      running = null;
      $("#verdict-slot").innerHTML = `<section class="card error-card"><h2>Couldn't read the shared chat</h2><p class="muted">${esc(e.message)}. Paste the parts that matter into the question instead.</p></section>`;
      $("#reading")?.remove();
      $("#stop")?.remove();
      return;
    }
    if (controller.signal.aborted) return;
  }

  let names = new Map();
  const onEvent = (e) => {
    switch (e.type) {
      case "start":
        names = e.names;
        break;
      case "round-done":
        // Keep the rounds so far, so closing the panel or a failure doesn't lose them.
        saveBattle(
          toIncomplete({ topic, length, rounds: e.history, labels: e.labels, followUpOf: followUpOf ?? undefined, attachments }, agents),
          battleId,
        ).catch(() => {});
        break;
      case "retry": {
        const agent = agents.find((a) => a.name === e.agentName);
        const note = agent && view.querySelector(`#round-${e.round} .turn.pending[data-site="${agent.id}"] .thinking`);
        if (note) note.childNodes[1].textContent = "Hit a hiccup, trying again";
        break;
      }
      case "round-start": {
        setStep(`r${e.round}`);
        const sec = document.createElement("section");
        sec.className = "round fade-in";
        sec.id = `round-${e.round}`;
        sec.innerHTML = `<h2>${e.round === 1 ? "Round 1 · Opening" : `Round ${e.round} · Rebuttals`}</h2><div class="turns">${e.agents
          .map((name) => {
            const agent = agents.find((a) => a.name === name);
            return `<article class="turn pending" data-site="${agent.id}" style="--c:${colorOf(name)}">
              <header><span class="name">${esc(name)}</span><span class="muted" data-since="${Date.now()}">0s</span></header>
              <div class="md"><div class="thinking"><span class="dots" style="--c:${colorOf(name)}"><i></i><i></i><i></i></span>${
                prefs.mode === "manual" ? "Waiting for you" : "Writing"
              }<span data-chars></span></div></div></article>`;
          })
          .join("")}</div>`;
        $("#rounds").prepend(sec);
        break;
      }
      case "turn-done": {
        const card = view.querySelector(`#round-${e.turn.round} .turn[data-site="${agents.find((a) => a.name === e.turn.agentName).id}"]`);
        if (!card) break;
        const tmp = document.createElement("div");
        tmp.innerHTML = renderTurnHtml(e.turn, names);
        const fresh = tmp.firstElementChild;
        fresh.classList.add("fade-in");
        const md = $(".md", fresh);
        md.classList.add("clamp");
        const more = document.createElement("button");
        more.className = "expand";
        more.textContent = "Read all";
        more.addEventListener("click", () => {
          const clamped = md.classList.toggle("clamp");
          more.textContent = clamped ? "Read all" : "Show less";
        });
        fresh.append(more);
        card.replaceWith(fresh);
        requestAnimationFrame(() => {
          if (md.scrollHeight <= 192) {
            md.classList.remove("clamp");
            more.remove();
          }
        });
        break;
      }
      case "turn-failed": {
        const agent = agents.find((a) => a.name === e.agentName);
        const card = view.querySelector(`#round-${e.round} .turn[data-site="${agent.id}"]`);
        if (!card) break;
        card.classList.remove("pending");
        card.classList.add("failed");
        $(".md", card).innerHTML = `<p><strong>Couldn't answer, so it sits out the rest.</strong></p><p>${esc(e.error)}</p>`;
        $("[data-since]", card)?.removeAttribute("data-since");
        break;
      }
      case "judge-start":
        setStep("verdict");
        $("#verdict-slot").innerHTML = `<section class="card judging fade-in" id="judging">
          <span class="dots" style="--c:var(--ink)"><i></i><i></i><i></i></span>
          <div><strong>${e.judges.length > 1 ? "Judging (they see only “Debater A, B, C”)" : `${esc(e.judges[0])} is judging`}</strong>
          <div class="chips" style="margin-top:6px">${e.judges.map((j) => `<span class="judge" style="--c:${colorOf(j)}" data-judge="${esc(j)}">${esc(j)}</span>`).join("")}</div></div>
        </section>`;
        break;
      case "judge-done":
      case "judge-failed":
        view.querySelector(`[data-judge="${CSS.escape(e.judgeName)}"]`)?.classList.add(e.type === "judge-done" && e.ok ? "done" : "failed");
        break;
    }
  };

  const tick = setInterval(() => {
    for (const el of view.querySelectorAll("[data-since]")) el.textContent = `${Math.round((Date.now() - Number(el.dataset.since)) / 1000)}s`;
  }, 500);

  try {
    const result = await runBattle({
      topic,
      agents,
      judges,
      rounds,
      length,
      signal: controller.signal,
      onEvent,
      ...(attachments.length ? { attachments } : {}),
      ...(continueFrom ? { labels: new Map(continueFrom.saved.labels) } : {}),
      ...(resume ? { resume } : {}),
      ...(continueFrom && !more
        ? { followUp: { topic: continueFrom.saved.topic, answer: savedAnswer(continueFrom.saved), finals: finalPositions(continueFrom.saved) } }
        : {}),
    });
    if (more && continueFrom.saved.followUpOf) result.followUpOf = continueFrom.saved.followUpOf;
    const saved = toSaved(result, agents);
    const id = await saveBattle(saved, battleId);
    running = null;
    showSaved({ id, saved }, { fresh: true });
  } catch (err) {
    running = null;
    $("#judging")?.remove();
    $("#stop")?.parentElement.remove();
    $("#verdict-slot").innerHTML = `<section class="card error-card fade-in">
      <h2 style="color:var(--red)">${controller.signal.aborted ? "Battle stopped" : "The battle couldn't finish"}</h2>
      <pre>${esc(err.message)}</pre>
      <p style="margin:12px 0 0;display:flex;gap:6px">
        <button class="btn small primary" id="judge-saved" hidden>Judge the rounds so far</button>
        <button class="btn small" id="again">Back to start</button></p></section>`;
    $("#again").addEventListener("click", renderNew);
    const partial = (await history()).find((b) => b.id === battleId);
    if (partial?.saved.incomplete && partial.saved.rounds.length) {
      $("#judge-saved").hidden = false;
      $("#judge-saved").addEventListener("click", () => judgeNow(partial));
    }
  } finally {
    clearInterval(tick);
  }
}

/* ── A finished battle ─────────────────────────────────────────────────── */
function showSaved(entry, { fresh = false } = {}) {
  removeFollowBar();
  const { saved } = entry;
  const result = savedToResult(saved);
  const v = namedVerdict(result);
  setTab(fresh ? "new" : "history");
  view.innerHTML = `
    <div class="head">
      <button class="back" id="leave">← New battle</button>
      ${saved.followUpOf ? `<p class="muted followup">↳ Follow-up to: ${esc(saved.followUpOf)}</p>` : ""}
      <h1>${esc(saved.topic)}</h1>
      <div class="chips">${saved.agents.map((a) => `<span class="chip" style="--c:${siteById(a.id)?.color ?? htmlColor(a.name)}">${esc(a.name)}</span>`).join("")}
        <span class="muted">${saved.rounds.length} rounds · ${timeAgo(saved.createdAt)}</span></div>
    </div>
    ${
      saved.incomplete
        ? `<section class="card error-card fade-in"><h2>Stopped before the verdict</h2><p class="muted">Its ${saved.rounds.length} round${saved.rounds.length === 1 ? " is" : "s are"} saved below.</p><p style="margin:10px 0 0"><button class="btn small primary" id="judge-saved">Judge it now</button></p></section>`
        : `<div class="fade-in">${renderVerdictHtml(result)}</div>`
    }
    <section class="transcript"><h2>Transcript</h2>${renderRoundsHtml(result)}</section>`;
  $("#leave").addEventListener("click", renderNew);
  $("#judge-saved")?.addEventListener("click", () => judgeNow(entry));

  const bar = document.createElement("div");
  bar.className = "followbar";
  bar.innerHTML = `<form><input placeholder="Ask a follow-up…" maxlength="2000"><button class="btn small primary" type="submit">Ask</button><button class="btn small" type="button" data-more title="Another round">+1</button></form>`;
  document.body.append(bar);
  const siteIds = saved.agents.map((a) => a.id).filter((id) => siteById(id));
  $("form", bar).addEventListener("submit", (e) => {
    e.preventDefault();
    const q = $("input", bar).value.trim();
    if (!q) return;
    runLive({ topic: q, siteIds, length: saved.length, rounds: prefs.rounds, continueFrom: entry, question: q });
  });
  $("[data-more]", bar).addEventListener("click", () =>
    runLive({ topic: saved.topic, siteIds, length: saved.length, rounds: 1, continueFrom: entry, more: true }),
  );
  if (fresh && v) view.scrollTo?.(0, 0);
}

/** Judge a battle that stopped before its verdict, without new rounds. */
function judgeNow(entry) {
  const siteIds = entry.saved.agents.map((a) => a.id).filter((id) => siteById(id));
  runLive({ topic: entry.saved.topic, siteIds, length: entry.saved.length, rounds: 0, continueFrom: entry, more: true });
}

// Closing the panel stops a running battle; rounds finished so far are already in History.
window.addEventListener("beforeunload", (e) => {
  if (running) e.preventDefault();
});

/* ── History ───────────────────────────────────────────────────────────── */
async function renderHistory() {
  if (running) return renderRunningNotice();
  setTab("history");
  removeFollowBar();
  const battles = await history();
  view.innerHTML = battles.length
    ? `<div class="hist" style="margin-top:12px">${battles
        .map((b, i) => {
          const v = namedVerdict(savedToResult(b.saved));
          const w = v && v.winner.debater !== "Tie" ? v.winner.debater : null;
          const color = w ? siteById(b.saved.agents.find((a) => a.name === w)?.id)?.color ?? htmlColor(w) : null;
          return `<button class="item" data-i="${i}"><span class="t">${b.saved.followUpOf ? "↳ " : ""}${esc(b.saved.topic)}</span>
            <span class="m">${timeAgo(b.saved.createdAt)}${b.saved.incomplete ? " · interrupted" : w ? ` · <span class="dot" style="--c:${color}"></span>${esc(w)} won` : ""}</span></button>`;
        })
        .join("")}</div>`
    : `<p class="empty">No battles yet. Each one is saved here, so you can come back and ask a follow-up.</p>`;
  view.querySelectorAll("[data-i]").forEach((b) => b.addEventListener("click", () => showSaved(battles[Number(b.dataset.i)])));
}

/* ── Start ─────────────────────────────────────────────────────────────── */
$("#home").addEventListener("click", renderNew);
$("#tab-new").addEventListener("click", renderNew);
$("#tab-history").addEventListener("click", renderHistory);

try {
  await loadPrefs();
  renderNew();
  view.dataset.started = "1";
  refreshStatuses().catch((e) => toast(`Couldn't check the sites: ${e.message}`));
} catch (e) {
  view.innerHTML = `<section class="card error-card" style="margin-top:14px"><h2 style="color:var(--red)">battler couldn't start</h2><pre>${esc(e.stack ?? e.message)}</pre></section>`;
  view.dataset.started = "1";
}
