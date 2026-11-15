// Development only: tests for lib/db.js and lib/util.js.   node dev/test-db.mjs
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";
import assert from "node:assert/strict";

vm.runInThisContext(readFileSync(resolve(import.meta.dirname, "mock-chrome.js"), "utf8"));
const { legacySeed } = globalThis.tabSaverSeeds;

// Chrome has the Web Locks API; Node 20 doesn't, so use a simple promise-chain lock.
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

let instance = 0;
async function fresh(seed = {}) {
  globalThis.chrome = createChromeMock({ seed: JSON.parse(JSON.stringify(seed)) });
  return import(`../lib/db.js?instance=${++instance}`);
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// ---------------------------------------------------------------------------

test("migrates the old savedTabs/categories data without losing anything", async () => {
  const seed = legacySeed(409);
  const db = await fresh(seed);
  const s = await db.loadState();

  assert.equal(s.items.length, 409);
  assert.deepEqual(new Set(s.items.map((i) => i.url)), new Set(seed.savedTabs.map((t) => t.url)));
  assert.equal(new Set(s.items.map((i) => i.id)).size, 409, "ids are unique");

  const byUrl = new Map(seed.savedTabs.map((t) => [t.url, t]));
  for (const it of s.items) {
    const old = byUrl.get(it.url);
    assert.equal(it.title, old.title);
    assert.equal(it.savedAt, Date.parse(old.date));
    const g = s.groups.find((x) => x.id === it.groupId);
    if (old.category === "All") assert.equal(it.groupId, db.UNSORTED);
    else if (old.category.startsWith("Auto-")) assert.equal(g.kind, "session");
    else assert.equal(g.name, old.category);
  }

  const names = s.groups.map((g) => g.name);
  assert.equal(names[0], "Unsorted");
  assert.deepEqual(names.slice(1, 3), ["Watch Later", "Learning"], "custom category order is kept");
  assert.ok(!names.includes("All"));
  assert.equal(s.groups.find((g) => g.name === "Personal").private, true, "hidden category becomes private");
  assert.equal(s.groups.find((g) => g.name === "Work").collapsed, true, "collapsed state is kept");
  for (const g of s.groups.filter((x) => x.kind === "session")) assert.match(g.name, /^Session · /);

  const raw = await chrome.storage.local.get(null);
  assert.equal(raw.schemaVersion, 4);
  assert.deepEqual(raw.savedTabs, seed.savedTabs, "old data is left in place as a backup");
});

test("migration only runs once", async () => {
  const db = await fresh(legacySeed(20));
  await db.ensureSchema();
  await chrome.storage.local.set({ savedTabs: [] });
  const db2 = await import(`../lib/db.js?instance=${++instance}`); // a second context, e.g. the side panel
  assert.equal((await db2.loadState()).items.length, 20);
  assert.equal((await db.loadState()).items.length, 20);
});

test("fresh install starts empty with an Unsorted group", async () => {
  const db = await fresh({});
  const s = await db.loadState();
  assert.equal(s.items.length, 0);
  assert.deepEqual(
    s.groups.map((g) => g.id),
    ["unsorted"]
  );
  assert.equal(s.prefs.onOpen, "keep");
});

test("saving dedupes links (YouTube variants too) and moves on re-save", async () => {
  const db = await fresh({});
  const r1 = await db.saveTabs([{ url: "https://www.youtube.com/watch?v=abc123&t=30s", title: "Video" }]);
  assert.equal(r1.added.length, 1);
  const g = await db.createGroup("Watch later");
  assert.equal(g.created, true);
  assert.equal((await db.createGroup("watch LATER")).id, g.id, "group names are case-insensitive");

  const r2 = await db.saveTabs([{ url: "https://youtu.be/abc123", title: "" }], { groupId: g.id });
  assert.equal(r2.added.length, 0);
  assert.equal(r2.updated.length, 1);
  let s = await db.loadState();
  assert.equal(s.items.length, 1);
  assert.equal(s.items[0].groupId, g.id);
  assert.equal(s.items[0].title, "Video", "an empty title doesn't overwrite a good one");
  assert.equal(s.prefs.lastGroupId, g.id);

  const r3 = await db.saveTabs(
    [{ url: "https://youtube.com/watch?v=abc123" }, { url: "https://example.com/a?utm_source=x" }, { url: "https://example.com/a" }],
    { groupName: "Batch", existing: "skip" }
  );
  assert.equal(r3.skipped, 1, "already saved tab is left where it is");
  assert.equal(r3.added.length, 1, "tracking params don't create duplicates");
  assert.ok(r3.createdGroup);
  s = await db.loadState();
  assert.equal(s.items.find((i) => i.url.includes("abc123")).groupId, g.id);

  await db.patchItems([s.items[0].id], { doneAt: Date.now() });
  const r4 = await db.saveTabs([{ url: "https://m.youtube.com/watch?v=abc123" }], { groupName: "Batch", existing: "skip" });
  assert.equal(r4.updated.length, 1, "saving something that's in Done brings it back");
  s = await db.loadState();
  assert.equal(s.items.find((i) => i.url.includes("abc123")).doneAt, undefined);
});

test("undo puts deleted tabs and groups back", async () => {
  const db = await fresh(legacySeed(60));
  const before = await db.loadState();
  const ids = before.items.slice(0, 5).map((i) => i.id);

  const del = await db.deleteItems(ids);
  assert.equal((await db.loadState()).items.length, 55);
  await db.restore({ items: del.prev });
  assert.equal((await db.loadState()).items.length, 60);

  const target = before.groups.find((g) => g.name === "Watch Later");
  const inGroup = before.items.filter((i) => i.groupId === target.id).length;
  const res = await db.deleteGroup(target.id);
  let s = await db.loadState();
  assert.ok(!s.groups.some((g) => g.id === target.id));
  assert.equal(s.items.filter((i) => i.groupId === db.UNSORTED).length, before.items.filter((i) => i.groupId === db.UNSORTED).length + inGroup);
  await db.restore({ groups: [{ group: res.group, index: res.index }], items: res.prev });
  s = await db.loadState();
  assert.deepEqual(
    s.groups.map((g) => g.id),
    before.groups.map((g) => g.id),
    "group comes back in the same place"
  );
  assert.equal(s.items.filter((i) => i.groupId === target.id).length, inGroup);

  const res2 = await db.deleteGroup(target.id, { withItems: true });
  assert.equal((await db.loadState()).items.length, 60 - inGroup);
  await db.restore({ groups: [{ group: res2.group, index: res2.index }], items: res2.prev });
  assert.equal((await db.loadState()).items.length, 60);
  assert.equal(await db.deleteGroup(db.UNSORTED), null, "Unsorted can't be deleted");
});

test("parallel writes from several places don't lose tabs", async () => {
  const db = await fresh({});
  const db2 = await import(`../lib/db.js?instance=${++instance}`);
  await Promise.all(
    Array.from({ length: 40 }, (_, i) => (i % 2 ? db : db2).saveTabs([{ url: `https://example.com/page/${i}`, title: `Page ${i}` }]))
  );
  assert.equal((await db.loadState()).items.length, 40);
});

test("group order, colours and patches", async () => {
  const db = await fresh({});
  const a = await db.createGroup("A");
  const b = await db.createGroup("B");
  const c = await db.createGroup("C");
  await db.moveGroup(c.id, a.id);
  let names = (await db.loadState()).groups.map((g) => g.name);
  assert.deepEqual(names, ["Unsorted", "C", "A", "B"]);
  await db.moveGroup(c.id, null);
  names = (await db.loadState()).groups.map((g) => g.name);
  assert.deepEqual(names, ["Unsorted", "A", "B", "C"]);
  await db.patchGroup(a.id, { color: "red", private: true, collapsed: true });
  await db.patchGroups([a.id, b.id], { collapsed: false });
  const ga = (await db.loadState()).groups.find((g) => g.id === a.id);
  assert.equal(ga.color, "red");
  assert.equal(ga.private, true);
  assert.equal(ga.collapsed, undefined);
});

test("import: old exports, new exports, merge and replace", async () => {
  const legacyExport = { version: "1.0", exportDate: "2026-01-01", ...legacySeed(30) };
  const db = await fresh({});
  await db.saveTabs([{ url: legacyExport.savedTabs[0].url, title: "Mine" }]);
  const merged = await db.importBackup(db.parseBackup(legacyExport), "merge");
  assert.equal(merged.added, 29);
  assert.equal(merged.skipped, 1);
  let s = await db.loadState();
  assert.equal(s.items.length, 30);
  assert.equal(s.items.find((i) => i.url === legacyExport.savedTabs[0].url).title, "Mine", "existing tabs win");

  const v4 = await db.exportData();
  const db2 = await fresh({});
  const res = await db2.importBackup(db2.parseBackup(JSON.parse(JSON.stringify(v4))), "merge");
  assert.equal(res.added, 30);
  s = await db2.loadState();
  assert.deepEqual(new Set(s.groups.map((g) => g.name)), new Set(v4.groups.map((g) => g.name)));

  await db2.saveTabs([{ url: "https://only-here.example/" }]);
  await db2.importBackup(db2.parseBackup(v4), "replace");
  s = await db2.loadState();
  assert.equal(s.items.length, 30);
  assert.ok(!s.items.some((i) => i.url.includes("only-here")));

  assert.throws(() => db2.parseBackup({ hello: 1 }), /isn't a Tab Saver backup/);
});

test("wipeAll clears tabs, groups and the old backup keys but keeps settings", async () => {
  const db = await fresh(legacySeed(10));
  await db.loadState();
  await db.setPrefs({ onOpen: "done" });
  await db.wipeAll();
  const s = await db.loadState();
  assert.equal(s.items.length, 0);
  assert.equal(s.groups.length, 1);
  assert.equal(s.prefs.onOpen, "done");
  assert.equal((await chrome.storage.local.get("savedTabs")).savedTabs, undefined);
});

test("urlInfo builds stable keys and domains", async () => {
  const { urlInfo, dateBucketKey, startOfToday, DAY } = await import("../lib/util.js");
  const same = (a, b) => assert.equal(urlInfo(a).key, urlInfo(b).key, `${a} == ${b}`);
  const diff = (a, b) => assert.notEqual(urlInfo(a).key, urlInfo(b).key, `${a} != ${b}`);
  same("https://www.youtube.com/watch?v=XYZ&list=PL1&index=3", "https://youtu.be/XYZ?si=abc");
  same("https://youtube.com/shorts/XYZ", "https://m.youtube.com/watch?v=XYZ");
  same("http://example.com/a/", "https://www.example.com/a?utm_source=news&utm_medium=x");
  same("https://example.com/a#section", "https://example.com/a");
  diff("https://example.com/a?id=1", "https://example.com/a?id=2");
  diff("https://app.example.com/#/inbox", "https://app.example.com/#/sent");
  assert.equal(urlInfo("https://www.github.com/x").domain, "github.com");
  assert.equal(urlInfo("file:///C:/notes.txt").domain, "file");
  assert.equal(urlInfo("not a url").domain, "");

  const today = startOfToday();
  assert.equal(dateBucketKey(today + 1000, today), "today");
  assert.equal(dateBucketKey(today - 1000, today), "yesterday");
  assert.equal(dateBucketKey(today - 3 * DAY, today), "week");
  assert.equal(dateBucketKey(today - 20 * DAY, today), "month");
  assert.match(dateBucketKey(today - 300 * DAY, today), /^m\d{4}-\d{1,2}$/);
});

test("handles 5,000 saved tabs quickly", async () => {
  const db = await fresh(legacySeed(5000));
  let t = performance.now();
  const s = await db.loadState();
  const migrate = performance.now() - t;
  assert.equal(s.items.length, 5000);
  t = performance.now();
  await db.saveTabs([{ url: "https://example.com/new", title: "New" }]);
  const save = performance.now() - t;
  console.log(`      migrate 5,000: ${migrate.toFixed(0)} ms, one save with 5,000 stored: ${save.toFixed(0)} ms`);
  assert.ok(save < 500);
});

// ---------------------------------------------------------------------------

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
