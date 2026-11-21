// Out Loud: background script.
// Injects the reader into the current tab only when the user asks (toolbar
// button, keyboard shortcut or right-click menu). No host permissions and
// nothing stored about the pages you read. Natural voices run in engine/.

// Chrome/Edge run this as a service worker and use chrome.*: newer Chrome also
// has a browser.* namespace, but its listeners don't get the offscreen page's
// messages. Firefox runs it in a background page and uses browser.*.
const api = typeof ServiceWorkerGlobalScope !== "undefined" ? globalThis.chrome : (globalThis.browser ?? globalThis.chrome);

async function start(tab, mode) {
  if (!tab || tab.id === undefined) return;
  try {
    await api.scripting.executeScript({ target: { tabId: tab.id }, files: ["reader.js"] });
    await api.tabs.sendMessage(tab.id, { type: "outloud:start", mode });
  } catch (err) {
    // Browser-internal pages (Reader View, settings, add-on stores, some PDF
    // viewers) don't allow extensions to run. Say so on the icon for this tab
    // instead of failing silently.
    console.warn("Out Loud can't read this page:", err?.message ?? err);
    const readerView = (tab.url || "").startsWith("about:reader");
    const why = readerView
      ? "Firefox doesn't let extensions read Reader View. Leave Reader View and click Out Loud again: it finds the article by itself."
      : "Your browser doesn't let extensions read this page (built-in pages, add-on stores and some PDF viewers are protected).";
    try {
      await api.action.setBadgeBackgroundColor({ tabId: tab.id, color: "#d93025" });
      await api.action.setBadgeText({ tabId: tab.id, text: "!" });
      await api.action.setTitle({ tabId: tab.id, title: `Out Loud can't read this page. ${why}` });
    } catch { /* badge is best-effort */ }
  }
}

api.action.onClicked.addListener((tab) => start(tab, "auto"));

api.runtime.onInstalled.addListener(() => {
  api.contextMenus.removeAll(() => {
    api.contextMenus.create({ id: "outloud-selection", title: "Read selection aloud", contexts: ["selection"] });
    api.contextMenus.create({ id: "outloud-page", title: "Read this page aloud", contexts: ["page"] });
  });
});

api.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "outloud-selection") start(tab, "selection");
  if (info.menuItemId === "outloud-page") start(tab, "page");
});

// Chrome/Edge run the natural voice engine in an offscreen page, created when a
// tab first asks for it. Firefox runs it in the background page itself.
let creating = null;
async function ensureEngine() {
  if (!api.offscreen) return;
  if (await api.offscreen.hasDocument?.()) return;
  creating ??= api.offscreen.createDocument({
    url: "engine/offscreen.html",
    reasons: ["AUDIO_PLAYBACK"],
    justification: "Plays the natural voice that reads the page aloud, generated on this computer.",
  }).finally(() => { creating = null; });
  await creating;
}

// Replies work both ways: browsers that expect a returned promise use it, and
// older Chrome uses sendResponse.
function reply(promise, sendResponse) {
  return promise.then((value) => { try { sendResponse(value); } catch { /* already answered */ } return value; });
}

api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "outloud:engine") {
    return reply(ensureEngine().then(() => ({ ok: true }), (e) => ({ ok: false, message: String(e?.message ?? e) })), sendResponse);
  }
  if (msg?.type === "outloud:options") api.runtime.openOptionsPage();
  // Storage for the offscreen engine page, which can't reach it itself. Only
  // accepted from the extension's own pages, never from web pages.
  if (!sender.tab && sender.id === api.runtime.id) {
    const keys = ["licenseKey", "proActive", "proCheckedAt", "freeDay", "freeUsed"];
    const only = (o) => Object.fromEntries(Object.entries(o || {}).filter(([k]) => keys.includes(k)));
    if (msg?.type === "outloud:storage-get") return reply(api.storage.local.get(only(msg.defaults)), sendResponse);
    if (msg?.type === "outloud:storage-set") return reply(api.storage.local.set(only(msg.values)).then(() => true), sendResponse);
  }
  return false;
});
