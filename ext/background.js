// Out Loud: background script.
// Injects the reader into the current tab only when the user asks (toolbar
// button, keyboard shortcut or right-click menu). No host permissions, no
// network requests, nothing stored about the pages you read.

const api = globalThis.browser ?? globalThis.chrome;

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
