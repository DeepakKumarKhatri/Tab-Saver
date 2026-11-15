// Development only: drives background.js with a fake chrome API.   node dev/test-background.mjs
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";
import assert from "node:assert/strict";

vm.runInThisContext(readFileSync(resolve(import.meta.dirname, "mock-chrome.js"), "utf8"));
const { legacySeed, OPEN_TABS } = globalThis.tabSaverSeeds;

if (!globalThis.navigator?.locks) {
  const chains = new Map();
  const locks = {
    request(name, fn) {
      const run = (chains.get(name) || Promise.resolve()).then(() => fn());
      chains.set(name, run.catch(() => {}));
      return run;
    },
  };
  if (globalThis.navigator) Object.defineProperty(globalThis.navigator, "locks", { value: locks, configurable: true });
  else globalThis.navigator = { locks };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const event = () => {
  const fns = [];
  return { addListener: (f) => fns.push(f), _fire: (...a) => Promise.all(fns.map((f) => f(...a))) };
};

// Extend the page mock with the APIs only the service worker uses.
const seed = { ...legacySeed(409), autoSaveEnabled: true };
const chrome = createChromeMock({ seed, tabs: OPEN_TABS });
chrome.runtime.onInstalled = event();
chrome.runtime.onStartup = event();
chrome.sidePanel.setPanelBehavior = async (o) => chrome.__calls.push({ api: "sidePanel.setPanelBehavior", args: o });
const badge = {};
chrome.action = {
  onClicked: event(),
  setBadgeText: async ({ text }) => void (badge.text = text),
  setBadgeBackgroundColor: async ({ color }) => void (badge.color = color),
  setBadgeTextColor: async () => {},
};
const menus = new Map();
chrome.contextMenus = {
  removeAll: async () => menus.clear(),
  create: (props, cb) => {
    menus.set(props.id, props);
    cb?.();
  },
  onClicked: event(),
};
chrome.commands.onCommand = event();
const notes = [];
chrome.notifications = { create: (id, opts) => notes.push({ id, ...opts }), onClicked: event() };
chrome.scripting = { executeScript: async ({ args }) => [{ result: args[0].includes("youtu") ? "A linked video title" : "" }] };
globalThis.chrome = chrome;

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const state = async () => {
  const s = await chrome.storage.local.get(["items", "groups", "prefs"]);
  return { items: s.items || [], groups: s.groups || [], prefs: s.prefs || {} };
};
const activeTab = () => chrome.tabs._all.find((t) => t.active);

await import("../background.js");

test("toolbar icon opens the side panel", async () => {
  assert.ok(chrome.__calls.some((c) => c.api === "sidePanel.setPanelBehavior" && c.args.openPanelOnActionClick));
});

test("install/update migrates the old data and builds the right-click menus", async () => {
  await chrome.runtime.onInstalled._fire({ reason: "update" });
  const s = await state();
  assert.equal(s.items.length, 409);
  assert.equal(s.prefs.autoSave, true, "auto-save setting carried over");
  assert.ok(menus.has("page") && menus.has("link"));
  const pageChildren = [...menus.values()].filter((m) => m.parentId === "page").map((m) => m.title);
  assert.deepEqual(pageChildren.slice(0, 3), ["Unsorted", "Watch Later", "Learning"]);
  assert.ok(!pageChildren.some((t) => t.startsWith("Session")), "sessions are not offered as save targets");
  assert.ok(menus.has("action:save") && menus.has("action:page"));
});

test("right-click > Save page to a group", async () => {
  const s0 = await state();
  const learning = s0.groups.find((g) => g.name === "Learning");
  const tab = chrome.tabs._all.find((t) => t.url.includes("github.com"));
  await chrome.contextMenus.onClicked._fire({ menuItemId: `page:${learning.id}`, pageUrl: tab.url }, tab);
  await wait(50);
  const s = await state();
  const item = s.items.find((i) => i.url === tab.url);
  assert.equal(item.groupId, learning.id);
  assert.equal(item.title, tab.title);
  assert.equal(s.prefs.lastGroupId, learning.id, "the chosen group becomes the default");
  assert.equal(badge.text, "✓");
});

test("right-click > Save link reads the link's text for the title", async () => {
  const tab = activeTab();
  await chrome.contextMenus.onClicked._fire({ menuItemId: "link:unsorted", linkUrl: "https://youtu.be/NEWVIDEO1", frameId: 0, pageUrl: tab.url }, tab);
  await wait(50);
  const item = (await state()).items.find((i) => i.url === "https://youtu.be/NEWVIDEO1");
  assert.equal(item.title, "A linked video title");
  assert.equal(item.groupId, "unsorted");
});

test("keyboard shortcut saves the current tab into the default group", async () => {
  const tab = chrome.tabs._all.find((t) => t.url.includes("goodfood"));
  await chrome.commands.onCommand._fire("save-tab", tab);
  await wait(20);
  const s = await state();
  const item = s.items.find((i) => i.url === tab.url);
  assert.equal(item.groupId, s.prefs.lastGroupId);
});

test("shortcut on a page that can't be saved shows an error badge instead", async () => {
  const before = (await state()).items.length;
  await chrome.commands.onCommand._fire("save-tab", chrome.tabs._all.find((t) => t.url.startsWith("chrome://newtab")));
  await wait(20);
  assert.equal((await state()).items.length, before);
  assert.equal(badge.text, "✕");
});

test("menus follow group changes", async () => {
  const s = await state();
  const work = s.groups.find((g) => g.name === "Work");
  work.name = "Office";
  await chrome.storage.local.set({ groups: s.groups });
  await wait(50);
  assert.ok([...menus.values()].some((m) => m.parentId === "page" && m.title === "Office"));
});

test("open tabs are snapshotted, then filed as a Session after a restart", async () => {
  chrome.tabs._add({ url: "https://example.net/left-open", title: "Left open when Chrome closed" });
  await chrome.tabs.onCreated._fire({});
  await wait(2300); // snapshot is debounced by 2s
  const snap = (await chrome.storage.local.get("openTabsSnapshot")).openTabsSnapshot;
  assert.ok(snap?.tabs.some((t) => t.url === "https://example.net/left-open"));
  assert.ok(!snap.tabs.some((t) => t.url.startsWith("chrome://newtab")));

  // Chrome restarts: session storage is wiped and onStartup fires.
  await chrome.storage.session.clear();
  await chrome.runtime.onStartup._fire();
  await wait(50);
  const s = await state();
  const sessions = s.groups.filter((g) => g.kind === "session" && g.name.startsWith("Session · ") && s.items.some((i) => i.groupId === g.id && i.url === "https://example.net/left-open"));
  assert.equal(sessions.length, 1);
  const inSession = s.items.filter((i) => i.groupId === sessions[0].id);
  assert.ok(!inSession.some((i) => i.url.includes("goodfood")), "tabs that were already saved are not duplicated");
  assert.equal(notes.at(-1)?.id, "session");

  // A second startup event (or a service worker restart) must not file it twice.
  await chrome.runtime.onStartup._fire();
  await chrome.storage.session.clear();
  await chrome.runtime.onStartup._fire();
  await wait(50);
  const again = (await state()).groups.filter((g) => g.kind === "session" && (s.items.some((i) => i.groupId === g.id && i.url === "https://example.net/left-open")));
  assert.equal(again.length, 1);
});

test("no session is filed when auto-save is off", async () => {
  const s = await state();
  await chrome.storage.local.set({ prefs: { ...s.prefs, autoSave: false } });
  await wait(20);
  const groupsBefore = (await state()).groups.length;
  await chrome.storage.local.set({ openTabsSnapshot: { takenAt: Date.now() + 1, tabs: [{ url: "https://example.net/other", title: "x" }] } });
  await chrome.storage.session.clear();
  await chrome.runtime.onStartup._fire();
  await wait(50);
  assert.equal((await state()).groups.length, groupsBefore);
});

let failed = 0;
for (const { name, fn } of tests) {
  try {
    await fn();
    console.log(`  ok    ${name}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL  ${name}\n${e.stack.split("\n").slice(0, 6).join("\n")}`);
  }
}
console.log(failed ? `\n${failed} of ${tests.length} failed` : `\nall ${tests.length} passed`);
process.exit(failed ? 1 : 0);
