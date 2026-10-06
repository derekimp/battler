// battler content script: runs inside chatgpt.com, claude.ai, gemini.google.com and cursor.com/agents tabs and does what a
// person would do: type the prompt, press send, wait for the reply to finish, and read it back.
// It only acts when the battler side panel asks it to, one message at a time.
//
// These sites change their markup often, so every step tries several selectors, and the side
// panel falls back to copy-and-paste mode when a site can't be driven.

(() => {
  if (window.__battler) return; // injected once per page
  window.__battler = true;

  /** Per-site selectors. Each list is tried in order; the first match wins. */
  const DRIVERS = {
    "chatgpt.com": {
      composer: ["#prompt-textarea", "div.ProseMirror[contenteditable='true']", "textarea[name='prompt-textarea']", "form textarea"],
      send: ["button[data-testid='send-button']", "#composer-submit-button", "button[aria-label*='Send' i]"],
      stop: ["button[data-testid='stop-button']", "button[aria-label*='Stop' i]"],
      // Checked 2026-09-30: replies are units keyed "…:assistant"; the message itself sits in
      // [data-chatgpt-selection-message-id] (the unit also holds a hidden "ChatGPT said:").
      replies: ["[data-content-search-unit-key$=':assistant']", "[data-chatgpt-search-unit-key$=':assistant']", "[data-message-author-role='assistant']"],
      replyBody: ["[data-chatgpt-selection-message-id]", ".markdown", ".prose", ":scope"],
      loggedOut: ["[data-testid='login-button']", "button[data-testid='welcome-login-button']"],
    },
    "claude.ai": {
      // Checked 2026-09-30: composer is a tiptap/ProseMirror div; replies are
      // [data-testid=assistant-message] with data-is-streaming; the text is in .standard-markdown
      // (the message also holds a hidden "Claude responded:" and a timestamp).
      composer: ["[data-testid='chat-input'][contenteditable='true']", "div.ProseMirror[contenteditable='true']", "[contenteditable='true'][aria-label*='prompt' i]"],
      send: ["button[data-testid='chat-input-send']", "button[aria-label='Send message']", "button[aria-label*='Send' i]"],
      stop: ["button[aria-label='Stop response']", "button[aria-label*='Stop' i]"],
      replies: ["[data-testid='assistant-message']", "[data-is-streaming]"],
      replyBody: [".standard-markdown", "[data-perf-reply-text]", ".prose"],
      streamingAttr: "data-is-streaming",
      loggedOut: ["a[href='/login']", "button[data-testid='login-with-google']"],
    },
    "gemini.google.com": {
      // Checked 2026-10-02: a Quill editor (ignores synthetic paste, takes insertText; the send
      // button ignores synthetic clicks, Enter works), replies are <model-response> with the
      // answer in message-content .markdown (the hidden thoughts sit outside it), and a "Stop
      // response" button while it writes. In a background tab the text stays class="pending"
      // and invisible, so it's read with textContent. Temporary chat is a toggle, not a URL.
      composer: ["div.ql-editor[contenteditable='true']", "rich-textarea [contenteditable='true']"],
      send: [],
      sendWithEnter: true,
      // Gemini only acts on the send when the page renders a frame, which background tabs don't.
      sentCount: () => document.querySelectorAll("user-query").length,
      stop: ["button[aria-label='Stop response']"],
      replies: ["model-response"],
      replyBody: ["message-content .markdown", "message-content"],
      loggedOut: ["a[href*='accounts.google.com/ServiceLogin']", "a[aria-label^='Sign in' i]"],
      modelPicker: "button.input-area-switch",
      modelChosen: (model) => (document.querySelector("button.input-area-switch")?.getAttribute("aria-label") ?? "").includes(`currently ${model.split(" ").at(-1)}`),
      findModelItem: (model) =>
        [...document.querySelectorAll("[role='menuitem'], [role='menuitemradio'], .mat-mdc-menu-item")].find((e) => e.textContent.includes(model)) ?? null,
      async prepare() {
        // Temporary chat: not saved to your Gemini history or used to personalise it.
        const on = () => [...document.querySelectorAll("button, [role='button'], span, div")].some((e) => e.children.length === 0 && /turn off temporary chat/i.test(e.textContent));
        if (on()) return;
        const toggle = await waitFor(() => first(["button[aria-label='Temporary chat']"]), { timeout: 10_000, what: "the temporary chat button" }).catch(() => null);
        if (!toggle) throw new Error("couldn't turn on Gemini's temporary chat, so battler won't send this into your history. Use copy & paste mode");
        toggle.click();
        await waitFor(on, { timeout: 5_000, what: "temporary chat to turn on" }).catch(() => {
          throw new Error("couldn't turn on Gemini's temporary chat, so battler won't send this into your history. Use copy & paste mode");
        });
      },
    },
    "cursor.com": {
      // Checked 2026-09-30 on cursor.com/agents (Grok via Cursor): a contenteditable composer, a
      // model menu, and replies rendered in .portal-markdown-root. The Stop button stays until
      // the cloud environment finishes starting, 20-40s after the answer.
      composer: ["[contenteditable='true'].chat-input-text-base", "form [contenteditable='true']"],
      send: ["button[aria-label='Send message']", "form button[type='submit']"],
      stop: ["button[aria-label='Stop']"],
      replies: [".portal-markdown-root"],
      replyBody: [":scope"],
      loggedOut: ["a[href*='authenticator.cursor.sh']"],
      modelPicker: "[data-testid='background-composer-model-picker-trigger']",
      modelItem: (model) => `[data-testid='model-item-${model}']`,
    },
  };

  const driver = DRIVERS[location.hostname.replace(/^www\./, "")];
  if (!driver) return;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const visible = (el) => el && el.getClientRects().length > 0;
  const first = (sels, root = document) => {
    for (const s of sels) {
      const el = [...root.querySelectorAll(s)].find(visible) ?? null;
      if (el) return el;
    }
    return null;
  };
  const all = (sels) => {
    for (const s of sels) {
      const els = [...document.querySelectorAll(s)];
      if (els.length) return els;
    }
    return [];
  };

  async function waitFor(fn, { timeout, interval = 250, what }) {
    const end = Date.now() + timeout;
    for (;;) {
      const v = fn();
      if (v) return v;
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
      await sleep(interval);
    }
  }

  function status() {
    const composer = first(driver.composer);
    const byText = driver.loggedOutText && [...document.querySelectorAll("a, button")].some((e) => visible(e) && driver.loggedOutText.test(e.textContent.trim()));
    const loggedOut = Boolean(first(driver.loggedOut)) || byText;
    return { ready: Boolean(composer) && !loggedOut, loggedIn: !loggedOut, url: location.href };
  }

  const textOf = (el) => (el.value ?? el.textContent ?? "").replace(/\s+/g, "");

  /**
   * Empty the composer. Sites keep an unsent draft in it (Cursor does, across visits), which would
   * otherwise go out glued to the prompt. Rich editors keep their own state, so this selects the
   * box's contents, tells the editor, and deletes the way a key press would.
   */
  async function clear(el) {
    if (!textOf(el)) return;
    if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
      Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value").set.call(el, "");
      el.dispatchEvent(new Event("input", { bubbles: true }));
    } else {
      el.focus();
      const range = document.createRange();
      range.selectNodeContents(el);
      getSelection().removeAllRanges();
      getSelection().addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
      await sleep(80);
      el.dispatchEvent(new InputEvent("beforeinput", { inputType: "deleteContentBackward", bubbles: true, cancelable: true }));
      await sleep(150);
      if (textOf(el)) document.execCommand("delete");
      // Last resort: one character at a time, while that makes progress.
      for (let i = 0, left = textOf(el).length, stuck = 0; i < 20_000 && left && stuck < 50; i++) {
        el.dispatchEvent(new InputEvent("beforeinput", { inputType: "deleteContentBackward", bubbles: true, cancelable: true }));
        const now = textOf(el).length;
        stuck = now < left ? 0 : stuck + 1;
        left = now;
      }
      await sleep(150);
    }
    if (textOf(el)) throw new Error("couldn't clear what was already in the message box; clear it in the site's tab and try again");
  }

  /** Put text into the site's composer the way a paste would, so its editor state updates. */
  async function insert(el, text) {
    el.focus();
    await clear(el);
    if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value").set;
      setter.call(el, text);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    } else {
      // Rich editors (ProseMirror, Lexical, tiptap) handle paste events best. Some apply the paste
      // a moment later, so wait before deciding it didn't work, or the text ends up in there twice.
      const data = new DataTransfer();
      data.setData("text/plain", text);
      el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
      await sleep(350);
      if (!textOf(el)) document.execCommand("insertText", false, text);
      await sleep(100);
    }
    // The box should hold this prompt and nothing else.
    const got = textOf(el);
    const want = text.replace(/\s+/g, "");
    if (!got.startsWith(want.slice(0, 40)) || got.length > want.length * 1.05 + 20) {
      throw new Error("the message box didn't take the prompt cleanly, so it wasn't sent; try again, or use copy & paste mode");
    }
  }

  /** Pick a model in the site's model menu, if it has one and it isn't already chosen. */
  async function chooseModel(model) {
    if (!driver.modelPicker || !model) return;
    if (driver.modelChosen?.(model)) return;
    const trigger = await waitFor(() => first([driver.modelPicker]), { timeout: 15_000, what: "the model menu" });
    trigger.click();
    const findItem = () => (driver.findModelItem ? driver.findModelItem(model) : first([driver.modelItem(model)]));
    const item = await waitFor(findItem, { timeout: 5_000, what: `the model ${model}` }).catch(() => null);
    if (!item) {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      throw new Error(`${model} isn't in the model menu`);
    }
    item.click();
    await sleep(300);
    // The menu can stay open with its search box focused; close it so typing goes to the composer.
    if (driver.modelItem && visible(document.querySelector(driver.modelItem(model)))) {
      document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }));
      await sleep(200);
    }
  }

  /** The reply's content element (":scope" means the reply element itself), as Markdown. */
  const replyText = (el) => {
    const body = driver.replyBody.map((s) => (s === ":scope" ? el : el.querySelector(s))).find(Boolean) ?? el;
    return toMarkdown(body).trim();
  };

  function generating(reply) {
    if (first(driver.stop)) return true;
    if (driver.streamingAttr && reply?.closest(`[${driver.streamingAttr}]`)?.getAttribute(driver.streamingAttr) === "true") return true;
    return false;
  }

  /**
   * Background tabs don't render, and some sites only act (send, or update a streaming reply) when
   * the page renders a frame. `nudge` asks the panel to show this tab for a moment.
   */
  async function ask(prompt, progress, model, nudge = async () => {}) {
    await waitFor(() => first(driver.composer), { timeout: 30_000, what: "the message box" });
    await driver.prepare?.();
    await chooseModel(model);
    const composer = await waitFor(() => first(driver.composer), { timeout: 10_000, what: "the message box" });
    const before = all(driver.replies).length;
    const sentBefore = driver.sentCount?.() ?? 0;
    await insert(composer, prompt);
    await sleep(200);

    const send = driver.sendWithEnter
      ? null
      : await waitFor(() => {
          const b = first(driver.send);
          return b && !b.disabled && b.getAttribute("aria-disabled") !== "true" ? b : null;
        }, { timeout: 10_000, what: "the send button" }).catch(() => null);
    if (send) send.click();
    else composer.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true }));
    if (driver.sentCount) {
      for (let tries = 0; tries < 3 && driver.sentCount() <= sentBefore; tries++) {
        await sleep(1500);
        if (driver.sentCount() <= sentBefore) await nudge();
      }
    }

    // Wait for the new reply to appear, then for it to stop changing.
    const reply = await waitFor(() => {
      const replies = all(driver.replies);
      return replies.length > before ? replies.at(-1) : null;
    }, { timeout: 90_000, what: "the reply to start" }).catch(() => {
      throw new Error("timed out waiting for the reply to start. The message may not have been sent; if this keeps happening, switch to copy & paste mode");
    });

    let last = "";
    let stableSince = Date.now();
    let beat = Date.now();
    let nudged = 0;
    let lastNudge = Date.now();
    const deadline = Date.now() + 8 * 60_000;
    for (;;) {
      await sleep(600);
      const current = all(driver.replies).at(-1) ?? reply;
      const text = replyText(current);
      if (text !== last) {
        last = text;
        stableSince = Date.now();
        progress(text.length);
        beat = Date.now();
      } else if (Date.now() - beat > 10_000) {
        // A heartbeat, so the panel can tell a slow reply from a tab Chrome has paused.
        progress(text.length);
        beat = Date.now();
      }
      const stable = Date.now() - stableSince;
      // Still "writing" but nothing new for a while: the page may be waiting to render.
      if (generating(current) && stable > 25_000 && Date.now() - lastNudge > 25_000 && nudged < 4) {
        nudged++;
        lastNudge = Date.now();
        await nudge();
      }
      // Normally: done when the site says so. Some sites keep a Stop button up long after the
      // text is final (Cursor while its cloud environment starts), so also accept 45s of silence.
      if (text && ((!generating(current) && stable > 2500) || stable > 45_000)) return checked(text);
      if (Date.now() > deadline) throw new Error("the reply took longer than 8 minutes");
    }
  }

  /**
   * Sites sometimes answer with their own notice (a usage limit, "something went wrong") in place
   * of the model's reply. Those are short; don't let them into the debate as an argument.
   */
  const SITE_NOTICE = /(reached|hit|exceeded) (?:your|our|the)? ?(?:usage |message |daily |hourly )?(?:limit|cap)|usage limit|rate limit|too many requests|something went wrong|an error occurred|network error|try again later|upgrade (?:to|your plan)|unusual activity|verify you are human/i;
  function checked(text) {
    if (text.length < 500 && SITE_NOTICE.test(text)) {
      throw new Error(`the site showed a notice instead of an answer: "${text.replace(/\s+/g, " ").slice(0, 160)}"`);
    }
    return text;
  }

  /* ── HTML → Markdown, for what these sites render ─────────────────────── */
  function toMarkdown(root) {
    const out = [];
    const inline = (node) => {
      if (node.nodeType === Node.TEXT_NODE) return node.textContent.replace(/\s+/g, " ");
      if (node.nodeType !== Node.ELEMENT_NODE) return "";
      const tag = node.tagName.toLowerCase();
      if (["button", "svg", "style", "script"].includes(tag) || node.classList.contains("sr-only")) return "";
      const kids = [...node.childNodes].map(inline).join("");
      if (tag === "strong" || tag === "b") return kids.trim() ? `**${kids.trim()}**` : "";
      if (tag === "em" || tag === "i") return kids.trim() ? `*${kids.trim()}*` : "";
      if (tag === "code") return "`" + node.textContent + "`";
      if (tag === "br") return "\n";
      if (tag === "a") return kids;
      return kids;
    };
    const block = (node, depth = 0) => {
      if (node.nodeType === Node.TEXT_NODE) {
        if (node.textContent.trim()) out.push(node.textContent.trim());
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      const tag = node.tagName.toLowerCase();
      if (["button", "svg", "style", "script", "nav", "form"].includes(tag)) return;
      if (node.classList.contains("sr-only")) return; // screen-reader labels like "ChatGPT said:"
      const h = tag.match(/^h([1-6])$/);
      if (h) return void out.push(`${"#".repeat(Number(h[1]))} ${inline(node).trim()}`);
      if (tag === "p") return void out.push(inline(node).trim());
      if (tag === "pre") return void out.push("```\n" + node.innerText.replace(/\n$/, "") + "\n```");
      if (tag === "blockquote") return void out.push(inline(node).trim().split("\n").map((l) => `> ${l}`).join("\n"));
      if (tag === "hr") return void out.push("---");
      if (tag === "ul" || tag === "ol") {
        let n = Number(node.getAttribute("start") ?? 1);
        const lines = [];
        for (const li of node.children) {
          if (li.tagName.toLowerCase() !== "li") continue;
          const marker = tag === "ol" ? `${n++}.` : "-";
          const own = [...li.childNodes].filter((c) => !/^(ul|ol)$/i.test(c.tagName ?? "")).map(inline).join("").trim();
          lines.push(`${"  ".repeat(depth)}${marker} ${own}`);
          for (const sub of li.querySelectorAll(":scope > ul, :scope > ol")) {
            const saved = out.length;
            block(sub, depth + 1);
            lines.push(...out.splice(saved));
          }
        }
        return void out.push(lines.join("\n"));
      }
      if (tag === "table") {
        const rows = [...node.querySelectorAll("tr")].map((tr) => [...tr.children].map((c) => inline(c).trim().replace(/\|/g, "\\|")));
        if (!rows.length) return;
        const md = [`| ${rows[0].join(" | ")} |`, `|${rows[0].map(() => "---").join("|")}|`, ...rows.slice(1).map((r) => `| ${r.join(" | ")} |`)];
        return void out.push(md.join("\n"));
      }
      for (const c of node.childNodes) block(c, depth);
    };
    block(root);
    return out.filter(Boolean).join("\n\n");
  }

  // Outside the extension (e.g. pasted into a page to test a driver), expose the steps instead.
  if (!globalThis.chrome?.runtime?.id) {
    window.__battlerDriver = { status, ask, toMarkdown, checked };
    return;
  }

  /* ── Messages from the side panel ─────────────────────────────────────── */
  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (msg?.type === "battler:status") reply(status());
  });

  let busy = false;
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== "battler:ask") return;
    port.onMessage.addListener(async (msg) => {
      if (msg?.type !== "ask") return;
      if (busy) return port.postMessage({ type: "error", error: "this tab is already answering another prompt" });
      busy = true;
      // A heartbeat for as long as this works, so the panel can tell slow from frozen.
      const alive = setInterval(() => port.postMessage({ type: "alive" }), 5_000);
      try {
        // The panel shows the tab for a moment and answers "shown".
        const nudge = () =>
          new Promise((resolve) => {
            const onShown = (m) => {
              if (m?.type !== "shown") return;
              port.onMessage.removeListener(onShown);
              resolve();
            };
            port.onMessage.addListener(onShown);
            port.postMessage({ type: "nudge" });
            setTimeout(resolve, 5_000);
          });
        const text = await ask(msg.prompt, (chars) => port.postMessage({ type: "progress", chars }), msg.model, nudge);
        port.postMessage({ type: "done", text });
      } catch (e) {
        port.postMessage({ type: "error", error: e.message, status: status() });
      } finally {
        clearInterval(alive);
        busy = false;
      }
    });
  });
})();
