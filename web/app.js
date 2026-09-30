// battler web UI. Plain JavaScript, no build step. Talks to `battler serve` on the same origin.

const $ = (sel, el = document) => el.querySelector(sel);
const view = $("#view");
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// LAN mode: the access token comes in the URL once, then lives in this tab's session.
const params = new URLSearchParams(location.search);
if (params.get("t")) sessionStorage.setItem("battler-token", params.get("t"));
const token = sessionStorage.getItem("battler-token");

async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(path, {
    method,
    headers: {
      "x-battler": "1",
      ...(body ? { "content-type": "application/json" } : {}),
      ...(token ? { "x-battler-token": token } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

const LENGTHS = [
  { value: "short", title: "Quick", hint: "About 1 min · an answer and a winner" },
  { value: "medium", title: "Standard", hint: "2–3 min · the full verdict" },
  { value: "long", title: "Deep", hint: "5+ min · every angle, in depth" },
];
const EXAMPLES = [
  "Is a hot dog a sandwich?",
  "Should I learn Python or JavaScript first?",
  "Rent or buy a home in 2026?",
  "Is remote work better for junior engineers?",
];
const PLACEHOLDERS = [
  "Ask anything… e.g. Should our team use microservices?",
  "Ask anything… e.g. Is it worth learning Rust if I know Go?",
  "Ask anything… e.g. 现在开留学机构做 AI 方向可行吗？",
];

const state = {
  status: null,
  battles: [],
  draft: { topic: "", selected: null, length: null, rounds: null, judge: null, judgeTouched: false },
  stream: null,
  timer: null,
};

/* ── Toast ─────────────────────────────────────────────── */
let toastTimer;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 3500);
}

/* ── Status (which AIs are ready) ──────────────────────── */
async function loadStatus(refresh = false) {
  try {
    state.status = await api(`/api/status${refresh ? "?refresh=1" : ""}`);
  } catch (e) {
    $("#status-text").textContent = "Can't reach battler";
    return;
  }
  const { agents, canBattle } = state.status;
  const ready = agents.filter((a) => a.ready);
  $("#status-dots").innerHTML = agents
    .map((a) => `<span class="${a.ready ? "" : "off"}" style="--c:${a.color}" title="${esc(a.name)}"></span>`)
    .join("");
  $("#status-text").textContent = canBattle ? `${ready.length} of ${agents.length} AIs ready` : "Set up your AIs";
  const cursorReady = agents.some((a) => a.id === "grok" && a.ready);
  $("#status-pop").innerHTML = `
    <h3>Your AIs</h3>
    ${agents
      .map((a) => {
        const sub = a.ready
          ? `Ready${a.model ? ` · ${esc(a.model)} (Cursor's ${esc(a.allowance)} allowance)` : ""}`
          : esc(a.problem);
        return `<div class="ai-row ${a.ready ? "" : "off"}" style="--c:${a.color}"><span class="dot"></span><span class="ai-name">${esc(a.name)}</span><span class="ai-sub">${sub}</span></div>`;
      })
      .join("")}
    <p class="hint">${
      ready.length === agents.length
        ? "Everything's set. Battles run on your subscriptions, never API keys."
        : `${cursorReady ? "Cursor can stand in for a missing one. " : ""}To install or log in, run <code class="cmd">battler setup</code> in a terminal, then <button class="btn" id="recheck" style="padding:3px 10px;font-size:13px">check again</button>`
    }</p>`;
  $("#recheck")?.addEventListener("click", async () => {
    $("#status-text").textContent = "Checking…";
    await loadStatus(true);
    route();
  });
}

$("#status-btn").addEventListener("click", () => {
  const pop = $("#status-pop");
  pop.hidden = !pop.hidden;
  $("#status-btn").setAttribute("aria-expanded", String(!pop.hidden));
});
document.addEventListener("click", (e) => {
  if (!e.target.closest("#status-pop, #status-btn")) {
    $("#status-pop").hidden = true;
    $("#status-btn").setAttribute("aria-expanded", "false");
  }
});

/* ── History sidebar ───────────────────────────────────── */
function timeAgo(iso) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d ago`;
  return new Date(iso).toLocaleDateString();
}

async function loadHistory() {
  try {
    state.battles = (await api("/api/battles")).battles;
  } catch {
    state.battles = [];
  }
  renderHistory();
}

function renderHistory() {
  const current = location.hash.match(/^#\/b\/(.+)$/)?.[1];
  $("#history").innerHTML = state.battles.length
    ? state.battles
        .map((b) => {
          const winner = b.debaters.find((d) => d.name === b.winner);
          return `<a href="#/b/${encodeURIComponent(b.id)}" ${decodeURIComponent(current ?? "") === b.id ? 'aria-current="page"' : ""}>
            <span class="h-topic">${b.followUpOf ? '<span class="h-follow">↳</span>' : ""}${esc(b.topic)}</span>
            <span class="h-meta">${timeAgo(b.createdAt)}${
              winner ? ` · <span class="dot" style="--c:${winner.color}"></span> ${esc(winner.name)} won` : b.headline ? ` · ${esc(b.headline)}` : ""
            }</span>
          </a>`;
        })
        .join("")
    : `<p class="history-empty">Your battles will show up here. Each one is saved, so you can come back and ask a follow-up.</p>`;
}

// Mobile drawer
const openSidebar = (open) => {
  $("#sidebar").classList.toggle("open", open);
  $("#scrim").hidden = !open;
};
$("#open-sidebar").addEventListener("click", () => openSidebar(true));
$("#close-sidebar").addEventListener("click", () => openSidebar(false));
$("#scrim").addEventListener("click", () => openSidebar(false));
$("#history").addEventListener("click", () => openSidebar(false));

/* ── New battle ────────────────────────────────────────── */
function lineupFor(status) {
  // What each AI would be in a battle: itself, a Cursor stand-in, or unavailable.
  const cursorReady = status.agents.some((a) => a.id === "grok" && a.ready);
  // Only Claude and GPT have Cursor stand-ins (the status says which via standInSpec).
  return status.agents.map((a) => ({
    ...a,
    usable: a.ready || (cursorReady && Boolean(a.standInSpec)),
    via: !a.ready && cursorReady && a.standInSpec ? "Cursor" : null,
  }));
}

function renderNew() {
  stopStream();
  const status = state.status;
  const d = state.draft;
  d.length ??= status?.defaults.length ?? "medium";
  d.rounds ??= status?.defaults.rounds ?? 2;
  const lineup = status ? lineupFor(status) : [];
  d.selected ??= new Set(lineup.filter((a) => a.usable).map((a) => a.id));
  if (!d.judgeTouched) d.judge = d.length === "short" ? "one" : "panel";
  const placeholder = PLACEHOLDERS[Math.floor(Math.random() * PLACEHOLDERS.length)];

  view.innerHTML = `
    <section class="hero">
      <h1>What should your AIs debate?</h1>
      <p>Claude, GPT and Grok each answer on their own, argue with each other, then judge each other blind. It all runs on the subscriptions you already have: no API keys.</p>
    </section>

    ${
      status && !status.canBattle
        ? `<section class="card setup-card">
            <h2>Let's get your AIs ready first</h2>
            <p class="muted">battler needs at least two of these signed in, or just Cursor on its own.</p>
            <ol>
              <li>Open a terminal and run <code class="cmd">battler setup</code>. It installs and logs in to what's missing, asking before each step.</li>
              <li>Come back and <button class="btn" id="setup-recheck" style="padding:3px 10px;font-size:13px">check again</button></li>
            </ol>
          </section>`
        : ""
    }

    <form class="composer" id="new-form">
      <label for="topic" class="sr-only" hidden>Topic</label>
      <textarea id="topic" rows="3" placeholder="${esc(placeholder)}" maxlength="2000">${esc(d.topic)}</textarea>
      <div class="composer-bar">
        <span class="cost" id="cost"></span>
        <span class="grow"></span>
        <button class="btn primary" id="start" type="submit">Start battle <span class="kbd">⌘↵</span></button>
      </div>
    </form>
    <div class="examples" aria-label="Examples">
      ${EXAMPLES.map((e) => `<button type="button" data-example="${esc(e)}">${esc(e)}</button>`).join("")}
    </div>

    <section class="options" aria-label="Battle options">
      <div>
        <div class="opt-label">Debaters <small>· tap to include or leave out</small></div>
        <div class="debaters" id="debaters">
          ${lineup
            .map(
              (a) => `<button type="button" class="toggle" style="--c:${a.color}" data-id="${a.id}" aria-pressed="${d.selected.has(a.id)}"
                ${a.usable ? "" : "disabled"} title="${esc(a.usable ? (a.via ? `Runs through Cursor (its ${a.id === "claude" ? "Claude" : "GPT"} model)` : "Ready") : a.problem)}">
                <span class="dot"></span>${esc(a.name)}${a.via ? ` <small class="muted">via Cursor</small>` : ""}</button>`,
            )
            .join("")}
        </div>
      </div>
      <div>
        <div class="opt-label">Length</div>
        <div class="segmented" role="radiogroup" aria-label="Length" id="lengths">
          ${LENGTHS.map(
            (l) => `<button type="button" role="radio" data-length="${l.value}" aria-checked="${d.length === l.value}"><strong>${l.title}</strong><span>${l.hint}</span></button>`,
          ).join("")}
        </div>
      </div>
      <details class="more">
        <summary>More options</summary>
        <div class="more-grid">
          <div>
            <div class="opt-label">Rounds <small>· including the opening</small></div>
            <div class="stepper"><button type="button" data-step="-1" aria-label="Fewer rounds">−</button><output id="rounds">${d.rounds}</output><button type="button" data-step="1" aria-label="More rounds">+</button></div>
            <p class="muted" style="font-size:13px;margin:8px 0 0">2–3 is usually best. They tend to agree by round 3.</p>
          </div>
          <div>
            <div class="opt-label">Judging</div>
            <label class="radio"><input type="radio" name="judge" value="panel" ${d.judge === "panel" ? "checked" : ""}><span>Panel <small>Every AI scores the others; nobody scores itself. Fairest.</small></span></label>
            <label class="radio"><input type="radio" name="judge" value="one" ${d.judge === "one" ? "checked" : ""}><span>One judge <small>Faster and uses less of your plans.</small></span></label>
          </div>
        </div>
      </details>
    </section>

    <section class="how" aria-label="How it works">
      <div><b>1</b><h3>Answer alone</h3><p>Each AI answers without seeing the others.</p></div>
      <div><b>2</b><h3>Argue</h3><p>They read each other's answers, push back, and change their minds where they should.</p></div>
      <div><b>3</b><h3>Judge blind</h3><p>They score each other as "Debater A, B, C" on accuracy, reasoning, engagement and honesty.</p></div>
    </section>`;

  const topicEl = $("#topic");
  // Grow with the text (the empty box keeps its CSS height; placeholders can inflate scrollHeight).
  const autosize = () => {
    topicEl.style.height = "";
    if (topicEl.value) topicEl.style.height = `${Math.min(Math.max(topicEl.scrollHeight, 96), 320)}px`;
  };
  topicEl.addEventListener("input", () => {
    d.topic = topicEl.value;
    autosize();
    updateCost();
  });
  topicEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      start();
    }
  });
  requestAnimationFrame(autosize);
  if (!matchMedia("(max-width: 860px)").matches) topicEl.focus();

  view.querySelectorAll("[data-example]").forEach((b) =>
    b.addEventListener("click", () => {
      topicEl.value = d.topic = b.dataset.example;
      autosize();
      updateCost();
      topicEl.focus();
    }),
  );
  $("#debaters").addEventListener("click", (e) => {
    const b = e.target.closest("[data-id]");
    if (!b || b.disabled) return;
    d.selected.has(b.dataset.id) ? d.selected.delete(b.dataset.id) : d.selected.add(b.dataset.id);
    b.setAttribute("aria-pressed", String(d.selected.has(b.dataset.id)));
    updateCost();
  });
  $("#lengths").addEventListener("click", (e) => {
    const b = e.target.closest("[data-length]");
    if (!b) return;
    d.length = b.dataset.length;
    view.querySelectorAll("[data-length]").forEach((x) => x.setAttribute("aria-checked", String(x === b)));
    if (!d.judgeTouched) {
      d.judge = d.length === "short" ? "one" : "panel";
      view.querySelector(`input[name=judge][value=${d.judge}]`).checked = true;
    }
    updateCost();
  });
  view.querySelectorAll("[data-step]").forEach((b) =>
    b.addEventListener("click", () => {
      d.rounds = Math.max(1, Math.min(5, d.rounds + Number(b.dataset.step)));
      $("#rounds").value = $("#rounds").textContent = d.rounds;
      updateCost();
    }),
  );
  view.querySelectorAll("input[name=judge]").forEach((r) =>
    r.addEventListener("change", () => {
      d.judge = r.value;
      d.judgeTouched = true;
      updateCost();
    }),
  );
  $("#new-form").addEventListener("submit", (e) => {
    e.preventDefault();
    start();
  });
  $("#setup-recheck")?.addEventListener("click", async () => {
    await loadStatus(true);
    renderNew();
  });

  function updateCost() {
    const n = d.selected.size;
    const calls = n * d.rounds + (d.judge === "panel" ? n : 1);
    $("#cost").textContent = n < 2 ? "Pick at least 2 debaters" : `About ${calls} AI calls on your plans`;
    $("#start").disabled = n < 2 || !d.topic.trim() || (status && !status.canBattle);
  }
  updateCost();

  async function start() {
    if ($("#start").disabled) return;
    const chosen = lineupFor(state.status).filter((a) => d.selected.has(a.id));
    const allUsable = lineupFor(state.status).filter((a) => a.usable).length === chosen.length;
    const specs = chosen.map((a) => (a.via ? a.standInSpec : a.id));
    const lead = chosen[0];
    $("#start").disabled = true;
    $("#start").textContent = "Starting…";
    try {
      const { jobId } = await api("/api/battles", {
        method: "POST",
        body: {
          topic: d.topic.trim(),
          length: d.length,
          rounds: d.rounds,
          // Everyone usable selected: let the server pick the lineup (it knows about stand-ins).
          agents: allUsable ? undefined : specs,
          judge: d.judge === "panel" ? "panel" : lead.via ? specs[0] : lead.id,
        },
      });
      d.topic = "";
      location.hash = `#/live/${jobId}`;
    } catch (err) {
      toast(err.message);
      $("#start").disabled = false;
      $("#start").innerHTML = 'Start battle <span class="kbd">⌘↵</span>';
    }
  }
}

/* ── Live battle ───────────────────────────────────────── */
function stopStream() {
  state.stream?.close();
  state.stream = null;
  clearInterval(state.timer);
  state.timer = null;
  $(".followbar")?.remove();
}

const fmtSecs = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
};

function headHtml({ topic, followUpOf, debaters, meta, back = true }) {
  return `<header class="battle-head">
    ${back ? '<a class="back" href="#/">← New battle</a>' : ""}
    ${followUpOf ? `<p class="muted followup">↳ Follow-up to: ${esc(followUpOf)}</p>` : ""}
    <h1>${esc(topic)}</h1>
    <div class="meta">${debaters.map((x) => `<span class="chip" style="--c:${x.color}">${esc(x.name)}</span>`).join("")}<span class="muted">${esc(meta)}</span></div>
  </header>`;
}

function renderLive(jobId) {
  stopStream();
  view.innerHTML = `<div class="battle-head"><a class="back" href="#/">← New battle</a><p class="thinking" style="margin-top:24px"><span class="thinking-dots" style="--c:var(--muted)"><i></i><i></i><i></i></span> Connecting…</p></div>`;
  let plan = null;
  const colorOf = (name) => plan?.debaters.find((x) => x.name === name)?.color ?? "#8a8f98";
  const pending = new Map(); // "round:name" -> start time

  const url = `/api/jobs/${jobId}/events${token ? `?t=${encodeURIComponent(token)}` : ""}`;
  const es = new EventSource(url);
  state.stream = es;
  state.timer = setInterval(() => {
    for (const el of view.querySelectorAll("[data-since]")) el.textContent = fmtSecs(Date.now() - Number(el.dataset.since));
  }, 250);

  const setStep = (key) => {
    const items = [...view.querySelectorAll(".timeline li")];
    const i = items.findIndex((li) => li.dataset.step === key);
    items.forEach((li, j) => {
      li.classList.toggle("done", i >= 0 && j < i);
      li.classList.toggle("active", j === i);
    });
  };

  es.onmessage = (msg) => {
    const e = JSON.parse(msg.data);
    switch (e.type) {
      case "plan": {
        plan = e;
        const judged = e.judges.length > 1 ? `judged by a panel of ${e.judges.length}` : `judged by ${e.judges[0]}`;
        const lengthName = LENGTHS.find((l) => l.value === e.length)?.title ?? e.length;
        const steps = [];
        for (let r = e.firstRound; r <= e.totalRounds; r++) steps.push([`r${r}`, r === 1 ? "Opening" : `Round ${r}`]);
        steps.push(["verdict", "Verdict"]);
        view.innerHTML = `
          ${headHtml({ topic: e.topic, followUpOf: e.followUpOf, debaters: e.debaters, meta: `${lengthName} · ${e.totalRounds} round${e.totalRounds > 1 ? "s" : ""} · ${judged}` })}
          ${e.notes.length ? `<div class="notes">${e.notes.map((n) => `<p class="${/allowance|Skipping|isn't ready/.test(n) ? "warn" : ""}">${esc(n)}</p>`).join("")}</div>` : ""}
          <ol class="timeline" aria-label="Progress">${steps.map(([k, label], i) => `<li data-step="${k}"><span class="num">${i + 1}</span>${label}</li>`).join("")}</ol>
          <div id="verdict-slot"></div>
          <div id="rounds"></div>
          <p style="margin-top:28px"><button class="btn danger" id="cancel">Stop this battle</button></p>`;
        $("#cancel").addEventListener("click", async () => {
          $("#cancel").disabled = true;
          await api(`/api/jobs/${jobId}/cancel`, { method: "POST" }).catch(() => {});
        });
        break;
      }
      case "round-start": {
        setStep(`r${e.round}`);
        const sec = document.createElement("section");
        sec.className = "round-live fade-in";
        sec.id = `round-${e.round}`;
        sec.innerHTML = `<h2>${e.round === 1 ? "Round 1 · Opening statements" : `Round ${e.round} · Rebuttals and revisions`}</h2>
          <div class="turns">${e.agents
            .map((name) => {
              pending.set(`${e.round}:${name}`, e.at);
              return `<article class="turn pending" style="--c:${colorOf(name)}" data-name="${esc(name)}">
                <header><span class="name">${esc(name)}</span><span class="muted" data-since="${e.at}">0s</span></header>
                <div class="md"><div class="thinking"><span class="thinking-dots" style="--c:${colorOf(name)}"><i></i><i></i><i></i></span>${e.round === 1 ? "Thinking it through…" : "Reading the others and replying…"}</div>
                <div class="shimmer" aria-hidden="true"><span></span><span></span><span></span></div></div>
              </article>`;
            })
            .join("")}</div>`;
        $("#rounds").prepend(sec);
        break;
      }
      case "turn-done": {
        const card = $(`#round-${e.round} [data-name="${CSS.escape(e.agentName)}"]`);
        if (!card) break;
        const tmp = document.createElement("div");
        tmp.innerHTML = e.html;
        const fresh = tmp.firstElementChild;
        fresh.classList.add("fade-in");
        const md = $(".md", fresh);
        md.classList.add("clamp");
        const more = document.createElement("button");
        more.className = "expand";
        more.textContent = "Read the full answer";
        more.addEventListener("click", () => {
          const open = md.classList.toggle("clamp");
          more.textContent = open ? "Read the full answer" : "Show less";
        });
        fresh.append(more);
        card.replaceWith(fresh);
        requestAnimationFrame(() => {
          if (md.scrollHeight <= 262) {
            md.classList.remove("clamp");
            more.remove();
          }
        });
        break;
      }
      case "retry": {
        const card = typeof e.round === "number" ? $(`#round-${e.round} [data-name="${CSS.escape(e.agentName)}"]`) : null;
        const note = card && $(".thinking", card);
        if (note) note.lastChild.textContent = "Hit a hiccup, trying again…";
        break;
      }
      case "turn-failed": {
        const card = $(`#round-${e.round} [data-name="${CSS.escape(e.agentName)}"]`);
        if (!card) break;
        card.classList.remove("pending");
        card.classList.add("failed");
        $(".md", card).innerHTML = `<p><strong>Couldn't answer, so it sits out the rest.</strong></p><p>${esc(e.error.split("\n")[0])}</p>`;
        $("[data-since]", card)?.removeAttribute("data-since");
        break;
      }
      case "judge-start": {
        setStep("verdict");
        $("#verdict-slot").innerHTML = `<section class="card judging fade-in" id="judging">
          <span class="thinking-dots" style="--c:var(--ink)"><i></i><i></i><i></i></span>
          <div><strong>${e.judges.length > 1 ? "The judges are scoring the debate" : `${esc(e.judges[0])} is judging the debate`}</strong>
          <div class="muted" style="font-size:13.5px">They see everyone only as "Debater A, B, C". <span data-since="${e.at}">0s</span></div>
          <div class="chips" style="margin-top:8px">${e.judges.map((j) => `<span class="judge-chip" style="--c:${colorOf(j)}" data-judge="${esc(j)}">${esc(j)}</span>`).join("")}</div></div>
        </section>`;
        break;
      }
      case "judge-done":
      case "judge-failed": {
        const chip = $(`[data-judge="${CSS.escape(e.judgeName)}"]`);
        chip?.classList.add(e.type === "judge-done" && e.ok ? "done" : "failed");
        break;
      }
      case "done": {
        view.querySelectorAll(".timeline li").forEach((li) => {
          li.classList.add("done");
          li.classList.remove("active");
        });
        $("#cancel")?.parentElement.remove();
        $("#verdict-slot").innerHTML = `<div class="fade-in">${e.battle.verdictHtml}</div>`;
        const rounds = $("#rounds");
        rounds.insertAdjacentHTML("beforebegin", '<h2 style="margin-top:36px">Transcript</h2>');
        // Oldest round first once it's all in.
        [...rounds.children].reverse().forEach((c) => rounds.append(c));
        if (e.warning) toast(e.warning);
        history.replaceState(null, "", `#/b/${encodeURIComponent(e.battle.id)}`);
        followBar(e.battle);
        loadHistory();
        $("#verdict-slot").scrollIntoView({ behavior: "smooth", block: "start" });
        break;
      }
      case "error": {
        $("#cancel")?.parentElement.remove();
        $("#judging")?.remove();
        $("#verdict-slot").innerHTML = `<section class="card error-card fade-in">
          <h2 style="color:var(--red)">${e.message === "Stopped." ? "Battle stopped" : "The battle couldn't finish"}</h2>
          <pre>${esc(e.message)}</pre>
          <p style="margin-top:14px;display:flex;gap:8px;flex-wrap:wrap">
            ${e.savedId ? '<button class="btn primary" id="finish">Judge the rounds so far</button>' : ""}
            <a class="btn" href="#/">Start a new battle</a></p>
        </section>`;
        if (e.savedId) $("#finish").addEventListener("click", () => finishBattle(e.savedId));
        loadHistory();
        break;
      }
      case "end":
        es.close();
        clearInterval(state.timer);
        break;
    }
  };
  es.onerror = () => {
    if (es.readyState === EventSource.CLOSED) return;
    toast("Lost connection to battler. Is `battler serve` still running?");
    es.close();
  };
}

/* ── Saved battle ──────────────────────────────────────── */
async function renderSaved(id) {
  stopStream();
  view.innerHTML = `<div class="battle-head"><a class="back" href="#/">← New battle</a></div>`;
  let b;
  try {
    b = await api(`/api/battles/${encodeURIComponent(id)}`);
  } catch (e) {
    view.innerHTML = `<div class="battle-head"><a class="back" href="#/">← New battle</a><h1>Battle not found</h1><p class="muted">${esc(e.message)}</p></div>`;
    return;
  }
  const lengthName = LENGTHS.find((l) => l.value === b.length)?.title ?? b.length;
  const judged = b.judges.length > 1 ? `judged by a panel of ${b.judges.length}` : `judged by ${b.judges[0]}`;
  const verdictPart = b.incomplete
    ? `<section class="card error-card fade-in"><h2>This battle stopped before the verdict</h2>
        <p class="muted">Its ${b.rounds} round${b.rounds === 1 ? " is" : "s are"} saved below. The judges can score them now.</p>
        <p style="margin-top:12px"><button class="btn primary" id="finish">Judge it now</button></p></section>`
    : `<div class="fade-in">${b.verdictHtml}</div>`;
  view.innerHTML = `
    ${headHtml({ topic: b.topic, followUpOf: b.followUpOf, debaters: b.debaters, meta: `${lengthName} · ${b.rounds} round${b.rounds > 1 ? "s" : ""}${b.incomplete ? "" : ` · ${judged}`} · ${timeAgo(b.createdAt)}` })}
    ${verdictPart}
    <section class="transcript"><h2>Transcript</h2>${b.roundsHtml}</section>`;
  $("#finish")?.addEventListener("click", () => finishBattle(b.id));
  followBar(b);
  renderHistory();
}

/** Judge a battle that stopped before its verdict (no new rounds). */
async function finishBattle(id) {
  try {
    const { jobId } = await api("/api/battles", { method: "POST", body: { continueFrom: id, more: true } });
    location.hash = `#/live/${jobId}`;
  } catch (e) {
    toast(e.message);
  }
}

/* ── Follow-up bar ─────────────────────────────────────── */
function followBar(battle) {
  $(".followbar")?.remove();
  const bar = document.createElement("div");
  bar.className = "followbar";
  bar.innerHTML = `<form class="followbar-inner">
      <input id="follow" placeholder="Ask a follow-up… they'll build on this debate" maxlength="2000" autocomplete="off">
      <button class="btn primary" type="submit">Ask</button>
      <button class="btn" type="button" id="more" title="Another round on the same question">+1 <span class="label-long">round</span></button>
      <a class="btn" href="${battle.reportUrl}${token ? `?t=${encodeURIComponent(token)}` : ""}" target="_blank" rel="noopener" title="Open the full report">↗ <span class="label-long">Report</span></a>
    </form>`;
  document.body.append(bar);
  const go = async (body) => {
    bar.querySelectorAll("button").forEach((b) => (b.disabled = true));
    try {
      const { jobId } = await api("/api/battles", { method: "POST", body: { continueFrom: battle.id, ...body } });
      location.hash = `#/live/${jobId}`;
    } catch (e) {
      toast(e.message);
      bar.querySelectorAll("button").forEach((b) => (b.disabled = false));
    }
  };
  $("form", bar).addEventListener("submit", (e) => {
    e.preventDefault();
    const q = $("#follow", bar).value.trim();
    if (q) go({ question: q });
    else $("#follow", bar).focus();
  });
  $("#more", bar).addEventListener("click", () => go({ more: true }));
}

/* ── Routing ───────────────────────────────────────────── */
function route() {
  const h = location.hash;
  let m;
  if ((m = h.match(/^#\/live\/([a-f0-9]+)$/))) renderLive(m[1]);
  else if ((m = h.match(/^#\/b\/(.+)$/))) renderSaved(decodeURIComponent(m[1]));
  else renderNew();
  renderHistory();
  view.focus({ preventScroll: true });
  window.scrollTo(0, 0);
}
window.addEventListener("hashchange", route);

await Promise.all([loadStatus(), loadHistory()]);
route();
