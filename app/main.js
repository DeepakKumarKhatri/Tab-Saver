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
