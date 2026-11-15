// Development only: a fake `chrome` extension API so app.html can run as a normal web page
// (dev/serve.mjs injects this file) and so lib/db.js can be tested in Node (dev/test-db.mjs).
// The real extension never loads this file.
//
// Page URL options:  ?seed=legacy409 (default) | legacy5000 | v4 | empty    &mode=page for the full-page layout

(function () {
  "use strict";

  function createChromeMock({ origin = "http://localhost:5179", seed = {}, page = false, tabs: initialTabs = [] } = {}) {
    const calls = [];
    const log = (api, args) => calls.push({ api, args, at: Date.now() });
    const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

    // ---------------- storage ----------------
    const listeners = [];
    const fire = (changes, area) => {
      for (const fn of listeners) setTimeout(() => fn(clone(changes), area), 0);
    };
    function makeArea(name, data = {}) {
      return {
        _data: data,
        async get(keys) {
          const out = {};
          if (keys == null) return clone(data);
          if (typeof keys === "string") keys = [keys];
          if (Array.isArray(keys)) {
            for (const k of keys) if (k in data) out[k] = clone(data[k]);
          } else {
            for (const [k, def] of Object.entries(keys)) out[k] = k in data ? clone(data[k]) : def;
          }
          return out;
        },
        async set(obj) {
          log(`storage.${name}.set`, Object.keys(obj));
          const changes = {};
          for (const [k, v] of Object.entries(obj)) {
            changes[k] = { oldValue: clone(data[k]), newValue: clone(v) };
            data[k] = clone(v);
          }
          fire(changes, name);
        },
        async remove(keys) {
          if (typeof keys === "string") keys = [keys];
          const changes = {};
          for (const k of keys) {
            if (!(k in data)) continue;
            changes[k] = { oldValue: clone(data[k]) };
            delete data[k];
          }
          if (Object.keys(changes).length) fire(changes, name);
        },
        async clear() {
          for (const k of Object.keys(data)) delete data[k];
        },
        async getBytesInUse() {
          return JSON.stringify(data).length;
        },
      };
    }
    const local = makeArea("local", clone(seed));
    const session = makeArea("session", {});

    // ---------------- tabs / windows ----------------
    const event = () => {
      const fns = [];
      return { addListener: (f) => fns.push(f), removeListener: (f) => fns.splice(fns.indexOf(f), 1), _fire: (...a) => fns.forEach((f) => f(...a)) };
    };
    const onActivated = event();
    const onUpdated = event();
    const WIN = 1;
    let nextTabId = 100;
    let nextGroupId = 1;
    const allTabs = [];
    const addTab = (t) => {
      const tab = { id: nextTabId++, windowId: WIN, index: allTabs.length, active: false, pinned: false, title: t.title || t.url, url: t.url, favIconUrl: "", groupId: -1, ...t };
      allTabs.push(tab);
      return tab;
    };
    initialTabs.forEach(addTab);
    if (page) {
      allTabs.forEach((t) => (t.active = false));
      addTab({ url: origin + "/app.html?mode=page", title: "Tab Saver", active: true });
    }
    if (!allTabs.some((t) => t.active) && allTabs.length) allTabs[0].active = true;
    const reindex = () => allTabs.forEach((t, i) => (t.index = i));
    const activate = (id) => {
      for (const t of allTabs) t.active = t.id === id;
      onActivated._fire({ tabId: id, windowId: WIN });
    };

    const tabsApi = {
      onActivated,
      onUpdated,
      onRemoved: event(),
      onCreated: event(),
      async getCurrent() {
        return page ? clone(allTabs.find((t) => t.url.includes("mode=page"))) : undefined;
      },
      async query(q = {}) {
        return clone(allTabs.filter((t) => (q.active === undefined || t.active === q.active) && (q.windowId === undefined || t.windowId === q.windowId)));
      },
      async get(id) {
        return clone(allTabs.find((t) => t.id === id));
      },
      async create(props) {
        log("tabs.create", props);
        let at = allTabs.length;
        if (props.openerTabId) {
          const opener = allTabs.findIndex((t) => t.id === props.openerTabId);
          if (opener >= 0) at = opener + 1;
        }
        const tab = { id: nextTabId++, windowId: WIN, active: false, pinned: false, title: props.url || "New Tab", url: props.url || "chrome://newtab/", favIconUrl: "", groupId: -1 };
        allTabs.splice(at, 0, tab);
        reindex();
        if (props.active !== false) activate(tab.id);
        return clone(tab);
      },
      async update(id, props) {
        log("tabs.update", { id, ...props });
        const tab = allTabs.find((t) => t.id === id);
        if (!tab) throw new Error("No tab " + id);
        if (props.url) {
          tab.url = props.url;
          tab.title = props.url;
          onUpdated._fire(id, { url: props.url }, clone(tab));
        }
        if (props.active) activate(id);
        return clone(tab);
      },
      async remove(ids) {
        log("tabs.remove", ids);
        for (const id of [].concat(ids)) {
          const i = allTabs.findIndex((t) => t.id === id);
          if (i >= 0) allTabs.splice(i, 1);
        }
        reindex();
        if (allTabs.length && !allTabs.some((t) => t.active)) activate(allTabs[allTabs.length - 1].id);
      },
      async group({ tabIds }) {
        log("tabs.group", tabIds);
        const gid = nextGroupId++;
        for (const t of allTabs) if (tabIds.includes(t.id)) t.groupId = gid;
        return gid;
      },
      _all: allTabs,
      _activate: activate,
      _add: (t) => {
        const tab = addTab(t);
        reindex();
        return tab;
      },
    };

    return {
      __mock: true,
      __calls: calls,
      runtime: { id: "mock", getURL: (p) => origin + "/" + String(p).replace(/^\//, ""), lastError: undefined },
      storage: { local, session, onChanged: { addListener: (f) => listeners.push(f), removeListener: (f) => listeners.splice(listeners.indexOf(f), 1) } },
      tabs: tabsApi,
      tabGroups: {
        async update(id, props) {
          log("tabGroups.update", { id, ...props });
        },
      },
      windows: {
        async getCurrent({ populate } = {}) {
          return { id: WIN, focused: true, type: "normal", ...(populate ? { tabs: clone(allTabs) } : {}) };
        },
        async getAll({ populate } = {}) {
          return [{ id: WIN, focused: true, type: "normal", ...(populate ? { tabs: clone(allTabs) } : {}) }];
        },
        async update(id, props) {
          log("windows.update", { id, ...props });
        },
      },
      commands: {
        async getAll() {
          return [
            { name: "save-tab", shortcut: "Alt+Shift+S", description: "Save the current tab" },
            { name: "open-tab-saver", shortcut: "Alt+Shift+L", description: "Open Tab Saver" },
          ];
        },
      },
      sidePanel: {
        async open(opts) {
          log("sidePanel.open", opts);
        },
      },
    };
  }

  // ---------------- seed data ----------------

  function rng(seed) {
    let s = seed >>> 0;
    return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  }

  const SITES = [
    ["youtube.com", 34, (r, i) => [`https://www.youtube.com/watch?v=${vid(r)}`, pick(r, YT) + (i % 3 ? "" : " (full course)")]],
    ["medium.com", 8, (r) => [`https://medium.com/@writer${(r() * 90) | 0}/${slug(r)}`, pick(r, ART)]],
    ["github.com", 9, (r) => [`https://github.com/${pick(r, ["vercel", "facebook", "rust-lang", "microsoft", "sveltejs", "denoland"])}/${pick(r, ["next.js", "react", "rust", "vscode", "svelte", "deno"])}/issues/${(r() * 9000) | 0}`, pick(r, GH)]],
    ["en.wikipedia.org", 6, (r) => [`https://en.wikipedia.org/wiki/${pick(r, WIKI).replace(/ /g, "_")}`, pick(r, WIKI) + " - Wikipedia"]],
    ["dev.to", 5, (r) => [`https://dev.to/someone/${slug(r)}`, pick(r, ART)]],
    ["news.ycombinator.com", 4, (r) => [`https://news.ycombinator.com/item?id=${(r() * 4e7) | 0}`, pick(r, ART) + " | Hacker News"]],
    ["developer.mozilla.org", 5, (r) => [`https://developer.mozilla.org/en-US/docs/Web/API/${pick(r, MDN)}`, pick(r, MDN) + " - Web APIs | MDN"]],
    ["nytimes.com", 3, (r) => [`https://www.nytimes.com/2026/0${1 + ((r() * 9) | 0)}/${slug(r)}.html`, pick(r, NEWS)]],
    ["bbcgoodfood.com", 3, (r) => [`https://www.bbcgoodfood.com/recipes/${slug(r)}`, pick(r, FOOD)]],
    ["stackoverflow.com", 5, (r) => [`https://stackoverflow.com/questions/${(r() * 7e7) | 0}/${slug(r)}`, pick(r, SO)]],
    ["docs.google.com", 2, (r) => [`https://docs.google.com/document/d/${vid(r)}${vid(r)}/edit`, pick(r, ["Q3 planning", "Trip notes", "Interview prep", "Reading list"]) + " - Google Docs"]],
    ["amazon.com", 2, (r) => [`https://www.amazon.com/dp/B0${(r() * 1e8) | 0}`, "Amazon.com: " + pick(r, ["Mechanical Keyboard", "Standing Desk", "Noise Cancelling Headphones", "USB-C Hub"])]],
  ];
  const YT = [
    "System Design Interview: 5 Must Know Concepts",
    "I finally know how CPUs work (w/ Casey Muratori)",
    "The Perfect Dependency - SQLite Case Study",
    "How To Use The Google Calendar API",
    "Complete Finance MasterClass 2026",
    "The Man Behind DeepSeek (Liang Wenfeng)",
    "Rust in 100 Seconds",
    "Building a compiler from scratch",
    "Lo-fi beats to study to",
    "How the Internet Works in 5 Minutes",
    "Learn Kubernetes in One Hour",
    "Why Japan's Trains Are Never Late",
    "The Science of Sleep",
    "Making Sourdough at Home",
    "Postgres Indexing Explained",
    "TypeScript Generics Deep Dive",
    "Inside the World's Largest Data Center",
    "Machine Learning Crash Course",
    "Stop Writing Bad Commit Messages",
    "Chess Openings for Beginners",
  ];
  const ART = [
    "How we cut our cloud bill by 60%",
    "A gentle introduction to CRDTs",
    "Writing maintainable CSS in 2026",
    "Lessons from 10 years of remote work",
    "The hidden cost of microservices",
    "Understanding the event loop",
    "Designing for accessibility first",
    "Why your tests are slow",
    "A practical guide to caching",
    "What I learned shipping a side project",
  ];
  const GH = ["Memory leak when using streaming", "Add support for Windows ARM64", "Docs: clarify the config options", "Feature request: dark mode", "Build fails on Node 22"];
  const WIKI = ["Byzantine fault", "Fermi paradox", "Bloom filter", "Dunning Kruger effect", "Silk Road", "Turing machine", "Great Pacific garbage patch"];
  const MDN = ["Web_Locks_API", "IntersectionObserver", "Fetch_API", "Web_Workers_API", "ResizeObserver", "Clipboard_API"];
  const NEWS = ["The quiet revolution in battery tech", "Inside the race to build fusion power", "Why everyone is moving to smaller cities", "The economics of streaming"];
  const FOOD = ["Easy chicken curry", "Best ever banana bread", "Vegan chilli", "Lemon drizzle cake", "Mushroom risotto"];
  const SO = ["How do I undo the most recent local commits in Git?", "What does 'use strict' do in JavaScript?", "How to center a div", "Why is processing a sorted array faster?"];

  const pick = (r, a) => a[(r() * a.length) | 0];
  const vid = (r) => Array.from({ length: 11 }, () => "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_"[(r() * 64) | 0]).join("");
  const slug = (r) => Array.from({ length: 3 + ((r() * 3) | 0) }, () => pick(r, ["fast", "guide", "react", "data", "home", "learn", "deep", "simple", "notes", "build", "city", "money", "health"])).join("-");

  function legacySeed(count = 409) {
    const r = rng(42);
    const now = Date.now();
    const DAY = 86400000;
    const cats = ["All", "Watch Later", "Learning", "Work", "Reading", "Recipes", "Personal", "Auto-2026-03-14-221530", "Auto-2026-07-02-090011"];
    const weights = SITES.flatMap(([, w], i) => Array(w).fill(i));
    const savedTabs = [];
    const seen = new Set();
    for (let i = 0; savedTabs.length < count; i++) {
      const [, , make] = SITES[weights[(r() * weights.length) | 0]];
      const [url, title] = make(r, i);
      if (seen.has(url)) continue;
      seen.add(url);
      const age = Math.pow(r(), 1.6) * 430 * DAY; // more recent items than old ones
      const category = url.includes("youtube") ? pick(r, ["Watch Later", "Watch Later", "Learning", "All"]) : url.includes("goodfood") ? "Recipes" : pick(r, cats);
      savedTabs.push({ url, title, favicon: `https://${new URL(url).hostname}/favicon.ico`, date: new Date(now - age).toISOString(), category });
    }
    return {
      savedTabs,
      categories: cats,
      categoryOrder: ["Watch Later", "Learning"],
      collapsedCategories: ["Work"],
      hiddenCategories: ["Personal"],
      categoryLastOpened: { Learning: new Date(now - 3 * DAY).toISOString() },
      autoSaveEnabled: false,
    };
  }

  const OPEN_TABS = [
    { url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", title: "How the Internet Works in 5 Minutes - YouTube", active: true },
    { url: "https://github.com/rust-lang/rust/issues/12345", title: "Tracking issue for async closures · rust-lang/rust" },
    { url: "https://developer.mozilla.org/en-US/docs/Web/API/Web_Locks_API", title: "Web Locks API - Web APIs | MDN" },
    { url: "https://www.bbcgoodfood.com/recipes/easy-chicken-curry", title: "Easy chicken curry recipe | BBC Good Food" },
    { url: "chrome://newtab/", title: "New Tab" },
    { url: "https://news.ycombinator.com/", title: "Hacker News" },
  ];

  globalThis.createChromeMock = createChromeMock;
  globalThis.tabSaverSeeds = { legacySeed, OPEN_TABS };

  if (typeof window !== "undefined" && !globalThis.chrome?.storage) {
    const params = new URLSearchParams(location.search);
    const which = params.get("seed") || "legacy409";
    const seed = which === "empty" ? {} : which === "legacy5000" ? legacySeed(5000) : legacySeed(409);
    globalThis.chrome = createChromeMock({ origin: location.origin, seed, page: params.get("mode") === "page", tabs: OPEN_TABS });
  }
})();
