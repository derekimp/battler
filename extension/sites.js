// The chat sites battler can drive. `newChat` opens a fresh conversation, in each site's
// temporary / incognito mode where it has one, so battles don't fill your history or get
// shaped by the site's memory of you.
export const SITES = [
  {
    id: "claude",
    name: "Claude",
    color: "#d97757",
    home: "https://claude.ai/",
    newChat: "https://claude.ai/new?incognito",
    match: "https://claude.ai/*",
  },
  {
    id: "chatgpt",
    name: "ChatGPT",
    color: "#1fa67a",
    home: "https://chatgpt.com/",
    newChat: "https://chatgpt.com/?temporary-chat=true",
    match: "https://chatgpt.com/*",
  },
  {
    id: "grok",
    name: "Grok",
    color: "#5b8def",
    home: "https://grok.com/",
    newChat: "https://grok.com/?private",
    match: "https://grok.com/*",
  },
];

export const siteById = (id) => SITES.find((s) => s.id === id);
