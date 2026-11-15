// Tab Saver app. The same page runs in the side panel and as a full tab (app.html?mode=page).
//
// Data flow: storage is the single source of truth. Actions write through lib/db.js, and every
// open copy of the app (side panel, full page) re-renders from chrome.storage.onChanged.

import * as db from "../lib/db.js";
import { UNSORTED, GROUP_COLORS } from "../lib/db.js";
import { urlInfo, escapeHtml, ago, fullDate, startOfToday, dateBucketKey, dateBucketLabel, isSaveable, debounce } from "../lib/util.js";
import { VirtualList } from "./vlist.js";
import { icon, toast, runUndo, openMenu, openDialog, promptText, confirmAction, pickGroup } from "./ui.js";

const ROW_H = 50;
const HEAD_H = 34;
const HINT_H = 44;
const OPEN_MANY_CONFIRM = 15;
const ITEMS_MIME = "application/x-tabsaver-items";
const GROUP_MIME = "application/x-tabsaver-group";
const FAVICON_BASE = chrome.runtime.getURL("/_favicon/");
const APP_URL = chrome.runtime.getURL("app.html");
const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });
const wideLayout = matchMedia("(min-width: 760px)");
const GROUP_BY_LABEL = { group: "By group", date: "By date", site: "By site", none: "No grouping" };
const SORT_LABEL = { newest: "Newest", oldest: "Oldest", title: "A to Z" };

let MODE = new URLSearchParams(location.search).get("mode") === "page" ? "page" : "panel";
let UI_KEY = "tabsaver.ui.panel";
let list = null;
const els = {};

const S = {
  items: [],
  groups: [],
  prefs: { ...db.DEFAULT_PREFS },
  itemById: new Map(),
  groupById: new Map(),
  byKey: new Map(),
  rank: new Map(),
  counts: { all: 0, done: 0, group: new Map(), total: new Map() },
  view: "all",
  query: "",
  tokens: [],
  groupByAll: "group",
  groupByGroup: "date",
  sort: "newest",
  selected: new Set(),
  anchorId: null,
  activeId: null,
  lastActiveIndex: 0,
  folded: new Set(),
  revealed: new Set(),
  sessionsOpen: false,
  rows: [],
  heads: [],
  order: [],
  rowIndex: new Map(),
  orderIndex: new Map(),
  searching: false,
  windowId: null,
  currentTab: null,
  shortcuts: {},
  restoreScrollTop: 0,
};

const favUrl = (url) => `${FAVICON_BASE}?pageUrl=${encodeURIComponent(url)}&size=32`;
const tokenize = (q) => q.toLowerCase().split(/\s+/).filter(Boolean);
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const shorten = (s, n = 48) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);
const isHidden = (gid) => !!S.groupById.get(gid)?.private && !S.revealed.has(gid);
const isValidView = (v) => v === "all" || v === "done" || S.groupById.has(v);
const defaultGroupId = () => (S.groupById.has(S.prefs.lastGroupId) ? S.prefs.lastGroupId : UNSORTED);

init().catch((err) => {
  console.error(err);
  document.body.innerHTML = `<div class="fatal"><h2>Tab Saver couldn't start</h2><p>${escapeHtml(err?.message || err)}</p></div>`;
});

// ===========================================================================
// Startup
// ===========================================================================

async function init() {
  for (const el of document.querySelectorAll("[id]")) els[el.id] = el;
  if (MODE === "panel" && (await chrome.tabs.getCurrent().catch(() => null))) MODE = "page";
  document.documentElement.dataset.mode = MODE;
  UI_KEY = `tabsaver.ui.${MODE}`;
  restoreUi();

  list = new VirtualList(els.list, {
    height: (r) => (r.t === "item" ? ROW_H : r.t === "head" ? HEAD_H : HINT_H),
    key: (r) => (r.t === "item" ? "i:" + r.it.id : r.key),
    render: renderRow,
    onUpdate: updateSticky,
  });

  bindEvents();
  applyState(await db.loadState());
  renderAll({ restoreScroll: true });
  chrome.storage.onChanged.addListener(onStorageChanged);

  S.windowId = (await chrome.windows.getCurrent()).id;
  if (MODE === "panel") watchCurrentTab();
  setupSurfaceButton();
  chrome.commands
    ?.getAll()
    .then((cmds) => {
      for (const c of cmds) S.shortcuts[c.name] = c.shortcut || "";
      if (!S.items.length) renderList();
    })
    .catch(() => {});
  els.search.focus({ preventScroll: true });
}

function restoreUi() {
  let ui = {};
  try {
    ui = JSON.parse(localStorage.getItem(UI_KEY) || "{}") || {};
  } catch {
    ui = {};
  }
  if (typeof ui.view === "string") S.view = ui.view;
  if (GROUP_BY_LABEL[ui.groupByAll]) S.groupByAll = ui.groupByAll;
  if (GROUP_BY_LABEL[ui.groupByGroup] && ui.groupByGroup !== "group") S.groupByGroup = ui.groupByGroup;
  if (SORT_LABEL[ui.sort]) S.sort = ui.sort;
  S.sessionsOpen = !!ui.sessionsOpen;
  // Coming back within 15 minutes? Pick up exactly where you left off.
  if (ui.savedAt && Date.now() - ui.savedAt < 15 * 60 * 1000) {
    S.query = ui.query || "";
    S.tokens = tokenize(S.query);
    S.restoreScrollTop = ui.scroll || 0;
    S.activeId = ui.activeId || null;
  }
  els.search.value = S.query;
}

function saveUi() {
  try {
    localStorage.setItem(
      UI_KEY,
      JSON.stringify({
        view: S.view,
        groupByAll: S.groupByAll,
        groupByGroup: S.groupByGroup,
        sort: S.sort,
        sessionsOpen: S.sessionsOpen,
        query: S.query,
        scroll: els.list.scrollTop,
        activeId: S.activeId,
        savedAt: Date.now(),
      })
    );
  } catch {
    /* storage full or blocked: not important */
  }
}
const persistUi = debounce(saveUi, 300);

// ===========================================================================
// State
// ===========================================================================

function applyState({ items, groups, prefs }) {
  S.items = items;
  S.groups = groups;
  S.prefs = { ...db.DEFAULT_PREFS, ...prefs };
  S.groupById = new Map(groups.map((g) => [g.id, g]));

  const normal = groups.filter((g) => g.kind !== "session");
  const sessions = groups.filter((g) => g.kind === "session").sort((a, b) => b.createdAt - a.createdAt);
  S.rank = new Map([...normal, ...sessions].map((g, i) => [g.id, i]));

  S.itemById = new Map();
  S.byKey = new Map();
  const counts = { all: 0, done: 0, group: new Map(), total: new Map() };
  for (const it of items) {
    const info = urlInfo(it.url);
    it.title ||= it.url;
    it._key = info.key;
    it._dom = info.domain;
    it._gid = S.groupById.has(it.groupId) ? it.groupId : UNSORTED;
    it._tl = it.title.toLowerCase();
    it._hay = it._tl + " " + it.url.toLowerCase().replace(/^https?:\/\/(www\.)?/, "");
    S.itemById.set(it.id, it);
    const prev = S.byKey.get(it._key);
    if (!prev || prev.savedAt < it.savedAt) S.byKey.set(it._key, it);
    counts.total.set(it._gid, (counts.total.get(it._gid) || 0) + 1);
    if (it.doneAt) counts.done++;
    else {
      counts.group.set(it._gid, (counts.group.get(it._gid) || 0) + 1);
      if (!isHidden(it._gid)) counts.all++;
    }
  }
  S.counts = counts;
  if (!isValidView(S.view)) S.view = "all";
  for (const id of S.selected) if (!S.itemById.has(id)) S.selected.delete(id);
}

let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    renderAll();
  });
}

function onStorageChanged(changes, area) {
  if (area !== "local" || !(changes.items || changes.groups || changes.prefs)) return;
  const next = db.normalizeState({
    items: changes.items ? changes.items.newValue : S.items,
    groups: changes.groups ? changes.groups.newValue : S.groups,
    prefs: changes.prefs ? changes.prefs.newValue : S.prefs,
  });
  applyState(next);
  scheduleRender();
}

async function refreshFromStorage() {
  applyState(await db.loadState());
  renderAll();
}

// ===========================================================================
// Building the list
// ===========================================================================

const matches = (it, tokens) => tokens.every((t) => it._hay.includes(t));

function score(it, tokens) {
  let s = 0;
  for (const t of tokens) {
    const i = it._tl.indexOf(t);
    if (i < 0) s += 1; // only the URL matched
    else if (i === 0 || !/[\p{L}\p{N}]/u.test(it._tl[i - 1])) s += 4; // start of a word in the title
    else s += 3;
  }
  return s;
}

function sorter(time) {
  if (S.sort === "oldest") return (a, b) => time(a) - time(b);
  if (S.sort === "title") return (a, b) => collator.compare(a.title, b.title) || time(b) - time(a);
  return (a, b) => time(b) - time(a);
}

function computeRows() {
  const { tokens, view } = S;
  const searching = tokens.length > 0;
  const inDone = view === "done";
  const time = inDone ? (it) => it.doneAt : (it) => it.savedAt;

  const items = [];
  let doneMatches = 0;
  for (const it of S.items) {
    if (inDone) {
      if (!it.doneAt) continue;
    } else {
      if (view !== "all" && it._gid !== view) continue;
      if (view === "all" && isHidden(it._gid)) continue;
      if (it.doneAt) {
        if (searching && !isHidden(it._gid) && matches(it, tokens)) doneMatches++;
        continue;
      }
    }
    if (searching && !matches(it, tokens)) continue;
    items.push(it);
  }

  const rows = [];
  const heads = [];
  const order = [];
  const head = (key, label, extra) => {
    const r = { t: "head", key: "h:" + key, label, count: 0, folded: false, ...extra };
    heads.push(rows.length);
    rows.push(r);
    return r;
  };
  const push = (it) => {
    order.push(it);
    rows.push({ t: "item", it });
  };
  const base = sorter(time);
  const mode = searching ? "none" : view === "all" ? S.groupByAll : S.groupByGroup;

  if (searching) {
    const scores = new Map(items.map((it) => [it, score(it, tokens)]));
    items.sort((a, b) => scores.get(b) - scores.get(a) || time(b) - time(a));
    items.forEach(push);
  } else if (mode === "group") {
    const rank = (it) => S.rank.get(it._gid) ?? 1e9;
    items.sort((a, b) => rank(a) - rank(b) || base(a, b));
    let cur = null;
    for (const it of items) {
      if (!cur || cur.gid !== it._gid) {
        const g = S.groupById.get(it._gid);
        cur = head("g:" + g.id, g.name, { gid: g.id, group: g, folded: !!g.collapsed });
      }
      cur.count++;
      if (!cur.folded) push(it);
    }
  } else if (mode === "date") {
    const today = startOfToday();
    const oldestFirst = S.sort === "oldest";
    items.sort((a, b) => (oldestFirst ? time(a) - time(b) : time(b) - time(a)));
    let cur = null;
    let bucket = [];
    const flush = () => {
      if (!cur) return;
      if (S.sort === "title") bucket.sort(base);
      cur.count = bucket.length;
      if (!cur.folded) bucket.forEach(push);
    };
    for (const it of items) {
      const k = dateBucketKey(time(it), today);
      if (!cur || cur.bucket !== k) {
        flush();
        bucket = [];
        cur = head("d:" + k, dateBucketLabel(k, time(it), today), { bucket: k, folded: S.folded.has("h:d:" + k) });
      }
      bucket.push(it);
    }
    flush();
  } else if (mode === "site") {
    const perSite = new Map();
    for (const it of items) perSite.set(it._dom, (perSite.get(it._dom) || 0) + 1);
    items.sort((a, b) => perSite.get(b._dom) - perSite.get(a._dom) || collator.compare(a._dom, b._dom) || base(a, b));
    let cur = null;
    for (const it of items) {
      if (!cur || cur.dom !== it._dom) cur = head("s:" + it._dom, it._dom || "Other", { dom: it._dom, folded: S.folded.has("h:s:" + it._dom) });
      cur.count++;
      if (!cur.folded) push(it);
    }
  } else {
    items.sort(base);
    items.forEach(push);
  }

  if (searching && doneMatches && !inDone) rows.push({ t: "hint", key: "hint:done", n: doneMatches });
  return { rows, heads, order, searching, doneMatches };
}
