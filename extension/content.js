// battler content script: runs inside chatgpt.com, claude.ai and grok.com tabs and does what a
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
      replies: ["[data-message-author-role='assistant']"],
      replyBody: [".markdown", ".prose"],
      loggedOut: ["[data-testid='login-button']", "a[href*='auth/login']", "button[data-testid='welcome-login-button']"],
    },
    "claude.ai": {
      composer: ["div.ProseMirror[contenteditable='true']", "[contenteditable='true'][aria-label*='prompt' i]", "fieldset [contenteditable='true']"],
      send: ["button[aria-label='Send message']", "button[aria-label*='Send' i]"],
      stop: ["button[aria-label='Stop response']", "button[aria-label*='Stop' i]"],
      replies: ["[data-is-streaming]", ".font-claude-response", "[data-testid='assistant-message']"],
      replyBody: [".font-claude-response", ".prose", ":scope"],
      streamingAttr: "data-is-streaming",
      loggedOut: ["a[href='/login']", "button[data-testid='login-with-google']"],
    },
    "grok.com": {
      composer: ["textarea[aria-label*='Grok' i]", "div.ProseMirror[contenteditable='true']", "form textarea", "textarea"],
      send: ["button[type='submit'][aria-label*='Submit' i]", "button[aria-label*='Send' i]", "form button[type='submit']"],
      stop: ["button[aria-label*='Stop' i]"],
      replies: ["[data-testid='assistant-message']", ".message-bubble:not(.user)", "[class*='message-bubble']"],
      replyBody: [".response-content-markdown", ".prose", ":scope"],
      loggedOut: ["a[href*='sign-in']", "a[href*='login']"],
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
    const loggedOut = !composer && Boolean(first(driver.loggedOut));
    return { ready: Boolean(composer), loggedIn: !loggedOut, url: location.href };
  }

  /** Put text into the site's composer the way a paste would, so its editor state updates. */
  function insert(el, text) {
    el.focus();
    if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value").set;
      setter.call(el, text);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      return;
    }
    // Rich editors (ProseMirror, Lexical) handle paste events best.
    const data = new DataTransfer();
    data.setData("text/plain", text);
    const pasted = el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
    if (pasted && !el.textContent.trim()) document.execCommand("insertText", false, text);
    if (!el.textContent.trim()) document.execCommand("insertText", false, text);
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

  async function ask(prompt, progress) {
    const composer = await waitFor(() => first(driver.composer), { timeout: 30_000, what: "the message box" });
    const before = all(driver.replies).length;
    insert(composer, prompt);
    await sleep(300);

    const send = await waitFor(() => {
      const b = first(driver.send);
      return b && !b.disabled && b.getAttribute("aria-disabled") !== "true" ? b : null;
    }, { timeout: 10_000, what: "the send button" }).catch(() => null);
    if (send) send.click();
    else composer.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true }));

    // Wait for the new reply to appear, then for it to stop changing.
    const reply = await waitFor(() => {
      const replies = all(driver.replies);
      return replies.length > before ? replies.at(-1) : null;
    }, { timeout: 90_000, what: "the reply to start" });

    let last = "";
    let stableSince = Date.now();
    const deadline = Date.now() + 8 * 60_000;
    for (;;) {
      await sleep(600);
      const current = all(driver.replies).at(-1) ?? reply;
      const text = replyText(current);
      if (text !== last) {
        last = text;
        stableSince = Date.now();
        progress(text.length);
      }
      if (!generating(current) && text && Date.now() - stableSince > 2500) return text;
      if (Date.now() > deadline) throw new Error("the reply took longer than 8 minutes");
    }
  }

  /* ── HTML → Markdown, for what these sites render ─────────────────────── */
  function toMarkdown(root) {
    const out = [];
    const inline = (node) => {
      if (node.nodeType === Node.TEXT_NODE) return node.textContent.replace(/\s+/g, " ");
      if (node.nodeType !== Node.ELEMENT_NODE) return "";
      const tag = node.tagName.toLowerCase();
      if (["button", "svg", "style", "script"].includes(tag)) return "";
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
      try {
        const text = await ask(msg.prompt, (chars) => port.postMessage({ type: "progress", chars }));
        port.postMessage({ type: "done", text });
      } catch (e) {
        port.postMessage({ type: "error", error: e.message, status: status() });
      } finally {
        busy = false;
      }
    });
  });
})();
