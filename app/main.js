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
  if (chrome.__mock) window.__tabSaver = { S, list, renderList, setQuery }; // dev harness only
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

// ===========================================================================
// Rendering
// ===========================================================================

function renderAll(opts = {}) {
  renderNav();
  renderToolbar();
  renderList(opts);
  renderCurrent();
}

function renderList({ resetScroll = false, restoreScroll = false } = {}) {
  const r = computeRows();
  S.rows = r.rows;
  S.heads = r.heads;
  S.order = r.order;
  S.searching = r.searching;
  S.rowIndex = new Map();
  r.rows.forEach((row, i) => row.t === "item" && S.rowIndex.set(row.it.id, i));
  S.orderIndex = new Map(r.order.map((it, i) => [it.id, i]));

  // Keep the keyboard cursor on something visible (e.g. the next item after one is deleted).
  if (S.activeId && !S.orderIndex.has(S.activeId)) {
    const i = Math.min(S.lastActiveIndex, r.order.length - 1);
    S.activeId = i >= 0 && document.activeElement === els.list ? r.order[i].id : null;
  }
  if (r.searching && !S.activeId && r.order.length) S.activeId = r.order[0].id;

  els.app.classList.toggle("searching", r.searching);
  els.app.classList.toggle("selecting", S.selected.size > 0);
  if (resetScroll) els.list.scrollTop = 0;
  els.sticky.__row = null;
  list.setRows(r.rows);
  if (restoreScroll && S.restoreScrollTop) {
    list.scrollTop = S.restoreScrollTop;
    S.restoreScrollTop = 0;
  }
  renderEmpty(r);
  renderSelbar();
  syncActiveAria();
}

function renderRow(row, el) {
  if (row.t === "item") return renderItem(row.it, el);
  el.removeAttribute("id");
  el.removeAttribute("aria-selected");
  el.removeAttribute("draggable");
  el.setAttribute("role", "presentation");
  if (row.t === "head") {
    el.className = "row head" + (row.folded ? " folded" : "") + (row.gid ? " ghead" : "");
    el.innerHTML = headHtml(row);
  } else {
    el.className = "row hint";
    el.innerHTML = `<button type="button" class="link-btn" data-act="search-done">${icon("i-check-circle")}<span>${plural(row.n, "more match")} in Done</span></button>`;
  }
}

function headHtml(row) {
  const g = row.group;
  const lead = g ? (g.private ? icon("i-lock", "h-ico") : g.kind === "session" ? icon("i-clock", "h-ico") : `<span class="gdot c-${g.color || "grey"}"></span>`) : "";
  const label = g?.kind === "session" ? row.label.replace(/^Session · /, "Session: ") : row.label;
  const acts = g
    ? `<span class="h-acts"><button type="button" tabindex="-1" class="h-btn" data-act="open-group" title="Open all as a tab group">${icon("i-external")}<span>Open all</span></button><button type="button" tabindex="-1" class="h-btn" data-act="group-menu" title="Group actions">${icon("i-more")}</button></span>`
    : "";
  return `<span class="fold" data-act="fold">${icon("i-chevron-down")}</span>${lead}<span class="h-label">${escapeHtml(label)}</span><span class="h-count">${row.count}</span><span class="grow"></span>${acts}`;
}

function highlight(text, tokens) {
  const lower = text.toLowerCase();
  if (lower.length !== text.length) return escapeHtml(text);
  const marks = [];
  for (const t of tokens) {
    for (let i = lower.indexOf(t); i >= 0 && marks.length < 24; i = lower.indexOf(t, i + t.length)) marks.push([i, i + t.length]);
  }
  if (!marks.length) return escapeHtml(text);
  marks.sort((a, b) => a[0] - b[0]);
  let out = "";
  let pos = 0;
  for (const [s, e] of marks) {
    if (e <= pos) continue;
    const from = Math.max(s, pos);
    out += escapeHtml(text.slice(pos, from)) + "<mark>" + escapeHtml(text.slice(from, e)) + "</mark>";
    pos = e;
  }
  return out + escapeHtml(text.slice(pos));
}

function renderItem(it, el) {
  const g = S.groupById.get(it._gid);
  const masked = isHidden(it._gid);
  const sel = S.selected.has(it.id);
  const inDone = S.view === "done";
  el.className = "row item" + (sel ? " sel" : "") + (it.id === S.activeId ? " active" : "") + (masked ? " masked" : "");
  el.id = "opt-" + it.id;
  el.setAttribute("role", "option");
  el.setAttribute("aria-selected", sel ? "true" : "false");
  el.draggable = !masked;

  const when = inDone ? it.doneAt : it.savedAt;
  const meta = [];
  if (!masked) meta.push(`<span class="dom">${escapeHtml(it._dom || "page")}</span>`);
  meta.push(`<span title="${inDone ? "Done" : "Saved"} ${escapeHtml(fullDate(when))}">${inDone ? "done " : ""}${ago(when)}</span>`);
  const showGroup = inDone || S.searching || (S.view === "all" && S.groupByAll !== "group");
  if (showGroup && g && (S.view === "all" || inDone)) {
    meta.push(`<span class="chip"><span class="gdot c-${g.color || "grey"}"></span>${escapeHtml(g.name)}</span>`);
  }
  if (it.openedAt && !inDone) meta.push(`<span class="opened" title="Last opened ${escapeHtml(fullDate(it.openedAt))}">opened ${ago(it.openedAt)}</span>`);

  const fav = masked ? `<span class="fav fav-fallback">${icon("i-lock")}</span>` : `<img class="fav" src="${favUrl(it.url)}" alt="" draggable="false">`;
  const title = masked ? "Hidden (private group)" : S.tokens.length ? highlight(it.title, S.tokens) : escapeHtml(it.title);
  el.innerHTML = `<span class="pick" data-act="pick" title="Select (X)">${fav}<span class="box">${icon("i-check")}</span></span><span class="body"><span class="title"${
    masked ? "" : ` title="${escapeHtml(it.title + "\n" + it.url)}"`
  }>${title}</span><span class="meta">${meta.join('<span class="sep">·</span>')}</span></span><span class="acts"><button type="button" tabindex="-1" data-act="bg" title="Open in a background tab (Ctrl+Enter)">${icon(
    "i-arrow-up-right"
  )}</button><button type="button" tabindex="-1" data-act="done" title="${inDone ? "Restore (E)" : "Done with it (E)"}">${icon(inDone ? "i-undo" : "i-check")}</button><button type="button" tabindex="-1" data-act="more" title="More">${icon(
    "i-more"
  )}</button></span>`;
}

function updateSticky(top) {
  const sticky = els.sticky;
  persistUi();
  const heads = S.heads;
  if (!heads.length || top <= 0) {
    sticky.hidden = true;
    return;
  }
  const offsets = list.offsets;
  let lo = 0;
  let hi = heads.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (offsets[heads[mid]] <= top) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  if (found < 0) {
    sticky.hidden = true;
    return;
  }
  const row = S.rows[heads[found]];
  if (sticky.__row !== row) {
    sticky.className = "sticky row head" + (row.folded ? " folded" : "") + (row.gid ? " ghead" : "");
    sticky.innerHTML = headHtml(row);
    sticky.__row = row;
  }
  const next = heads[found + 1];
  const push = next !== undefined ? Math.min(0, offsets[next] - top - HEAD_H) : 0;
  sticky.style.transform = `translateY(${push}px)`;
  sticky.style.right = els.list.offsetWidth - els.list.clientWidth + "px";
  sticky.hidden = false;
}

function renderEmpty(r) {
  let html = "";
  if (!r.rows.length) {
    if (!S.items.length) {
      const key = S.shortcuts["save-tab"];
      html = `<div class="hello">
        <img src="icons/icon128.png" alt="" width="56" height="56">
        <h3>Save tabs you want to come back to</h3>
        <ul>
          ${MODE === "panel" ? `<li>Click <b>Save</b> above to keep the page you're on</li>` : `<li>Click <b>Save open tabs</b> to keep everything in this window</li>`}
          ${key ? `<li>Press <kbd>${escapeHtml(key)}</kbd> on any page</li>` : ""}
          <li>Right-click any link or page and choose <b>Save to Tab Saver</b></li>
        </ul></div>`;
    } else if (r.searching) {
      html = `<h3>No matches for “${escapeHtml(S.query)}”</h3>${
        r.doneMatches && S.view !== "done"
          ? `<p><button type="button" class="btn" data-act="search-done">${icon("i-check-circle")}Search Done (${r.doneMatches})</button></p>`
          : S.view !== "all"
            ? `<p><button type="button" class="btn" data-act="search-all">Search everything</button></p>`
            : `<p>Try fewer or different words. The search looks at titles and links.</p>`
      }`;
    } else if (S.view === "done") {
      html = `<h3>Nothing in Done yet</h3><p>When you've finished with a saved tab, press <kbd>E</kbd> or click ${icon("i-check")} on it. It moves here, out of your way, and stays searchable.</p>`;
    } else if (S.view === "all") {
      html = `<h3>All caught up</h3><p>Everything you saved is in Done.</p>`;
    } else {
      html = `<h3>This group is empty</h3><p>Save tabs into it, or move saved tabs here from another group.</p>`;
    }
  }
  els.empty.innerHTML = html;
  els.empty.hidden = !html;
}

function viewMeta(view = S.view) {
  if (view === "all") return { name: "All saved", count: S.counts.all, lead: icon("i-inbox") };
  if (view === "done") return { name: "Done", count: S.counts.done, lead: icon("i-check-circle") };
  const g = S.groupById.get(view);
  const lead = g.private ? icon("i-lock") : g.kind === "session" ? icon("i-clock") : g.id === UNSORTED ? icon("i-folder") : `<span class="gdot c-${g.color || "grey"}"></span>`;
  return { name: g.name, count: S.counts.group.get(view) || 0, lead, group: g };
}

function renderToolbar() {
  const m = viewMeta();
  els.viewIcon.innerHTML = m.lead;
  els.viewName.textContent = m.name;
  els.viewCount.textContent = m.count;
  els.viewBtn.title = wideLayout.matches ? m.name : "Show groups";
  els.search.placeholder =
    S.view === "all" ? `Search ${plural(S.counts.all, "saved tab")}` : S.view === "done" ? "Search Done" : `Search in ${m.name}`;
  const gb = S.searching ? null : S.view === "all" ? S.groupByAll : S.groupByGroup;
  els.optionsLabel.textContent = gb ? `${GROUP_BY_LABEL[gb]} · ${SORT_LABEL[S.sort]}` : "Best match";
  if (MODE === "page") document.title = S.view === "all" ? "Tab Saver" : `${m.name} · Tab Saver`;
}

function renderSelbar() {
  const n = S.selected.size;
  els.selbar.hidden = !n;
  els.toolbar.hidden = !!n;
  els.app.classList.toggle("selecting", n > 0);
  if (!n) return;
  els.selCount.textContent = `${n} selected`;
  const allDone = [...S.selected].every((id) => S.itemById.get(id)?.doneAt);
  els.selDoneLabel.textContent = allDone ? "Restore" : "Done";
  els.selAll.hidden = n >= S.order.length;
  els.selAll.textContent = `Select all ${S.order.length}`;
}

function navRow(id, label, count, lead, { group = false, drag = false } = {}) {
  const on = S.view === id;
  const safe = escapeHtml(id);
  return `<div class="nav-row${on ? " on" : ""}" data-view="${safe}"${group ? ` data-group="${safe}"` : ""}${drag ? ' draggable="true"' : ""}>
    <button type="button" class="nav-item" data-view="${safe}"${on ? ' aria-current="page"' : ""}>${lead}<span class="nav-label">${escapeHtml(label)}</span><span class="nav-count">${count || ""}</span></button>${
      group ? `<button type="button" class="nav-more" data-group-menu="${safe}" title="Group actions" aria-label="Actions for ${escapeHtml(label)}">${icon("i-more")}</button>` : ""
    }</div>`;
}

function renderNav() {
  const c = S.counts;
  const groupLead = (g) => (g.private ? icon("i-lock", "nav-ico") : `<span class="gdot c-${g.color || "grey"}"></span>`);
  const unsorted = S.groupById.get(UNSORTED);
  const normal = S.groups.filter((g) => g.kind !== "session" && g.id !== UNSORTED);
  const sessions = S.groups.filter((g) => g.kind === "session" && c.total.get(g.id)).sort((a, b) => b.createdAt - a.createdAt);
  if (S.groupById.get(S.view)?.kind === "session") S.sessionsOpen = true;

  let html = `<div class="nav-sec">${navRow("all", "All saved", c.all, icon("i-inbox", "nav-ico"))}${navRow(UNSORTED, unsorted.name, c.group.get(UNSORTED), icon("i-folder", "nav-ico"), { group: true })}</div>`;
  html += `<div class="nav-head"><span>Groups</span><button type="button" class="icon-btn sm" data-act="new-group" title="New group">${icon("i-plus")}</button></div>`;
  html += `<div class="nav-sec" data-zone="groups">${
    normal.length
      ? normal.map((g) => navRow(g.id, g.name, c.group.get(g.id), groupLead(g), { group: true, drag: true })).join("")
      : `<button type="button" class="nav-empty" data-act="new-group">${icon("i-folder-plus")}Create your first group</button>`
  }</div>`;
  if (sessions.length) {
    html += `<button type="button" class="nav-head toggle" data-act="toggle-sessions" aria-expanded="${S.sessionsOpen}">${icon(
      S.sessionsOpen ? "i-chevron-down" : "i-chevron-right"
    )}<span>Sessions</span><span class="nav-count">${sessions.length}</span></button>`;
    if (S.sessionsOpen) {
      html += `<div class="nav-sec">${sessions
        .map((g) => navRow(g.id, g.name.replace(/^Session · /, ""), c.group.get(g.id), icon("i-clock", "nav-ico"), { group: true }))
        .join("")}</div>`;
    }
  }
  html += `<div class="nav-sec nav-foot">${navRow("done", "Done", c.done, icon("i-check-circle", "nav-ico"))}</div>`;
  els.nav.innerHTML = html;
}

// ===========================================================================
// Current tab card (side panel only)
// ===========================================================================

function watchCurrentTab() {
  const refresh = debounce(updateCurrentTab, 60);
  chrome.tabs.onActivated.addListener((info) => info.windowId === S.windowId && refresh());
  chrome.tabs.onUpdated.addListener((_id, change, tab) => {
    if (tab.windowId === S.windowId && tab.active && (change.url || change.title || change.status === "complete")) refresh();
  });
  updateCurrentTab();
}

async function updateCurrentTab() {
  const [tab] = await chrome.tabs.query({ active: true, windowId: S.windowId });
  S.currentTab = tab || null;
  renderCurrent();
}

function renderCurrent() {
  const el = els.current;
  if (MODE !== "panel") {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  const tab = S.currentTab;
  const url = tab?.url || tab?.pendingUrl;
  if (!tab || !isSaveable(url)) {
    el.className = "current is-empty";
    el.innerHTML = `${icon("i-bookmark")}<span>Open any page, then save it here.</span>`;
    return;
  }
  const saved = S.byKey.get(urlInfo(url).key);
  const g = saved && S.groupById.get(saved._gid);
  const target = S.groupById.get(defaultGroupId());
  const fav = /^(https?|data):/.test(tab.favIconUrl || "") ? tab.favIconUrl : favUrl(url);
  let actions;
  if (!saved) {
    const key = S.shortcuts["save-tab"];
    actions = `<div class="split"><button type="button" class="btn primary" data-cur="save" title="Save this tab${key ? ` (${escapeHtml(key)})` : ""}">${icon(
      "i-plus"
    )}<span>Save to <b>${escapeHtml(target.name)}</b></span></button><button type="button" class="btn primary caret" data-cur="pick" title="Save to another group" aria-label="Save to another group">${icon("i-chevron-down")}</button></div>`;
  } else if (saved.doneAt) {
    actions = `<span class="cur-status">${icon("i-check-circle")}In Done</span><button type="button" class="btn sm" data-cur="restore">${icon("i-undo")}Restore</button>`;
  } else {
    actions = `<span class="cur-status">${icon("i-check")}Saved in <button type="button" class="link-btn" data-cur="move" title="Move to another group">${escapeHtml(
      g.name
    )}</button></span><span class="grow"></span><button type="button" class="btn sm" data-cur="done" title="Finished with it? Move it to Done">${icon("i-check")}Done</button><button type="button" class="icon-btn sm" data-cur="more" title="More">${icon("i-more")}</button>`;
  }
  el.className = "current" + (saved ? (saved.doneAt ? " is-done" : " is-saved") : "");
  el.innerHTML = `<img class="fav" src="${escapeHtml(fav)}" alt=""><div class="cur-main"><div class="cur-title" title="${escapeHtml(url)}">${escapeHtml(
    tab.title || url
  )}</div><div class="cur-actions">${actions}</div></div>`;
}

async function saveCurrent(groupId, createdGroupId = null) {
  const tab = S.currentTab;
  const url = tab?.url || tab?.pendingUrl;
  if (!isSaveable(url)) return;
  const res = await db.saveTabs([{ url, title: tab.title }], { groupId });
  const moved = res.updated.length && res.prev[0]?.groupId !== res.groupId;
  toast(moved ? `Moved to ${res.groupName}` : `Saved to ${res.groupName}`, {
    undo: () => db.restore({ items: res.prev, removeItemIds: res.added, removeGroupIds: createdGroupId ? [createdGroupId] : [] }),
  });
}

async function onCurrentClick(e) {
  const btn = e.target.closest("[data-cur]");
  if (!btn) return;
  const tab = S.currentTab;
  const url = tab?.url || tab?.pendingUrl;
  const saved = url && S.byKey.get(urlInfo(url).key);
  switch (btn.dataset.cur) {
    case "save":
      return saveCurrent(defaultGroupId());
    case "pick": {
      const g = await chooseGroup(btn, { title: "Save to" });
      if (g) await saveCurrent(g.id, g.created ? g.id : null);
      return;
    }
    case "done":
    case "restore":
      return saved && setDone([saved.id], !saved.doneAt);
    case "move":
      return saved && moveItems([saved.id], btn);
    case "more": {
      if (!saved) return;
      const v = await openMenu(btn, [
        { label: "Move to group…", value: "move", icon: "i-folder" },
        { label: "Rename…", value: "rename", icon: "i-edit" },
        { label: "Show in list", value: "show", icon: "i-search" },
        { sep: true },
        { label: "Remove from Tab Saver", value: "delete", icon: "i-trash", danger: true },
      ]);
      if (v === "move") moveItems([saved.id], btn);
      else if (v === "rename") renameItem(saved);
      else if (v === "show") revealItem(saved.id);
      else if (v === "delete") removeItems([saved.id]);
    }
  }
}

// ===========================================================================
// Views, search, selection, keyboard cursor
// ===========================================================================

function setView(view) {
  if (!isValidView(view)) view = "all";
  const changed = view !== S.view;
  S.view = view;
  if (changed) {
    S.selected.clear();
    S.activeId = null;
    S.lastActiveIndex = 0;
  }
  closeNav();
  renderAll({ resetScroll: changed });
  persistUi();
}

function setQuery(q) {
  if (els.search.value !== q) els.search.value = q;
  if (q === S.query) return;
  S.query = q;
  S.tokens = tokenize(q);
  S.activeId = null;
  S.lastActiveIndex = 0;
  renderList({ resetScroll: true });
  renderToolbar();
  persistUi();
}

let queryFrame = 0;
function onSearchInput() {
  cancelAnimationFrame(queryFrame);
  queryFrame = requestAnimationFrame(() => setQuery(els.search.value));
}

function focusSearch() {
  closeNav();
  els.search.focus();
  els.search.select();
}

function revealItem(id) {
  const it = S.itemById.get(id);
  if (!it) return;
  setQuery("");
  setView(it.doneAt ? "done" : isHidden(it._gid) || S.groupByAll === "group" ? it._gid : "all");
  if (!S.orderIndex.has(id)) {
    // The item may sit in a folded section: unfold it.
    const g = S.groupById.get(it._gid);
    if (g?.collapsed) delete g.collapsed;
    S.folded.clear();
    renderList();
  }
  els.list.focus({ preventScroll: true });
  setActive(id, true);
}

function syncActiveAria() {
  const id = S.activeId && S.rowIndex.has(S.activeId) ? "opt-" + S.activeId : "";
  for (const el of [els.list, els.search]) {
    if (id) el.setAttribute("aria-activedescendant", id);
    else el.removeAttribute("aria-activedescendant");
  }
}

function refreshStates() {
  list.forEachRendered((el, row) => {
    if (row.t !== "item") return;
    const id = row.it.id;
    const sel = S.selected.has(id);
    el.classList.toggle("sel", sel);
    el.classList.toggle("active", id === S.activeId);
    el.setAttribute("aria-selected", sel ? "true" : "false");
  });
  renderSelbar();
}

function setActive(id, scroll = false) {
  S.activeId = id;
  if (id && S.orderIndex.has(id)) S.lastActiveIndex = S.orderIndex.get(id);
  if (scroll && id && S.rowIndex.has(id)) list.ensureVisible(S.rowIndex.get(id), S.heads.length ? HEAD_H : 0);
  refreshStates();
  syncActiveAria();
  persistUi();
}

function moveActive(delta, edge) {
  const n = S.order.length;
  if (!n) return;
  let i = S.activeId && S.orderIndex.has(S.activeId) ? S.orderIndex.get(S.activeId) : -1;
  if (edge === "start") i = 0;
  else if (edge === "end") i = n - 1;
  else if (i < 0) i = delta >= 0 ? 0 : n - 1;
  else i = Math.max(0, Math.min(n - 1, i + delta));
  setActive(S.order[i].id, true);
}

function toggleSelect(id, range = false) {
  if (range && S.anchorId && S.anchorId !== id && S.orderIndex.has(S.anchorId) && S.orderIndex.has(id)) {
    const a = S.orderIndex.get(S.anchorId);
    const b = S.orderIndex.get(id);
    for (let i = Math.min(a, b); i <= Math.max(a, b); i++) S.selected.add(S.order[i].id);
  } else {
    if (S.selected.has(id)) S.selected.delete(id);
    else S.selected.add(id);
    S.anchorId = id;
  }
  refreshStates();
}

function clearSelection() {
  S.selected.clear();
  S.anchorId = null;
  refreshStates();
}

function selectAll() {
  for (const it of S.order) S.selected.add(it.id);
  refreshStates();
}

/** What a keyboard action applies to: the selection if there is one, else the item under the cursor. */
function targets() {
  if (S.selected.size) return [...S.selected];
  return S.activeId && S.itemById.has(S.activeId) ? [S.activeId] : [];
}

function rowAnchor(id) {
  let found = null;
  list.forEachRendered((el, row) => {
    if (row.t === "item" && row.it.id === id) found = el.querySelector("[data-act=more]") || el;
  });
  return found || els.list;
}

function rememberCursor() {
  if (S.activeId && S.orderIndex.has(S.activeId)) S.lastActiveIndex = S.orderIndex.get(S.activeId);
}

function toggleFold(row) {
  if (!row) return;
  if (row.gid) {
    const g = S.groupById.get(row.gid);
    if (!g) return;
    const collapsed = !g.collapsed;
    if (collapsed) g.collapsed = true;
    else delete g.collapsed;
    db.patchGroup(row.gid, { collapsed });
  } else if (S.folded.has(row.key)) S.folded.delete(row.key);
  else S.folded.add(row.key);
  renderList();
  // Keep the header that was clicked in view.
  const i = S.rows.findIndex((r) => r.key === row.key);
  if (i >= 0 && list.offsets[i] < els.list.scrollTop) list.scrollTop = list.offsets[i];
}

function setFoldAll(fold) {
  for (const i of S.heads) {
    const row = S.rows[i];
    if (row.gid) {
      const g = S.groupById.get(row.gid);
      if (!g || !!g.collapsed === fold) continue;
      if (fold) g.collapsed = true;
      else delete g.collapsed;
      db.patchGroup(row.gid, { collapsed: fold });
    } else if (fold) S.folded.add(row.key);
    else S.folded.delete(row.key);
  }
  renderList({ resetScroll: true });
}

// ===========================================================================
// Actions on saved tabs
// ===========================================================================

const isBlankTab = (t) => /^[a-z-]+:\/\/(newtab|new-tab-page)\/?$/i.test(t?.url || t?.pendingUrl || "");

async function openOne(it, { background = false } = {}) {
  try {
    const win = await chrome.windows.getCurrent();
    const tabs = await chrome.tabs.query({ windowId: win.id });
    const already = tabs.find((t) => urlInfo(t.url || t.pendingUrl || "").key === it._key);
    const current = tabs.find((t) => t.active);
    if (already && !background) {
      await chrome.tabs.update(already.id, { active: true });
    } else if (!background && current && isBlankTab(current)) {
      await chrome.tabs.update(current.id, { url: it.url });
    } else {
      // openerTabId: closing the new tab brings you straight back here.
      await chrome.tabs.create({ windowId: win.id, url: it.url, active: !background, ...(current ? { openerTabId: current.id } : {}) });
    }
  } catch (e) {
    console.error(e);
    toast("Couldn't open that tab");
    return;
  }
  await markOpened([it.id]);
  if (background && S.prefs.onOpen !== "done") toast("Opened in a background tab");
}

async function markOpened(ids) {
  const now = Date.now();
  const toDone = S.prefs.onOpen === "done";
  const { prev } = await db.patchItems(ids, (it) => (toDone && !it.doneAt ? { openedAt: now, doneAt: now } : { openedAt: now }));
  if (toDone && prev.some((p) => !p.doneAt)) {
    toast(ids.length === 1 ? "Opened and moved to Done" : `Opened ${ids.length} tabs and moved them to Done`, { undo: () => db.restore({ items: prev }) });
  }
}

async function openMany(items) {
  if (!items.length) return false;
  if (
    items.length > OPEN_MANY_CONFIRM &&
    !(await confirmAction({ title: `Open ${items.length} tabs?`, text: "They open in the background, in a Chrome tab group per Tab Saver group.", ok: `Open ${items.length} tabs` }))
  ) {
    return false;
  }
  const win = await chrome.windows.getCurrent();
  const byGroup = new Map();
  for (const it of items) {
    if (!byGroup.has(it._gid)) byGroup.set(it._gid, []);
    byGroup.get(it._gid).push(it);
  }
  for (const [gid, groupItems] of byGroup) {
    const tabIds = [];
    for (const it of groupItems) {
      const t = await chrome.tabs.create({ windowId: win.id, url: it.url, active: false }).catch(() => null);
      if (t) tabIds.push(t.id);
    }
    if (!tabIds.length) continue;
    try {
      const chromeGroup = await chrome.tabs.group({ tabIds, createProperties: { windowId: win.id } });
      const g = S.groupById.get(gid);
      await chrome.tabGroups.update(chromeGroup, { title: g?.name || "Tab Saver", color: GROUP_COLORS.includes(g?.color) ? g.color : "grey" });
    } catch {
      /* tab groups unavailable: tabs are still open */
    }
  }
  await markOpened(items.map((it) => it.id));
  if (S.prefs.onOpen !== "done") toast(`Opened ${plural(items.length, "tab")}`);
  return true;
}

function openGroup(gid) {
  const items = S.items.filter((it) => it._gid === gid && !it.doneAt);
  if (!items.length) return toast("Nothing to open in this group");
  db.patchGroup(gid, { openedAt: Date.now() });
  return openMany(items);
}

async function setDone(ids, done) {
  const items = ids.map((id) => S.itemById.get(id)).filter(Boolean);
  if (!items.length) return false;
  rememberCursor();
  const { prev } = await db.patchItems(
    items.map((it) => it.id),
    done ? (it) => (it.doneAt ? {} : { doneAt: Date.now() }) : { doneAt: null }
  );
  const what = items.length === 1 ? `“${shorten(items[0].title, 40)}”` : plural(items.length, "tab");
  toast(done ? `${what} moved to Done` : `${what} restored`, { undo: () => db.restore({ items: prev }) });
  return true;
}

function toggleDone(ids) {
  const items = ids.map((id) => S.itemById.get(id)).filter(Boolean);
  return setDone(ids, items.some((it) => !it.doneAt));
}

async function removeItems(ids) {
  if (!ids.length) return false;
  rememberCursor();
  const { prev } = await db.deleteItems(ids);
  if (!prev.length) return false;
  toast(prev.length === 1 ? `Deleted “${shorten(prev[0].title, 40)}”` : `Deleted ${plural(prev.length, "tab")}`, { undo: () => db.restore({ items: prev }) });
  return true;
}

async function chooseGroup(anchor, { title, currentId = null }) {
  const groups = S.groups.filter((g) => g.kind !== "session" || g.id === currentId);
  const pick = await pickGroup(anchor, { title, groups, currentId });
  if (!pick) return null;
  if (pick.create) {
    const g = await db.createGroup(pick.create);
    return { id: g.id, name: g.name, created: g.created };
  }
  const g = S.groupById.get(pick.id);
  return g ? { id: g.id, name: g.name, created: false } : null;
}

async function moveItems(ids, anchor) {
  const items = ids.map((id) => S.itemById.get(id)).filter(Boolean);
  if (!items.length) return false;
  const current = items.every((it) => it._gid === items[0]._gid) ? items[0]._gid : null;
  const target = await chooseGroup(anchor, { title: items.length === 1 ? "Move to" : `Move ${items.length} tabs to`, currentId: current });
  if (!target || target.id === current) return false;
  rememberCursor();
  const { prev } = await db.patchItems(
    items.map((it) => it.id),
    { groupId: target.id }
  );
  toast(`Moved ${plural(items.length, "tab")} to ${target.name}`, {
    undo: () => db.restore({ items: prev, removeGroupIds: target.created ? [target.id] : [] }),
  });
  return true;
}

async function renameItem(it) {
  const title = await promptText({ title: "Rename saved tab", value: it.title, okLabel: "Rename", maxLength: 300 });
  if (!title || title === it.title) return;
  const { prev } = await db.patchItems([it.id], { title });
  toast("Renamed", { undo: () => db.restore({ items: prev }) });
}

async function copyLinks(ids) {
  const items = ids.map((id) => S.itemById.get(id)).filter(Boolean);
  if (!items.length) return;
  try {
    await navigator.clipboard.writeText(items.map((it) => it.url).join("\n"));
    toast(items.length === 1 ? "Link copied" : `${items.length} links copied`);
  } catch {
    toast("Couldn't copy to the clipboard");
  }
}

async function bulk(action, anchor) {
  const ids = [...S.selected];
  if (!ids.length) return;
  let done = false;
  if (action === "open") done = await openMany(ids.map((id) => S.itemById.get(id)).filter(Boolean));
  else if (action === "move") done = await moveItems(ids, anchor);
  else if (action === "done") done = await toggleDone(ids);
  else if (action === "delete") done = await removeItems(ids);
  else if (action === "copy") {
    await copyLinks(ids);
    return;
  }
  if (done) clearSelection();
}

async function itemMenu(it, anchor) {
  if (S.selected.size > 1 && S.selected.has(it.id)) return selectionMenu(anchor);
  const inDone = !!it.doneAt;
  const v = await openMenu(anchor, [
    { label: "Open", value: "open", icon: "i-external", hint: "Enter", key: "o" },
    { label: "Open in background", value: "bg", icon: "i-arrow-up-right", hint: "Ctrl+Enter", key: "b" },
    { label: "Copy link", value: "copy", icon: "i-link", hint: "C", key: "c" },
    { sep: true },
    { label: inDone ? "Restore from Done" : "Done with it", value: "done", icon: inDone ? "i-undo" : "i-check", hint: "E", key: "e" },
    { label: "Move to group…", value: "move", icon: "i-folder", hint: "M", key: "m" },
    { label: "Rename…", value: "rename", icon: "i-edit", hint: "R", key: "r" },
    { label: S.selected.has(it.id) ? "Unselect" : "Select", value: "select", icon: "i-check-square", hint: "X", key: "x" },
    { sep: true },
    { label: "Delete", value: "delete", icon: "i-trash", hint: "Del", danger: true },
  ]);
  if (v === "open") openOne(it);
  else if (v === "bg") openOne(it, { background: true });
  else if (v === "copy") copyLinks([it.id]);
  else if (v === "done") setDone([it.id], !inDone);
  else if (v === "move") moveItems([it.id], anchor);
  else if (v === "rename") renameItem(it);
  else if (v === "select") toggleSelect(it.id);
  else if (v === "delete") removeItems([it.id]);
}

async function selectionMenu(anchor) {
  const n = S.selected.size;
  const v = await openMenu(anchor, [
    { label: `Open ${n} tabs`, value: "open", icon: "i-external" },
    { label: "Move to group…", value: "move", icon: "i-folder", hint: "M", key: "m" },
    { label: "Done with them", value: "done", icon: "i-check", hint: "E", key: "e" },
    { label: "Copy links", value: "copy", icon: "i-link", hint: "C", key: "c" },
    { sep: true },
    { label: `Delete ${n} tabs`, value: "delete", icon: "i-trash", hint: "Del", danger: true },
  ]);
  if (v) bulk(v, anchor);
}

// ===========================================================================
// Groups
// ===========================================================================

function groupMenuItems(g) {
  const n = S.counts.group.get(g.id) || 0;
  return [
    { label: n ? `Open all ${n} as a tab group` : "Open all", value: "g:open", icon: "i-external", disabled: !n },
    { label: "Rename…", value: "g:rename", icon: "i-edit" },
    { swatches: GROUP_COLORS, current: g.color || "grey" },
    { label: g.private ? "Stop hiding titles" : "Hide titles (private)", value: "g:private", icon: g.private ? "i-eye" : "i-lock" },
    ...(g.private ? [{ label: S.revealed.has(g.id) ? "Hide titles again" : "Show titles for now", value: "g:reveal", icon: "i-eye" }] : []),
    ...(g.kind === "session" ? [{ label: "Keep as a regular group", value: "g:promote", icon: "i-folder" }] : []),
    ...(g.id !== UNSORTED ? [{ sep: true }, { label: "Delete group…", value: "g:delete", icon: "i-trash", danger: true }] : []),
  ];
}

async function groupMenu(gid, anchor) {
  const g = S.groupById.get(gid);
  if (g) handleGroupChoice(g, await openMenu(anchor, groupMenuItems(g), { label: g.name }));
}

async function handleGroupChoice(g, v) {
  if (!v) return;
  if (v.startsWith("color:")) return db.patchGroup(g.id, { color: v.slice(6) });
  switch (v) {
    case "g:open":
      return openGroup(g.id);
    case "g:rename":
      return renameGroup(g);
    case "g:private":
      S.revealed.delete(g.id);
      await db.patchGroup(g.id, { private: !g.private });
      return toast(g.private ? `“${g.name}” titles are visible again` : `“${g.name}” is private: its titles are hidden and it's left out of All saved`);
    case "g:reveal":
      if (S.revealed.has(g.id)) S.revealed.delete(g.id);
      else S.revealed.add(g.id);
      applyState({ items: S.items, groups: S.groups, prefs: S.prefs });
      return renderAll();
    case "g:promote":
      await db.patchGroup(g.id, { kind: null, collapsed: null, name: g.name.replace(/^Session · /, "Session ") });
      return toast("Moved to your groups");
    case "g:delete":
      return deleteGroupFlow(g);
  }
}

async function newGroup() {
  closeNav();
  const name = await promptText({
    title: "New group",
    placeholder: "e.g. Watch later",
    okLabel: "Create group",
    maxLength: 60,
    validate: (v) => (db.findGroupByName(S.groups, v) ? "You already have a group with that name." : ""),
  });
  if (!name) return;
  const g = await db.createGroup(name);
  await refreshFromStorage();
  setView(g.id);
}

async function renameGroup(g) {
  const name = await promptText({
    title: "Rename group",
    value: g.name,
    okLabel: "Rename",
    maxLength: 60,
    validate: (v) => {
      const other = db.findGroupByName(S.groups, v);
      return other && other.id !== g.id ? "Another group already has that name." : "";
    },
  });
  if (!name || name === g.name) return;
  const res = await db.patchGroup(g.id, { name });
  if (res) toast(`Renamed to ${name}`, { undo: () => db.patchGroup(g.id, { name: res.prev.name }) });
}

async function deleteGroupFlow(g) {
  const total = S.counts.total.get(g.id) || 0;
  const unsortedName = escapeHtml(S.groupById.get(UNSORTED).name);
  const choice = await openDialog({
    title: `Delete “${g.name}”?`,
    body: `<p class="dlg-text">${total ? `It has ${plural(total, "saved tab")}. Keep them (they move to ${unsortedName}) or delete them as well.` : "This group is empty."}</p>`,
    buttons: [
      { label: "Cancel", value: "" },
      ...(total ? [{ label: `Delete the ${plural(total, "tab")} too`, value: "all", kind: "danger-ghost" }] : []),
      { label: total ? "Delete group, keep tabs" : "Delete group", value: "keep", kind: "danger" },
    ],
  });
  if (!choice) return;
  const res = await db.deleteGroup(g.id, { withItems: choice === "all" });
  if (!res) return;
  if (S.view === g.id) setView("all");
  toast(`Deleted “${g.name}”`, { undo: () => db.restore({ groups: [{ group: res.group, index: res.index }], items: res.prev }) });
}

// ===========================================================================
// Toolbar menus
// ===========================================================================

async function viewOptions(anchor) {
  const inAll = S.view === "all";
  const gb = inAll ? S.groupByAll : S.groupByGroup;
  const dateLabel = S.view === "done" ? "Date finished" : "Date saved";
  const v = await openMenu(
    anchor,
    [
      { header: "Group by" },
      ...(inAll ? [{ label: "Group", value: "g:group", checked: gb === "group" }] : []),
      { label: dateLabel, value: "g:date", checked: gb === "date" },
      { label: "Website", value: "g:site", checked: gb === "site" },
      { label: "Nothing", value: "g:none", checked: gb === "none" },
      { sep: true },
      { header: "Sort" },
      { label: "Newest first", value: "s:newest", checked: S.sort === "newest" },
      { label: "Oldest first", value: "s:oldest", checked: S.sort === "oldest" },
      { label: "Title (A to Z)", value: "s:title", checked: S.sort === "title" },
    ],
    { label: "View options" }
  );
  if (!v) return;
  const [kind, value] = v.split(":");
  if (kind === "g") {
    if (inAll) S.groupByAll = value;
    else S.groupByGroup = value;
  } else S.sort = value;
  renderToolbar();
  renderList({ resetScroll: true });
  persistUi();
}

async function viewMenu(anchor) {
  const g = S.groupById.get(S.view);
  const items = g ? [...groupMenuItems(g), { sep: true }] : [];
  if (S.view === "done") items.push({ label: "Delete everything in Done…", value: "clear-done", icon: "i-trash", danger: true, disabled: !S.counts.done }, { sep: true });
  items.push({ label: "Select all", value: "select-all", icon: "i-check-square", hint: "Ctrl+A", disabled: !S.order.length });
  if (S.heads.length > 1) {
    items.push({ label: "Collapse all sections", value: "fold", icon: "i-chevron-right" }, { label: "Expand all sections", value: "unfold", icon: "i-chevron-down" });
  }
  items.push({ sep: true }, { label: "Keyboard shortcuts", value: "keys", icon: "i-keyboard", hint: "?" });
  const v = await openMenu(anchor, items);
  if (!v) return;
  if (g && (v.startsWith("g:") || v.startsWith("color:"))) return handleGroupChoice(g, v);
  if (v === "select-all") selectAll();
  else if (v === "fold") setFoldAll(true);
  else if (v === "unfold") setFoldAll(false);
  else if (v === "keys") showKeys();
  else if (v === "clear-done") clearDone();
}

async function clearDone() {
  const ids = S.items.filter((it) => it.doneAt).map((it) => it.id);
  if (!ids.length) return;
  const ok = await confirmAction({ title: `Delete ${plural(ids.length, "tab")} in Done?`, text: "You can undo this right after.", ok: "Delete", danger: true });
  if (ok) removeItems(ids);
}

function showKeys() {
  const rows = [
    ["/", "Search (also Ctrl+K)"],
    ["↑ ↓", "Move through the list"],
    ["Enter", "Open"],
    ["Ctrl + Enter", "Open in a background tab"],
    ["E", "Done with it (or restore)"],
    ["X", "Select (Shift for a range)"],
    ["Ctrl + A", "Select all"],
    ["M", "Move to a group"],
    ["R", "Rename"],
    ["C", "Copy link"],
    ["Delete", "Delete"],
    ["Ctrl + Z", "Undo"],
    ["Esc", "Clear selection, then search"],
  ];
  const global = [
    [S.shortcuts["save-tab"], "Save the current tab (anywhere in Chrome)"],
    [S.shortcuts["open-tab-saver"], "Open Tab Saver (anywhere in Chrome)"],
  ].filter(([k]) => k);
  openDialog({
    title: "Keyboard shortcuts",
    body: `<div class="keys">${[...global, ...rows].map(([k, d]) => `<div class="kv"><span>${escapeHtml(d)}</span><kbd>${escapeHtml(k)}</kbd></div>`).join("")}</div>`,
    buttons: [{ label: "Close", value: "ok", kind: "primary" }],
  });
}

// ===========================================================================
// Save open tabs
// ===========================================================================

async function saveWindowDialog() {
  const win = await chrome.windows.getCurrent({ populate: true });
  const rows = (win.tabs || [])
    .filter((t) => isSaveable(t.url || t.pendingUrl))
    .map((t) => {
      const url = t.url || t.pendingUrl;
      const ex = S.byKey.get(urlInfo(url).key);
      return { tab: t, url, saved: !!ex && !ex.doneAt };
    });
  if (!rows.length) return toast("There are no tabs here to save");

  const stamp = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(Date.now());
  const names = S.groups
    .filter((g) => g.kind !== "session")
    .map((g) => `<option value="${escapeHtml(g.name)}"></option>`)
    .join("");
  const body = `
    <label class="field"><span class="field-label">Save to group</span>
      <input type="text" class="input" data-name value="${escapeHtml("Saved " + stamp)}" list="ts-group-names" maxlength="60" autocomplete="off" spellcheck="false">
      <datalist id="ts-group-names">${names}</datalist>
    </label>
    <p class="field-hint" data-hint></p>
    <div class="tabpick">
      <label class="tabpick-all"><input type="checkbox" data-all><span>Tabs in this window</span><span class="muted" data-count></span></label>
      <div class="tabpick-list">${rows
        .map(
          (r, i) =>
            `<label class="tabpick-row"><input type="checkbox" data-i="${i}"${r.saved ? "" : " checked"}><img class="fav" src="${favUrl(r.url)}" alt=""><span class="tp-title">${escapeHtml(
              r.tab.title || r.url
            )}</span>${r.saved ? `<span class="tp-tag" title="Already in Tab Saver. Tick it to move it into this group.">saved</span>` : ""}</label>`
        )
        .join("")}</div>
    </div>
    <label class="check"><input type="checkbox" data-close><span>Close these tabs after saving</span></label>`;

  let picked = [];
  let groupName = "";
  let closeAfter = false;
  const choice = await openDialog({
    title: "Save open tabs",
    wide: true,
    body,
    buttons: [
      { label: "Cancel", value: "" },
      { label: "Save", value: "save", kind: "primary" },
    ],
    init: (dlg) => {
      const input = dlg.querySelector("[data-name]");
      const hint = dlg.querySelector("[data-hint]");
      const boxes = [...dlg.querySelectorAll("[data-i]")];
      const all = dlg.querySelector("[data-all]");
      const saveBtn = dlg.querySelector('.dlg-foot [data-value="save"]');
      const update = () => {
        const n = boxes.filter((b) => b.checked).length;
        all.checked = n === boxes.length;
        all.indeterminate = n > 0 && n < boxes.length;
        dlg.querySelector("[data-count]").textContent = `${n} of ${boxes.length} selected`;
        saveBtn.textContent = n ? `Save ${plural(n, "tab")}` : "Save";
        saveBtn.disabled = !n;
        const existing = db.findGroupByName(S.groups, input.value);
        hint.textContent = !input.value.trim() ? "" : existing ? `Adds them to your existing group “${existing.name}”.` : "Creates a new group.";
      };
      all.addEventListener("change", () => {
        boxes.forEach((b) => (b.checked = all.checked));
        update();
      });
      dlg.addEventListener("change", (e) => e.target.matches("[data-i]") && update());
      input.addEventListener("input", update);
      update();
      input.focus();
      input.select();
    },
    validate: (_v, dlg) => {
      groupName = dlg.querySelector("[data-name]").value.trim();
      if (!groupName) return "Give the group a name.";
      picked = [...dlg.querySelectorAll("[data-i]")].filter((b) => b.checked).map((b) => rows[Number(b.dataset.i)]);
      if (!picked.length) return "Pick at least one tab.";
      closeAfter = dlg.querySelector("[data-close]").checked;
      return "";
    },
  });
  if (choice !== "save") return;

  const res = await db.saveTabs(
    picked.map((r) => ({ url: r.url, title: r.tab.title })),
    { groupName, existing: "move" }
  );
  if (closeAfter) {
    const ids = picked.map((r) => r.tab.id);
    if ((win.tabs || []).every((t) => ids.includes(t.id))) await chrome.tabs.create({ windowId: win.id });
    await chrome.tabs.remove(ids).catch(() => {});
  }
  await refreshFromStorage();
  setView(res.groupId);
  const n = res.added.length + res.updated.length;
  toast(
    `Saved ${plural(n, "tab")} to ${res.groupName}${closeAfter ? " and closed them" : ""}`,
    closeAfter ? {} : { undo: () => db.restore({ items: res.prev, removeItemIds: res.added, removeGroupIds: res.createdGroup ? [res.createdGroup] : [] }) }
  );
}

// ===========================================================================
// Settings, backup
// ===========================================================================

async function openSettings() {
  const [bytes, cmds] = await Promise.all([chrome.storage.local.getBytesInUse(null).catch(() => 0), chrome.commands.getAll().catch(() => [])]);
  for (const c of cmds) S.shortcuts[c.name] = c.shortcut || "";
  const p = S.prefs;
  const size = bytes < 1048576 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1048576).toFixed(1)} MB`;
  const groupCount = S.groups.filter((g) => g.kind !== "session" && g.id !== UNSORTED).length;
  const body = `
    <section class="set">
      <h3>When I open a saved tab</h3>
      <label class="radio"><input type="radio" name="onOpen" value="keep"${p.onOpen !== "done" ? " checked" : ""}><span><b>Keep it in my list</b><small>It gets an "opened" note so you know you've been there.</small></span></label>
      <label class="radio"><input type="radio" name="onOpen" value="done"${p.onOpen === "done" ? " checked" : ""}><span><b>Move it to Done</b><small>Your list only shows what you haven't opened yet. Done stays searchable.</small></span></label>
    </section>
    <section class="set">
      <h3>Sessions</h3>
      <label class="switch"><input type="checkbox" name="autoSave"${p.autoSave ? " checked" : ""}><span class="track"></span><span><b>Save my open tabs when Chrome restarts</b><small>Each time Chrome starts, the tabs you had open last time are filed under Sessions.</small></span></label>
    </section>
    <section class="set">
      <h3>Shortcuts</h3>
      <div class="kv"><span>Save the current tab</span><kbd>${escapeHtml(S.shortcuts["save-tab"] || "Not set")}</kbd></div>
      <div class="kv"><span>Open Tab Saver</span><kbd>${escapeHtml(S.shortcuts["open-tab-saver"] || "Not set")}</kbd></div>
      <div class="set-actions"><button type="button" class="btn" data-set="shortcuts">Change shortcuts</button><button type="button" class="btn ghost" data-set="keys">${icon("i-keyboard")}Keys inside Tab Saver</button></div>
    </section>
    <section class="set">
      <h3>Backup</h3>
      <p class="muted">${plural(S.items.length - S.counts.done, "saved tab")}, ${S.counts.done} done, ${plural(groupCount, "group")}. Using ${size}.</p>
      <div class="set-actions"><button type="button" class="btn" data-set="export">${icon("i-download")}Export backup</button><button type="button" class="btn" data-set="import">${icon(
        "i-upload"
      )}Import backup</button><input type="file" accept=".json,application/json" hidden data-file></div>
    </section>
    <section class="set danger-zone">
      <h3>Danger zone</h3>
      <div class="set-actions"><button type="button" class="btn danger-ghost" data-set="wipe">${icon("i-trash")}Delete everything…</button></div>
    </section>`;

  await openDialog({
    title: "Settings",
    wide: true,
    body,
    buttons: [{ label: "Done", value: "ok", kind: "primary" }],
    init: (dlg, { close }) => {
      dlg.addEventListener("change", async (e) => {
        const t = e.target;
        if (t.name === "onOpen") {
          await db.setPrefs({ onOpen: t.value });
          toast("Saved");
        } else if (t.name === "autoSave") {
          await db.setPrefs({ autoSave: t.checked });
          toast(t.checked ? "Sessions will be saved when Chrome restarts" : "Session saving is off");
        } else if (t.matches("[data-file]")) {
          const file = t.files[0];
          t.value = "";
          if (file) {
            close(null);
            importFlow(file);
          }
        }
      });
      dlg.addEventListener("click", (e) => {
        const a = e.target.closest("[data-set]")?.dataset.set;
        if (a === "shortcuts") chrome.tabs.create({ url: "chrome://extensions/shortcuts" });
        else if (a === "keys") {
          close(null);
          showKeys();
        } else if (a === "export") exportFlow();
        else if (a === "import") dlg.querySelector("[data-file]").click();
        else if (a === "wipe") {
          close(null);
          wipeFlow();
        }
      });
      dlg.querySelector(".dlg-foot .primary")?.focus();
    },
  });
}

async function exportFlow() {
  const data = await db.exportData();
  const blob = new Blob([JSON.stringify(data, null, 1)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `tab-saver-backup-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  toast("Backup downloaded");
}

async function importFlow(file) {
  let parsed;
  try {
    parsed = db.parseBackup(JSON.parse(await file.text()));
  } catch (e) {
    return toast(e instanceof SyntaxError ? "That file isn't valid JSON" : e.message || "Couldn't read that file");
  }
  const groupCount = parsed.groups.filter((g) => g.id !== UNSORTED).length;
  const choice = await openDialog({
    title: "Import backup",
    body: `<p class="dlg-text">This file has ${plural(parsed.items.length, "saved tab")} in ${plural(groupCount, "group")}. Tabs you already have are skipped.</p>`,
    buttons: [
      { label: "Cancel", value: "" },
      { label: "Replace everything", value: "replace", kind: "danger-ghost" },
      { label: "Add to my tabs", value: "merge", kind: "primary" },
    ],
  });
  if (!choice) return;
  if (
    choice === "replace" &&
    !(await confirmAction({ title: "Replace everything?", text: `This deletes your ${plural(S.items.length, "saved tab")} and loads the backup instead.`, ok: "Replace", danger: true }))
  ) {
    return;
  }
  const res = await db.importBackup(parsed, choice);
  toast(`Imported ${plural(res.added, "tab")}${res.skipped ? ` (${res.skipped} already saved)` : ""}`);
}

async function wipeFlow() {
  const typed = await promptText({
    title: "Delete everything?",
    text: `This permanently deletes all ${plural(S.items.length, "saved tab")} and every group. Export a backup first if you might want them. Type <b>DELETE</b> to confirm.`,
    placeholder: "DELETE",
    okLabel: "Delete everything",
    danger: true,
    validate: (v) => (v === "DELETE" ? "" : "Type DELETE in capitals to confirm."),
  });
  if (typed !== "DELETE") return;
  await db.wipeAll();
  setView("all");
  toast("Everything was deleted");
}

// ===========================================================================
// Side panel / full page switching and the groups drawer
// ===========================================================================

function setupSurfaceButton() {
  const btn = els.switchSurfaceBtn;
  if (MODE === "page") {
    if (!chrome.sidePanel?.open) return (btn.hidden = true);
    btn.title = "Open in the side panel";
    btn.innerHTML = icon("i-sidebar");
  }
}

async function switchSurface() {
  if (MODE === "page") {
    // Must be called synchronously from the click to count as a user gesture.
    chrome.sidePanel.open({ windowId: S.windowId }).catch(() => toast("Click the Tab Saver icon in the toolbar to open the side panel"));
    return;
  }
  const tabs = await chrome.tabs.query({});
  const open = tabs.find((t) => t.url?.startsWith(APP_URL) && t.url.includes("mode=page"));
  if (open) {
    await chrome.tabs.update(open.id, { active: true });
    await chrome.windows.update(open.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url: APP_URL + "?mode=page", windowId: S.windowId });
  }
}

function openNav() {
  if (wideLayout.matches) return;
  els.app.classList.add("nav-open");
  els.scrim.hidden = false;
  els.navToggle.setAttribute("aria-expanded", "true");
  (els.nav.querySelector(".nav-row.on .nav-item") || els.nav.querySelector(".nav-item"))?.focus();
}

function closeNav() {
  if (!els.app.classList.contains("nav-open")) return;
  els.app.classList.remove("nav-open");
  els.scrim.hidden = true;
  els.navToggle.setAttribute("aria-expanded", "false");
}

// ===========================================================================
// Events
// ===========================================================================

function bindEvents() {
  els.search.addEventListener("input", onSearchInput);
  els.search.addEventListener("keydown", onSearchKeydown);
  els.list.addEventListener("click", onListClick);
  els.list.addEventListener("auxclick", onListAuxClick);
  els.list.addEventListener("mousedown", (e) => e.button === 1 && e.target.closest(".row.item") && e.preventDefault());
  els.list.addEventListener("contextmenu", onListContextMenu);
  els.list.addEventListener("keydown", onListKeydown);
  els.list.addEventListener("dragstart", onItemDragStart);
  els.list.addEventListener("dragend", () => els.app.classList.remove("dragging-items"));
  els.list.addEventListener("focus", () => {
    if (!S.activeId && S.order.length) setActive(S.order[0].id);
  });
  els.sticky.addEventListener("click", onStickyClick);
  els.empty.addEventListener("click", onEmptyClick);

  els.nav.addEventListener("click", onNavClick);
  els.nav.addEventListener("contextmenu", (e) => {
    const row = e.target.closest(".nav-row[data-group]");
    if (!row) return;
    e.preventDefault();
    groupMenu(row.dataset.group, { x: e.clientX, y: e.clientY });
  });
  bindNavDragAndDrop();

  els.navToggle.addEventListener("click", openNav);
  els.scrim.addEventListener("click", closeNav);
  els.viewBtn.addEventListener("click", () => (wideLayout.matches ? null : openNav()));
  els.optionsBtn.addEventListener("click", () => viewOptions(els.optionsBtn));
  els.viewMenuBtn.addEventListener("click", () => viewMenu(els.viewMenuBtn));
  els.saveWindowBtn.addEventListener("click", saveWindowDialog);
  els.switchSurfaceBtn.addEventListener("click", switchSurface);
  els.settingsBtn.addEventListener("click", openSettings);
  els.current.addEventListener("click", onCurrentClick);

  els.selClear.addEventListener("click", clearSelection);
  els.selAll.addEventListener("click", selectAll);
  els.selbar.addEventListener("click", (e) => {
    const b = e.target.closest("[data-bulk]");
    if (b) bulk(b.dataset.bulk, b);
  });

  document.addEventListener("keydown", onDocKeydown);
  // Favicons that fail to load (rare) fall back to a globe.
  document.addEventListener(
    "error",
    (e) => {
      const img = e.target;
      if (img?.tagName !== "IMG" || !img.classList.contains("fav") || img.dataset.failed) return;
      img.dataset.failed = "1";
      const fallback = document.createElement("span");
      fallback.className = "fav fav-fallback";
      fallback.innerHTML = icon("i-globe");
      img.replaceWith(fallback);
    },
    true
  );
  wideLayout.addEventListener("change", () => {
    closeNav();
    renderToolbar();
  });
  addEventListener("pagehide", () => persistUi.now());
  document.addEventListener("visibilitychange", () => document.visibilityState === "hidden" && persistUi.now());
}

function onSearchKeydown(e) {
  if (e.isComposing) return;
  const mod = e.ctrlKey || e.metaKey;
  if (e.key === "ArrowDown") {
    e.preventDefault();
    if (S.query !== els.search.value) setQuery(els.search.value);
    if (!S.order.length) return;
    els.list.focus({ preventScroll: true });
    if (!S.activeId || !S.orderIndex.has(S.activeId)) moveActive(0, "start");
    else setActive(S.activeId, true);
  } else if (e.key === "Enter") {
    e.preventDefault();
    if (S.query !== els.search.value) setQuery(els.search.value);
    const it = S.searching && S.activeId ? S.itemById.get(S.activeId) : null;
    if (it) openOne(it, { background: mod || e.shiftKey });
  } else if (e.key === "Escape") {
    e.preventDefault();
    if (els.search.value) setQuery("");
    else if (S.order.length) els.list.focus();
  }
}

function onDocKeydown(e) {
  if (e.defaultPrevented || e.isComposing) return;
  if (document.querySelector("dialog[open]")) return;
  const typing = e.target.matches?.("input, textarea, select, [contenteditable='true']");
  const mod = e.ctrlKey || e.metaKey;
  const key = e.key.toLowerCase();
  if ((!typing && e.key === "/") || (mod && !e.shiftKey && !e.altKey && (key === "k" || key === "f"))) {
    e.preventDefault();
    focusSearch();
  } else if (mod && key === "z" && !e.shiftKey && !typing) {
    e.preventDefault();
    runUndo();
  } else if (typing) {
    return;
  } else if (e.key === "?") {
    e.preventDefault();
    showKeys();
  } else if (e.key === "Escape") {
    if (els.app.classList.contains("nav-open")) closeNav();
    else if (S.selected.size) clearSelection();
    else return;
    e.preventDefault();
  }
}

function onListKeydown(e) {
  if (e.isComposing || e.altKey) return;
  const mod = e.ctrlKey || e.metaKey;
  const active = S.activeId ? S.itemById.get(S.activeId) : null;
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  const after = (p) => p.then((did) => did && S.selected.size && clearSelection());
  if (mod) {
    if (key === "Enter" && active) openOne(active, { background: true });
    else if (key === "a") selectAll();
    else if (key === "c") copyLinks(targets());
    else return;
    e.preventDefault();
    return;
  }
  switch (key) {
    case "ArrowDown":
    case "j":
      moveActive(1);
      break;
    case "ArrowUp":
    case "k":
      if (!active || S.orderIndex.get(S.activeId) === 0) focusSearch();
      else moveActive(-1);
      break;
    case "Home":
      moveActive(0, "start");
      break;
    case "End":
      moveActive(0, "end");
      break;
    case "PageDown":
      moveActive(Math.max(1, Math.floor(list.viewport / ROW_H) - 1));
      break;
    case "PageUp":
      moveActive(-Math.max(1, Math.floor(list.viewport / ROW_H) - 1));
      break;
    case "Enter":
    case "o":
      if (active) openOne(active, { background: e.shiftKey });
      break;
    case " ":
    case "x":
      if (active) toggleSelect(active.id, e.shiftKey);
      break;
    case "e":
      after(toggleDone(targets()));
      break;
    case "Delete":
    case "Backspace":
    case "#":
      after(removeItems(targets()));
      break;
    case "m":
      after(moveItems(targets(), active ? rowAnchor(active.id) : els.list));
      break;
    case "r":
    case "F2":
      if (active) renameItem(active);
      break;
    case "c":
      copyLinks(targets());
      break;
    case "Escape":
      if (S.selected.size) clearSelection();
      else focusSearch();
      break;
    case "ContextMenu":
      if (active) itemMenu(active, rowAnchor(active.id));
      break;
    case "F10":
      if (e.shiftKey && active) itemMenu(active, rowAnchor(active.id));
      else return;
      break;
    default:
      return;
  }
  e.preventDefault();
  e.stopPropagation();
}

function onListClick(e) {
  const el = e.target.closest(".row");
  if (!el?.__row) return;
  const row = el.__row;
  const act = e.target.closest("[data-act]")?.dataset.act;
  if (row.t === "hint") return setView("done");
  if (row.t === "head") {
    if (act === "open-group") openGroup(row.gid);
    else if (act === "group-menu") groupMenu(row.gid, e.target.closest("[data-act]"));
    else toggleFold(row);
    return;
  }
  const it = row.it;
  if (act === "pick" || e.shiftKey) {
    setActive(it.id);
    return toggleSelect(it.id, e.shiftKey);
  }
  setActive(it.id);
  if (act === "done") setDone([it.id], !it.doneAt);
  else if (act === "bg") openOne(it, { background: true });
  else if (act === "more") itemMenu(it, e.target.closest("[data-act]"));
  else if (S.selected.size && !(e.ctrlKey || e.metaKey)) toggleSelect(it.id);
  else openOne(it, { background: e.ctrlKey || e.metaKey });
}

function onListAuxClick(e) {
  if (e.button !== 1) return;
  const row = e.target.closest(".row.item")?.__row;
  if (!row) return;
  e.preventDefault();
  openOne(row.it, { background: true });
}

function onListContextMenu(e) {
  const row = e.target.closest(".row")?.__row;
  if (!row) return;
  e.preventDefault();
  const point = { x: e.clientX, y: e.clientY };
  if (row.t === "item") {
    setActive(row.it.id);
    itemMenu(row.it, point);
  } else if (row.t === "head" && row.gid) groupMenu(row.gid, point);
}

function onStickyClick(e) {
  const row = els.sticky.__row;
  if (!row) return;
  const act = e.target.closest("[data-act]")?.dataset.act;
  if (act === "open-group") openGroup(row.gid);
  else if (act === "group-menu") groupMenu(row.gid, e.target.closest("[data-act]"));
  else toggleFold(row);
}

function onEmptyClick(e) {
  const act = e.target.closest("[data-act]")?.dataset.act;
  if (act === "search-done") setView("done");
  else if (act === "search-all") setView("all");
}

function onNavClick(e) {
  const more = e.target.closest("[data-group-menu]");
  if (more) return groupMenu(more.dataset.groupMenu, more);
  const act = e.target.closest("[data-act]")?.dataset.act;
  if (act === "new-group") return newGroup();
  if (act === "toggle-sessions") {
    S.sessionsOpen = !S.sessionsOpen;
    renderNav();
    persistUi();
    return;
  }
  const item = e.target.closest(".nav-item");
  if (item) setView(item.dataset.view);
}

function onItemDragStart(e) {
  const el = e.target.closest?.(".row.item");
  if (!el?.__row) return;
  const it = el.__row.it;
  const ids = S.selected.has(it.id) ? [...S.selected] : [it.id];
  const urls = ids.map((id) => S.itemById.get(id)?.url).filter(Boolean);
  e.dataTransfer.setData(ITEMS_MIME, JSON.stringify(ids));
  e.dataTransfer.setData("text/uri-list", urls.join("\r\n"));
  e.dataTransfer.setData("text/plain", urls.join("\n"));
  e.dataTransfer.effectAllowed = "copyMove";
  els.app.classList.add("dragging-items");
}

function bindNavDragAndDrop() {
  let draggingGroup = null;
  const clearMarks = () => els.nav.querySelectorAll(".drop-into, .drop-before, .drop-after").forEach((r) => r.classList.remove("drop-into", "drop-before", "drop-after"));

  els.nav.addEventListener("dragstart", (e) => {
    const row = e.target.closest?.(".nav-row[draggable]");
    if (!row) return;
    draggingGroup = row.dataset.group;
    e.dataTransfer.setData(GROUP_MIME, draggingGroup);
    e.dataTransfer.effectAllowed = "move";
    row.classList.add("dragging");
  });
  els.nav.addEventListener("dragend", () => {
    draggingGroup = null;
    clearMarks();
    els.nav.querySelectorAll(".dragging").forEach((r) => r.classList.remove("dragging"));
  });
  els.nav.addEventListener("dragover", (e) => {
    const row = e.target.closest?.(".nav-row");
    clearMarks();
    if (!row) return;
    const types = e.dataTransfer.types;
    if (types.includes(ITEMS_MIME)) {
      if (row.dataset.group || row.dataset.view === "done") {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        row.classList.add("drop-into");
      }
    } else if (types.includes(GROUP_MIME) && draggingGroup && row.dataset.group && row.dataset.group !== draggingGroup && row.closest('[data-zone="groups"]')) {
      e.preventDefault();
      const r = row.getBoundingClientRect();
      row.classList.add(e.clientY < r.top + r.height / 2 ? "drop-before" : "drop-after");
    }
  });
  els.nav.addEventListener("dragleave", (e) => {
    if (!els.nav.contains(e.relatedTarget)) clearMarks();
  });
  els.nav.addEventListener("drop", async (e) => {
    const row = e.target.closest?.(".nav-row");
    const after = row?.classList.contains("drop-after");
    clearMarks();
    if (!row) return;
    e.preventDefault();
    const raw = e.dataTransfer.getData(ITEMS_MIME);
    if (raw) {
      const ids = JSON.parse(raw).filter((id) => S.itemById.has(id));
      if (!ids.length) return;
      let did = false;
      if (row.dataset.view === "done") did = await setDone(ids, true);
      else if (row.dataset.group) {
        const g = S.groupById.get(row.dataset.group);
        const { prev } = await db.patchItems(ids, { groupId: g.id });
        toast(`Moved ${plural(ids.length, "tab")} to ${g.name}`, { undo: () => db.restore({ items: prev }) });
        did = true;
      }
      if (did) clearSelection();
      return;
    }
    const gid = e.dataTransfer.getData(GROUP_MIME);
    if (!gid || !row.dataset.group || gid === row.dataset.group) return;
    let beforeId = row.dataset.group;
    if (after) {
      const next = row.nextElementSibling;
      beforeId = next?.dataset.group || null;
    }
    if (beforeId !== gid) await db.moveGroup(gid, beforeId);
  });
}
