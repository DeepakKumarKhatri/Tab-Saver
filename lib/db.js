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

// ---------------------------------------------------------------------------
// Reading and writing
// ---------------------------------------------------------------------------

export async function loadState() {
  await ensureSchema();
  return normalizeState(await chrome.storage.local.get(["items", "groups", "prefs"]));
}

/**
 * Run fn(state) on a fresh copy of storage while holding the lock, then write back `keys`.
 * fn mutates state in place and may return a result.
 */
export async function mutate(keys, fn) {
  await ensureSchema();
  return withLock(async () => {
    const state = normalizeState(await chrome.storage.local.get(["items", "groups", "prefs"]));
    const result = await fn(state);
    const out = {};
    for (const k of keys) out[k] = state[k];
    await chrome.storage.local.set(out);
    return result;
  });
}

function latestByKey(items) {
  const map = new Map();
  for (const it of items) {
    const k = urlKey(it.url);
    const prev = map.get(k);
    if (!prev || prev.savedAt < it.savedAt) map.set(k, it);
  }
  return map;
}

export function findGroupByName(groups, name) {
  const n = String(name || "").trim().toLowerCase();
  return groups.find((g) => g.kind !== "session" && g.name.trim().toLowerCase() === n) || null;
}

function addGroup(s, name, extra = {}) {
  const clean = String(name || "").trim().slice(0, 60) || "Untitled";
  const g = { id: uid("g"), name: clean, color: colorFor(clean), createdAt: Date.now(), ...extra };
  s.groups.push(g);
  return g;
}

function applyPatch(target, patch) {
  for (const [k, v] of Object.entries(patch)) {
    if (v === null || v === undefined || v === false) delete target[k];
    else target[k] = v;
  }
}

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

/**
 * Save tabs ([{ url, title }]).
 *   groupId    save into this group
 *   groupName  save into the group with this name, creating it if needed
 *   session    always create a new "session" group named groupName
 *   existing   "move": an already saved URL moves to the target group and jumps to the top (single saves)
 *              "skip": already saved URLs stay where they are (bulk saves)
 *   remember   make the target the default group for the next save
 * Items sitting in Done are always brought back.
 * Returns what changed, including `prev` copies for undo.
 */
export function saveTabs(tabs, { groupId, groupName, session = false, existing = "move", remember = true } = {}) {
  return mutate(["items", "groups", "prefs"], (s) => {
    const now = Date.now();
    let group = null;
    let createdGroup = null;
    if (session) group = createdGroup = addGroup(s, groupName, { kind: "session", collapsed: true, createdAt: now });
    else if (groupId) group = s.groups.find((g) => g.id === groupId) || null;
    if (!group && groupName) {
      group = findGroupByName(s.groups, groupName);
      if (!group) group = createdGroup = addGroup(s, groupName);
    }
    group ??= s.groups.find((g) => g.id === UNSORTED);

    const index = latestByKey(s.items);
    const res = { groupId: group.id, groupName: group.name, createdGroup: createdGroup?.id || null, added: [], updated: [], skipped: 0, prev: [] };
    const seen = new Set();
    for (const t of tabs) {
      if (!t || !t.url) continue;
      const key = urlKey(t.url);
      if (seen.has(key)) continue;
      seen.add(key);
      const ex = index.get(key);
      if (ex) {
        if (!ex.doneAt && existing === "skip") {
          res.skipped++;
          continue;
        }
        res.prev.push({ ...ex });
        ex.url = t.url;
        if (t.title) ex.title = cleanTitle(t.title, t.url);
        ex.groupId = group.id;
        ex.savedAt = now;
        delete ex.doneAt;
        res.updated.push(ex.id);
      } else {
        const it = { id: uid(), url: t.url, title: cleanTitle(t.title, t.url), groupId: group.id, savedAt: now };
        s.items.push(it);
        index.set(key, it);
        res.added.push(it.id);
      }
    }
    if (session && !res.added.length && !res.updated.length) {
      s.groups = s.groups.filter((g) => g !== group);
      res.createdGroup = null;
    }
    if (remember && !session) s.prefs.lastGroupId = group.id;
    return res;
  });
}

/** Patch items by id. patch is an object or (item) => object; null/false values remove a field. */
export function patchItems(ids, patch) {
  const wanted = new Set(ids);
  return mutate(["items"], (s) => {
    const prev = [];
    for (const it of s.items) {
      if (!wanted.has(it.id)) continue;
      prev.push({ ...it });
      applyPatch(it, typeof patch === "function" ? patch(it) : patch);
    }
    return { prev };
  });
}

export function deleteItems(ids) {
  const doomed = new Set(ids);
  return mutate(["items"], (s) => {
    const prev = s.items.filter((it) => doomed.has(it.id));
    s.items = s.items.filter((it) => !doomed.has(it.id));
    return { prev };
  });
}

/** Undo helper: put item and group records back exactly as they were. */
export function restore({ items = [], groups = [], removeItemIds = [], removeGroupIds = [] } = {}) {
  return mutate(["items", "groups"], (s) => {
    if (removeItemIds.length) {
      const r = new Set(removeItemIds);
      s.items = s.items.filter((it) => !r.has(it.id));
    }
    if (removeGroupIds.length) {
      const r = new Set(removeGroupIds);
      s.groups = s.groups.filter((g) => g.id === UNSORTED || !r.has(g.id));
    }
    for (const { group, index } of groups) {
      const at = s.groups.findIndex((g) => g.id === group.id);
      if (at >= 0) s.groups[at] = group;
      else s.groups.splice(Math.min(index ?? s.groups.length, s.groups.length), 0, group);
    }
    const pos = new Map(s.items.map((it, i) => [it.id, i]));
    for (const rec of items) {
      const at = pos.get(rec.id);
      if (at === undefined) s.items.push(rec);
      else s.items[at] = rec;
    }
  });
}
