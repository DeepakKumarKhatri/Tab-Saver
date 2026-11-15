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
