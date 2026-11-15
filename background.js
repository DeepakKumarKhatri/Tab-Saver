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

// ---------------------------------------------------------------------------
// Saving from the browser (shortcut, right-click)
// ---------------------------------------------------------------------------

function flash(tabId, text, color = OK_COLOR) {
  const target = tabId ? { tabId } : {};
  chrome.action.setBadgeBackgroundColor({ ...target, color }).catch(() => {});
  chrome.action.setBadgeTextColor?.({ ...target, color: "#ffffff" })?.catch(() => {});
  chrome.action.setBadgeText({ ...target, text }).catch(() => {});
  setTimeout(() => chrome.action.setBadgeText({ ...target, text: "" }).catch(() => {}), 2200);
}

async function defaultGroupId() {
  const { prefs, groups } = await loadState();
  return groups.some((g) => g.id === prefs.lastGroupId) ? prefs.lastGroupId : UNSORTED;
}

async function saveFromTab(tab, groupId) {
  const url = tab?.url || tab?.pendingUrl;
  if (!isSaveable(url)) return flash(tab?.id, "✕", ERR_COLOR);
  await saveTabs([{ url, title: tab.title }], { groupId: groupId || (await defaultGroupId()), remember: !!groupId });
  flash(tab.id, "✓");
}

async function saveLink(tab, info, groupId) {
  const url = info.linkUrl;
  if (!/^(https?|file):/i.test(url || "")) return flash(tab?.id, "✕", ERR_COLOR);
  const title = (await linkText(tab, info)) || titleFromUrl(url);
  await saveTabs([{ url, title }], { groupId: groupId || (await defaultGroupId()), remember: !!groupId });
  flash(tab?.id, "✓");
}

/** Read the text of the right-clicked link so a saved link gets a real title (e.g. a YouTube video name). */
async function linkText(tab, info) {
  if (!tab?.id) return "";
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: tab.id, frameIds: [info.frameId ?? 0] },
      args: [info.linkUrl],
      func: (href) => {
        const clean = (s) => (s || "").replace(/\s+/g, " ").trim();
        let titled = "";
        let text = "";
        let label = "";
        for (const a of document.querySelectorAll("a[href]")) {
          if (a.href !== href) continue;
          titled ||= clean(a.getAttribute("title"));
          const t = clean(a.innerText);
          if (t.length > text.length && t.length < 300) text = t;
          label ||= clean(a.getAttribute("aria-label")) || clean(a.querySelector("img[alt]")?.alt);
        }
        return titled || text || label;
      },
    });
    return typeof res?.result === "string" ? res.result.slice(0, 300) : "";
  } catch {
    return ""; // pages like the Chrome Web Store don't allow scripts
  }
}

chrome.commands.onCommand.addListener((command, tab) => {
  if (command === "open-tab-saver") {
    // sidePanel.open() must run synchronously inside the shortcut's user gesture.
    if (chrome.sidePanel?.open && tab?.windowId) {
      chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => openFullPage(tab.windowId));
    } else {
      openFullPage(tab?.windowId);
    }
  } else if (command === "save-tab") {
    const getTab = tab ? Promise.resolve(tab) : chrome.tabs.query({ active: true, lastFocusedWindow: true }).then(([t]) => t);
    getTab.then((t) => saveFromTab(t)).catch((e) => console.error("Tab Saver save:", e));
  }
});

// ---------------------------------------------------------------------------
// Right-click menus (rebuilt whenever groups change)
// ---------------------------------------------------------------------------

let menuQueue = Promise.resolve();
let menuSignature = "";

function rebuildMenus() {
  menuQueue = menuQueue.then(buildMenus).catch((e) => console.error("Tab Saver menus:", e));
  return menuQueue;
}

async function buildMenus() {
  const { groups } = await loadState();
  const targets = groups.filter((g) => g.kind !== "session").slice(0, MENU_GROUP_LIMIT);
  const signature = JSON.stringify(targets.map((g) => [g.id, g.name]));
  if (signature === menuSignature) return;
  menuSignature = signature;

  await chrome.contextMenus.removeAll();
  const create = (props) => chrome.contextMenus.create(props, () => void chrome.runtime.lastError);
  for (const [ctx, title] of [
    ["page", "Save page to Tab Saver"],
    ["link", "Save link to Tab Saver"],
  ]) {
    create({ id: ctx, title, contexts: [ctx] });
    for (const g of targets) create({ id: `${ctx}:${g.id}`, parentId: ctx, title: g.name, contexts: [ctx] });
  }
  create({ id: "action:save", title: "Save this tab", contexts: ["action"] });
  create({ id: "action:page", title: "Open Tab Saver in a tab", contexts: ["action"] });
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  const [kind, groupId] = String(info.menuItemId).split(":");
  let job;
  if (kind === "action") job = groupId === "page" ? openFullPage(tab?.windowId) : saveFromTab(tab);
  else if (kind === "page") job = saveFromTab(tab, groupId);
  else if (kind === "link") job = saveLink(tab, info, groupId);
  job?.catch((e) => {
    console.error("Tab Saver:", e);
    flash(tab?.id, "!", ERR_COLOR);
  });
});

chrome.notifications.onClicked.addListener((id) => {
  if (id === "session") openFullPage();
});
