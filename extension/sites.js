// The chat sites battler can drive. `newChat` opens a fresh conversation, in each site's
// temporary / incognito mode where it has one, so battles don't fill your history or get
// shaped by the site's memory of you. `model` is picked in the site's model menu first.
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
    // Gemini 3.1 Pro, in a temporary chat (turned on with its toggle; there's no URL for it).
    id: "gemini",
    name: "Gemini",
    color: "#9b72f2",
    home: "https://gemini.google.com/app",
    newChat: "https://gemini.google.com/app",
    match: "https://gemini.google.com/*",
    model: "3.1 Pro",
  },
  {
    // Grok runs through Cursor's web agents, on the Cursor subscription. Grok 4.6 is Cursor's own
    // Grok, billed to the roomier "Cursor Models" allowance. There's no temporary-chat mode, so
    // each turn appears in your Cursor chat list.
    id: "grok",
    name: "Grok",
    color: "#5b8def",
    home: "https://cursor.com/agents",
    newChat: "https://cursor.com/agents",
    match: "https://cursor.com/*",
    model: "grok-4.6",
    via: "Cursor",
  },
];

export const siteById = (id) => SITES.find((s) => s.id === id);
