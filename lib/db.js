// Tab Saver storage layer.
//
// Everything lives in chrome.storage.local under three keys:
//   items:  [{ id, url, title, groupId, savedAt, openedAt?, doneAt? }]
//   groups: [{ id, name, color, createdAt, kind?: "session", private?, collapsed?, openedAt? }]
//   prefs:  { autoSave, lastGroupId, onOpen }
//
// Every write goes through mutate(), which re-reads storage while holding a Web Lock.
// That way the side panel, the full page and the background worker can never
// overwrite each other's changes (the old version could lose tabs that way).
//
// Data from version 3 and older (savedTabs / categories) is converted once by
// ensureSchema(). The old keys are left untouched as a backup.

import { uid, urlKey, cleanTitle, fullDate } from "./util.js";

export const SCHEMA_VERSION = 4;
export const UNSORTED = "unsorted";
export const GROUP_COLORS = ["grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"];
export const DEFAULT_PREFS = Object.freeze({ autoSave: false, lastGroupId: UNSORTED, onOpen: "keep" });

const LOCK_NAME = "tab-saver-db";
const LEGACY_KEYS = [
  "savedTabs",
  "categories",
  "collapsedCategories",
  "hiddenCategories",
  "categoryOrder",
  "categoryLastOpened",
  "autoSaveEnabled",
];
const ITEM_FIELDS = ["url", "title", "groupId", "savedAt", "openedAt", "doneAt"];

export function colorFor(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  return GROUP_COLORS[1 + (Math.abs(h) % (GROUP_COLORS.length - 1))]; // grey is kept for Unsorted
}

function withLock(fn) {
  const locks = globalThis.navigator?.locks;
  return locks?.request ? locks.request(LOCK_NAME, fn) : fn();
}

const makeUnsorted = (now = Date.now()) => ({ id: UNSORTED, name: "Unsorted", color: "grey", createdAt: now });

export function normalizeState(raw = {}) {
  const items = Array.isArray(raw.items) ? raw.items.filter((i) => i && i.id && typeof i.url === "string") : [];
  const groups = Array.isArray(raw.groups) ? raw.groups.filter((g) => g && g.id && typeof g.name === "string") : [];
  if (!groups.some((g) => g.id === UNSORTED)) groups.unshift(makeUnsorted());
  return { items, groups, prefs: { ...DEFAULT_PREFS, ...(raw.prefs || {}) } };
}

// ---------------------------------------------------------------------------
// Schema / migration
// ---------------------------------------------------------------------------

let schemaReady = null;

export function ensureSchema() {
  schemaReady ??= withLock(async () => {
    const { schemaVersion = 0 } = await chrome.storage.local.get("schemaVersion");
    if (schemaVersion >= SCHEMA_VERSION) return;
    const legacy = await chrome.storage.local.get(LEGACY_KEYS);
    await chrome.storage.local.set({ ...migrateLegacy(legacy), schemaVersion: SCHEMA_VERSION });
  }).catch((err) => {
    schemaReady = null;
    throw err;
  });
  return schemaReady;
}

/** Convert version 1-3 data ({ savedTabs, categories, ... }) to the current schema. */
export function migrateLegacy(legacy = {}) {
  const now = Date.now();
  const tabs = Array.isArray(legacy.savedTabs) ? legacy.savedTabs : [];

  const names = [];
  const seen = new Set(["All"]);
  const addName = (n) => {
    if (typeof n === "string" && n.trim() && !seen.has(n)) {
      seen.add(n);
      names.push(n);
    }
  };
  (Array.isArray(legacy.categoryOrder) ? legacy.categoryOrder : []).forEach(addName);
  (Array.isArray(legacy.categories) ? legacy.categories : []).forEach(addName);
  tabs.forEach((t) => addName(t?.category));

  const hidden = new Set(legacy.hiddenCategories || []);
  const collapsed = new Set(legacy.collapsedCategories || []);
  const lastOpened = legacy.categoryLastOpened || {};

  const groups = [makeUnsorted(now)];
  const idByName = new Map([["All", UNSORTED]]);
  for (const name of names) {
    const g = { id: uid("g"), name: name.trim().slice(0, 60), color: colorFor(name), createdAt: now };
    if (/^Auto-\d{4}-\d{2}-\d{2}/.test(name)) {
      g.kind = "session";
      g.collapsed = true;
    }
    if (hidden.has(name)) g.private = true;
    if (collapsed.has(name)) g.collapsed = true;
    const opened = Date.parse(lastOpened[name]);
    if (opened) g.openedAt = opened;
    idByName.set(name, g.id);
    groups.push(g);
  }

  // Newest first, so if a URL somehow appears twice we keep the latest copy.
  const sorted = tabs
    .filter((t) => t && typeof t.url === "string" && t.url)
    .map((t) => ({ t, at: Date.parse(t.date) || now }))
    .sort((a, b) => b.at - a.at);
  const items = [];
  const seenUrls = new Set();
  const firstSaved = new Map();
  for (const { t, at } of sorted) {
    if (seenUrls.has(t.url)) continue;
    seenUrls.add(t.url);
    const groupId = idByName.get(t.category) ?? UNSORTED;
    items.push({ id: uid(), url: t.url, title: cleanTitle(t.title, t.url), groupId, savedAt: at });
    if (!firstSaved.has(groupId) || at < firstSaved.get(groupId)) firstSaved.set(groupId, at);
  }

  // Old auto-save categories were named like "Auto-2025-12-01-221530". Give them readable names.
  for (const g of groups) {
    if (g.kind !== "session") continue;
    const at = firstSaved.get(g.id);
    if (at) {
      g.createdAt = at;
      g.name = "Session · " + fullDate(at);
    }
  }

  return { items, groups, prefs: { ...DEFAULT_PREFS, autoSave: !!legacy.autoSaveEnabled } };
}
