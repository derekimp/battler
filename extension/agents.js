// Debaters for the battle engine (the same Agent interface the terminal uses), backed by the
// user's own browser tabs, or by the user copying and pasting.
import { SITES } from "./sites.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const withSystem = (prompt, system) => (system ? `${system}\n\n---\n\n${prompt}` : prompt);

/* ── Tabs battler owns ─────────────────────────────────────────────────── */
// battler opens its own tab per site rather than taking over a tab you're using. They sit in a
// collapsed "battler" tab group: one small label in the tab bar. They're background tabs either way,
// so collapsing doesn't change how they run.
async function ownedTab(site) {
  const key = `tab:${site.id}`;
  const { [key]: id } = await chrome.storage.session.get(key);
  if (id) {
    try {
      const tab = await chrome.tabs.get(id);
      if (tab.url && new URL(tab.url).hostname === new URL(site.home).hostname) {
        await tuckAway(tab.groupId);
        return tab;
      }
    } catch {}
  }
  const tab = await chrome.tabs.create({ url: site.home, active: false });
  await chrome.storage.session.set({ [key]: tab.id });
  try {
    const { group } = await chrome.storage.session.get("group");
    const groupId = await chrome.tabs.group({ tabIds: [tab.id], ...(group ? { groupId: group } : {}) });
    await chrome.tabGroups.update(groupId, { title: "battler", color: "grey" });
    await chrome.storage.session.set({ group: groupId });
    await tuckAway(groupId);
  } catch {
    // The group was closed: make a new one next time.
    await chrome.storage.session.remove("group");
  }
  return tab;
}

/** Collapse battler's tab group, unless you're looking at one of its tabs (Chrome won't, then). */
async function tuckAway(groupId) {
  if (!groupId || groupId < 0) return;
  try {
    await chrome.tabGroups.update(groupId, { collapsed: true });
  } catch {
    // The active tab is in the group; leave it open.
  }
}

async function waitLoaded(tabId, timeout = 30_000) {
  const end = Date.now() + timeout;
  await sleep(300);
  while (Date.now() < end) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) throw new Error("the tab was closed");
    if (tab.status === "complete") return;
    await sleep(250);
  }
  throw new Error("the page took too long to load");
}

/** Ask the tab's content script how the page looks; inject it if the tab predates the extension. */
async function status(tabId) {
  try {
    return await chrome.tabs.sendMessage(tabId, { type: "battler:status" });
  } catch {
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
      return await chrome.tabs.sendMessage(tabId, { type: "battler:status" });
    } catch {
      return null;
    }
  }
}

/** Readiness of each site, for the panel: is a tab open, is the user signed in? */
export async function siteStatuses() {
  const out = {};
  for (const site of SITES) {
    // Only tabs on the chat page itself (a Cursor dashboard tab, say, has no message box).
    const tabs = (await chrome.tabs.query({ url: site.match })).filter((t) => t.url?.startsWith(site.home));
    let s = null;
    for (const t of tabs) {
      s = await status(t.id);
      if (s) break;
    }
    out[site.id] = s ? { open: true, ...s } : { open: tabs.length > 0, ready: false, loggedIn: null };
  }
  return out;
}

/* ── Automatic: drive the site in a tab ────────────────────────────────── */
const queues = new Map();
function exclusive(key, fn) {
  const prev = queues.get(key) ?? Promise.resolve();
  const run = prev.catch(() => {}).then(fn);
  queues.set(key, run);
  return run;
}

export function tabAgent(site, { onProgress } = {}) {
  return {
    id: site.id,
    name: site.name,
    spec: site.id,
    ask(prompt, opts = {}) {
      // One prompt at a time per site; each in a fresh (temporary) chat.
      return exclusive(site.id, async () => {
        const tab = await ownedTab(site);
        await chrome.tabs.update(tab.id, { url: site.newChat });
        await waitLoaded(tab.id);
        // Signed-out visitors get redirected to a login page on another host.
        const loaded = await chrome.tabs.get(tab.id);
        if (!new URL(loaded.url).hostname.endsWith(new URL(site.home).hostname)) {
          throw new Error(`sign in to ${site.via ?? site.name} in its tab, then try again`);
        }
        const end = Date.now() + 30_000;
        let s = null;
        while (Date.now() < end) {
          s = await status(tab.id);
          if (s && (s.ready || s.loggedIn === false)) break;
          await sleep(500);
        }
        if (!s) throw new Error(`couldn't reach the ${site.name} page`);
        if (s.loggedIn === false) throw new Error(`sign in to ${site.via ?? site.name} in its tab, then try again`);
        if (!s.ready) throw new Error(`couldn't find ${site.name}'s message box; the site may have changed. Switch to copy & paste mode`);

        return new Promise((resolve, reject) => {
          const port = chrome.tabs.connect(tab.id, { name: "battler:ask" });
          const timer = setTimeout(() => {
            port.disconnect();
            reject(new Error(`${site.name} took longer than 9 minutes`));
          }, 9 * 60_000);
          const finish = (fn, v) => {
            clearTimeout(timer);
            fn(v);
          };
          port.onMessage.addListener((m) => {
            if (m.type === "progress") onProgress?.(site.id, m.chars);
            else if (m.type === "done") finish(resolve, m.text);
            else if (m.type === "error") finish(reject, new Error(`${site.name}: ${m.error}`));
          });
          port.onDisconnect.addListener(() => finish(reject, new Error(`the ${site.name} tab was closed or reloaded`)));
          port.postMessage({ type: "ask", prompt: withSystem(prompt, opts.system), model: site.model });
        });
      });
    },
    async check() {
      return null;
    },
  };
}

/* ── Copy & paste: the user carries the prompt and the reply ───────────── */
export function manualAgent(site, requestFromUser) {
  return {
    id: site.id,
    name: site.name,
    spec: site.id,
    ask(prompt, opts = {}) {
      return exclusive(`manual:${site.id}`, () => requestFromUser(site, withSystem(prompt, opts.system)));
    },
    async check() {
      return null;
    },
  };
}
