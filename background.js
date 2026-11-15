// Tab Saver background service worker.
//   - Toolbar icon opens the side panel (falls back to a full tab where side panels don't exist)
//   - Keyboard shortcuts: save the current tab, open Tab Saver
//   - Right-click menus: "Save page to Tab Saver" and "Save link to Tab Saver" (pick a group)
//   - Optional: when Chrome restarts, save the tabs that were open last time as a "Session" group

import { ensureSchema, loadState, saveTabs, UNSORTED } from "./lib/db.js";
import { isSaveable, titleFromUrl, fullDate } from "./lib/util.js";

const APP_URL = chrome.runtime.getURL("app.html");
const SNAPSHOT_KEY = "openTabsSnapshot";
const MENU_GROUP_LIMIT = 25;
const OK_COLOR = "#0d7377";
const ERR_COLOR = "#c53030";

// ---------------------------------------------------------------------------
// Toolbar icon
// ---------------------------------------------------------------------------

if (chrome.sidePanel?.setPanelBehavior) {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
}
// Only fires when the side panel is not handling the click (older or non-Chrome browsers).
chrome.action.onClicked.addListener((tab) => openFullPage(tab?.windowId));

async function openFullPage(windowId) {
  const tabs = await chrome.tabs.query({});
  const open = tabs.find((t) => t.url?.startsWith(APP_URL) && t.url.includes("mode=page"));
  if (open) {
    await chrome.tabs.update(open.id, { active: true });
    await chrome.windows.update(open.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url: APP_URL + "?mode=page", ...(windowId ? { windowId } : {}) });
  }
}

// ---------------------------------------------------------------------------
// Install / startup
// ---------------------------------------------------------------------------

chrome.runtime.onInstalled.addListener(async () => {
  await chrome.storage.session.set({ sessionActive: true });
  await ensureSchema();
  await rebuildMenus();
  scheduleSnapshot();
});

chrome.runtime.onStartup.addListener(() => {
  handleStartup().catch((e) => console.error("Tab Saver startup:", e));
});
