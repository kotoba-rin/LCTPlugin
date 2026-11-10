const assert = require("assert");
const Module = require("module");

const notices = [];
const modals = [];
const load = Module._load;
Module._load = function (name, ...args) {
  if (name === "obsidian") return { Notice: class { constructor(message) { notices.push(message); } }, Modal: class {
    constructor() { modals.push(this); } open() { this.opened = true; }
  } };
  return load.call(this, name, ...args);
};
let KnowledgeLibrary, resolveKnowledgeTargets, knowledgeLinkParts;
try { ({ KnowledgeLibrary, resolveKnowledgeTargets, knowledgeLinkParts } = require("../src/knowledge-library")); }
finally { Module._load = load; }

const card = { path: "知识库/欲望.md", title: "欲望", tags: ["领域/精神分析/欲望", "研讨班XI"], aliases: ["désir"], excerpt: "词条摘录" };
const local = { path: "知识库/私人词条.md", basename: "私人词条" };
const catalog = { version: "v1", knowledgeEntries: [card], knowledgeMetadataAvailable: true };
const make = () => {
  const files = new Map([[local.path, local]]);
  const calls = [];
  const statuses = { [card.path]: { status: "not_synced", label: "未同步" } };
  const engine = { getKnowledgeEntryStatuses: async () => statuses,
    syncKnowledgeEntry: async (path) => { calls.push(["sync", path]); files.set(path, { path }); statuses[path] = { status: "synced", label: "已同步" };
      return { catalog: { ...catalog, version: "v2" }, version: "v2", skippedFiles: [], conflicts: [] }; },
    getCatalog: () => assert.fail("sync must reuse its exact catalog without another request"),
  };
  const plugin = { settings: {}, projectCatalog: catalog,
    app: { vault: { getAbstractFileByPath: (path) => files.get(path), getMarkdownFiles: () => [...files.values()] },
      metadataCache: { getFileCache: (file) => ({ frontmatter: file.path === local.path ? { type: "knowledge-card", title: "私人词条", tags: ["领域/私人"] } : {} }) },
      workspace: { openLinkText: async (...args) => calls.push(["open", ...args]) } },
    runProjectLibraryTask: async (action, options) => { calls.push(["task", options]); return action(engine); },
    createProjectSyncEngine: () => engine, recordProjectSyncResult: (result) => calls.push(["record", result.version]),
    saveSettings: async () => calls.push(["save"]),
  };
  return { plugin, engine, files, calls, statuses, library: new KnowledgeLibrary(plugin) };
};

async function bulkTests() {
  const { plugin, engine, library, calls, statuses } = make();
  const next = { ...card, path: "知识库/另一卡.md", title: "另一卡" };
  const latest = { ...catalog, version: "v3", knowledgeEntries: [card, next] };
  library.statuses[next.path] = { status: "removed", label: "上游已移除" };
  plugin.settings.projectKnowledgeFilters = { search: "no results", status: "modified" };
  const controller = new AbortController();
  plugin.runProjectLibraryTask = async (action) => {
    plugin.syncInProgress = true;
    try { return await action(engine, controller.signal); }
    finally { plugin.syncInProgress = false; plugin.activeKnowledgeSync = null; }
  };
  let fullRenders = 0;
  let progressUpdates = 0;
  plugin.projectKnowledgeViews.add({ onDataUpdated: () => fullRenders++, updateSyncProgress() {}, updateBulkSyncProgress: () => progressUpdates++ });
  let failSecond = false;
  engine.syncAllKnowledgeEntries = async ({ getOrderedPaths, signal, onEntry }) => {
    assert.strictEqual(signal, controller.signal, "one cancellation signal covers the full batch");
    assert.strictEqual(plugin.syncInProgress, true);
    const paths = getOrderedPaths(latest);
    const expected = library.getEntries().filter((entry) => !entry.localOnly).map((entry) => entry.path);
    assert.deepStrictEqual(paths, expected, "order comes from the complete refreshed Base directory despite active filters");
    assert.strictEqual(paths.length, 2, "newly published cards join the directory order; local-only cards are excluded");
    let summary;
    for (const [index, path] of paths.entries()) {
      const entry = latest.knowledgeEntries.find((item) => item.path === path);
      onEntry({ entry, index, total: paths.length, catalog: latest });
      assert.strictEqual(plugin.activeKnowledgeSync, path);
      assert.deepStrictEqual(plugin.knowledgeBulkSync, { completed: index, total: 2, title: entry.title });
      await assert.rejects(library.syncAll(), /正在进行/, "duplicate clicks cannot start a second batch");
      await assert.rejects(library.sync(path), /正在进行/, "single-card sync stays blocked between entries");
      if (failSecond && index === 1) throw Object.assign(new Error("cancelled"), { name: "AbortError" });
      const skippedFiles = !failSecond && index === 1 ? [{ path, reason: "local_modified" }] : [];
      const result = { version: latest.version, catalog: latest, skippedFiles, conflicts: [], added: 1 };
      summary = { ...result, completedEntries: index + 1, skippedEntries: skippedFiles.length ? 1 : 0 };
      statuses[path] = { status: skippedFiles.length ? "modified" : "synced" };
      onEntry({ entry, index, total: paths.length, catalog: latest, result, summary });
      assert.strictEqual(plugin.activeKnowledgeSync, null);
      assert.strictEqual(plugin.knowledgeBulkSync.completed, index + 1);
      assert.strictEqual(plugin.knowledgeSyncProgress.get(path), skippedFiles.length ? 0 : 100);
    }
    return summary;
  };
  const result = await library.syncAll();
  assert.strictEqual(result.completedEntries, 2);
  assert.strictEqual(calls.filter(([type]) => type === "save").length, 1, "persist settings once per batch");
  assert.ok(progressUpdates >= 4);
  assert.ok(fullRenders <= 3, "per-card progress does not rebuild the whole directory table");
  assert.strictEqual(plugin.knowledgeBulkSync, null);
  assert.strictEqual(plugin.syncInProgress, false);
  assert.ok(notices.some((text) => text.includes("2 个词条") && text.includes("1 个因本地修改跳过")));

  failSecond = true;
  calls.length = 0;
  await assert.rejects(library.syncAll(), { name: "AbortError" });
  const paths = library.getEntries().filter((entry) => !entry.localOnly).map((entry) => entry.path);
  assert.strictEqual(plugin.knowledgeSyncProgress.get(paths[0]), 100, "completed entries retain progress after cancel");
  assert.strictEqual(library.failures[paths[1]].status, "error");
  assert.match(library.failures[paths[1]].label, /已取消/);
  assert.strictEqual(calls.filter(([type]) => type === "save").length, 1, "partial completed work is saved on cancel");
  assert.strictEqual(plugin.knowledgeBulkSync, null);
  assert.strictEqual(plugin.syncInProgress, false);
  library.dispose();
}

async function refreshTests() {
  const { library, plugin, engine } = make();
  plugin.projectCatalog = { ...catalog, files: [{ path: "assets/published.png" }, { path: "texts/s11/assets/source.pdf" }] };
  let scheduled = 0;
  library.scheduleRefresh = () => scheduled++;
  for (let index = 0; index < 100; index++) library.scheduleRefreshForChange({ path: "私人笔记/今天.md" });
  library.scheduleRefreshForChange({ path: ".obsidian/plugins/lacan-translation-helper/data.json" });
  library.scheduleRefreshForChange({ path: "assets/private.png" });
  assert.strictEqual(scheduled, 0, "unrelated edits and private assets do not start whole-library scans");
  for (const [file, oldPath] of [
    [{ path: card.path }], [{ path: local.path }], [{ path: "assets/published.png" }],
    [{ path: "私人笔记/moved.md" }, card.path], [{ path: "new-assets", children: [] }, "assets"],
    [{ path: "知识库/子目录", children: [] }], [{ path: "texts/s11", children: [] }], [undefined],
  ]) library.scheduleRefreshForChange(file, oldPath);
  assert.strictEqual(scheduled, 8, "cards, published attachments, old rename paths, folders and unknown events invalidate status");
  plugin.projectCatalog.files.push({ path: "assets/new.png" });
  assert.ok(library.affectsStatus({ path: "assets/new.png" }), "event filtering does not retain a stale mutable file-list index");

  let release;
  let announce;
  const blocked = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { announce = resolve; });
  let reads = 0;
  let scans = 0;
  let firstSignal;
  engine.getKnowledgeEntryStatuses = async (_catalog, { signal }) => {
    const scan = ++scans;
    for (let index = 0; index < 5; index++) {
      signal.throwIfAborted();
      reads++;
      if (scan === 1 && index === 0) { firstSignal = signal; announce(); await blocked; }
    }
    return { [card.path]: { status: scan === 1 ? "update" : "synced" } };
  };
  const revision = library.refreshRevision;
  const first = library.refresh();
  await started;
  const second = library.refresh();
  assert.ok(firstSignal.aborted, "a replacement cancels the obsolete scan rather than just ignoring its result");
  release();
  await Promise.all([first, second]);
  assert.strictEqual(reads, 6, "supersession avoids four of ten planned reads");
  assert.strictEqual(library.statuses[card.path].status, "synced");
  assert.strictEqual(library.refreshRevision, revision + 1, "only committed scans advance freshness");
  assert.ok(library.hasRefreshedSince(revision, plugin.projectCatalog));
  assert.ok(!library.hasRefreshedSince(revision, { ...plugin.projectCatalog }), "a replaced catalog still needs its own scan");

  delete library.scheduleRefresh;
  let finishScan;
  let announceScan;
  const scanBlocked = new Promise((resolve) => { finishScan = resolve; });
  const scanStarted = new Promise((resolve) => { announceScan = resolve; });
  engine.getKnowledgeEntryStatuses = async () => { announceScan(); await scanBlocked; return {}; };
  plugin.syncInProgress = true;
  const changedDuringScan = library.refresh();
  await scanStarted;
  library.scheduleRefreshForChange({ path: card.path });
  finishScan();
  await changedDuringScan;
  assert.ok(!library.hasRefreshedSince(revision, plugin.projectCatalog), "edits during an explicit sync scan invalidate freshness even while background scheduling is paused");
  plugin.syncInProgress = false;
  await library.refresh();
  assert.ok(library.hasRefreshedSince(revision, plugin.projectCatalog), "a subsequent scan covers the queued change");
  const successfulRevision = library.refreshRevision;

  const checkAbort = async (cancel, external = false) => {
    let entered;
    const ready = new Promise((resolve) => { entered = resolve; });
    engine.getKnowledgeEntryStatuses = async (_catalog, { signal }) => {
      entered();
      await new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(Object.assign(new Error("cancelled"), { name: "AbortError" })), { once: true }));
    };
    const controller = new AbortController();
    const work = library.refresh({ signal: controller.signal });
    await ready;
    cancel(controller);
    if (external) await assert.rejects(work, { name: "AbortError" });
    else await work;
  };
  await checkAbort(() => library.pauseRefresh());
  await checkAbort((controller) => controller.abort(), true);
  await checkAbort(() => library.scheduleRefresh());
  await checkAbort(() => library.dispose());
  assert.strictEqual(library.refreshRevision, successfulRevision);
  console.log("Knowledge refresh filtering: 102 unrelated changes → 0 scans; obsolete scan reads: 10 → 6");
}

async function run() {
  await bulkTests();
  await refreshTests();
  assert.deepStrictEqual(knowledgeLinkParts("知识库/%E6%AC%B2%E6%9C%9B.md#来源"), { path: card.path, subpath: "#来源" });
  assert.strictEqual(knowledgeLinkParts("https://example.com/知识库/欲望.md"), null);
  assert.strictEqual(knowledgeLinkParts("%E6%XX"), null);
  assert.deepStrictEqual(resolveKnowledgeTargets("../../知识库/欲望#来源", "texts/s11/translation/Leçon-01.md", [card]), []);
  assert.strictEqual(resolveKnowledgeTargets("../../../知识库/欲望#来源", "texts/s11/translation/Leçon-01.md", [card])[0].path, card.path);
  assert.strictEqual(resolveKnowledgeTargets("知识库/欲望.md#来源", "", [card])[0].subpath, "#来源");
  assert.strictEqual(resolveKnowledgeTargets("désir", "", [card])[0].path, card.path);
  assert.strictEqual(resolveKnowledgeTargets("欲望", "", [card, { ...card, path: "知识库/子目录/欲望.md" }]).length, 2);

  const { library, plugin, files, calls, engine, statuses } = make();
  const entries = library.getEntries();
  assert.strictEqual(entries.length, 2, "show the whole remote directory and local-only cards");
  assert.strictEqual(entries.find((item) => item.path === local.path).status, "local_only");
  assert.strictEqual(entries.find((item) => item.path === card.path).status, "not_synced");
  let renders = 0;
  plugin.projectKnowledgeViews.add({ onDataUpdated: () => renders++, updateSyncProgress: () => {} });
  await library.refresh();
  assert.strictEqual(renders, 1);
  await library.sync(card.path, { open: true, subpath: "#来源", newLeaf: true });
  assert.strictEqual(plugin.projectCatalog.version, "v2");
  assert.strictEqual(library.getEntries().find((item) => item.path === card.path).status, "synced");
  assert.strictEqual(plugin.knowledgeSyncProgress.get(card.path), 100);
  assert.ok(calls.some(([type, path, source, newLeaf]) => type === "open" && path === `${card.path}#来源` && source === "" && newLeaf));
  const opens = () => calls.filter(([name]) => name === "open").length;
  const count = opens();
  engine.syncKnowledgeEntry = async () => ({ catalog, skippedFiles: [{ path: card.path }], conflicts: [] });
  await library.sync(card.path, { open: true });
  assert.strictEqual(opens(), count, "skipped files do not pretend download-and-open succeeded");
  assert.strictEqual(plugin.knowledgeSyncProgress.get(card.path), 0);
  engine.syncKnowledgeEntry = async () => ({ catalog: { ...catalog, knowledgeEntries: [] }, removed: true });
  await library.sync(card.path, { open: true });
  assert.ok(files.has(card.path), "removed card remains local");
  assert.strictEqual(library.statuses[card.path].status, "removed");
  engine.syncKnowledgeEntry = async () => { throw Object.assign(new Error("cancelled"), { name: "AbortError" }); };
  await assert.rejects(library.sync(card.path), /cancelled/);
  assert.strictEqual(library.statuses[card.path].status, "error");
  assert.strictEqual(plugin.knowledgeSyncProgress.get(card.path), 0);

  plugin.projectCatalog = catalog;
  await library.refresh();
  assert.strictEqual(library.getEntries().find((item) => item.path === card.path).status, "error", "background scans retain failed download retry state");
  delete library.failures[card.path];
  files.delete(card.path);
  const event = (href) => {
    const link = { dataset: { lacanKnowledgeSource: "texts/s11/translation/Leçon-01.md" }, getAttribute: () => href };
    return { target: { closest: () => link }, preventDefault() { this.prevented = true; }, stopPropagation() {}, stopImmediatePropagation() {} };
  };
  const missing = event("知识库/欲望.md#来源");
  assert.strictEqual(library.handleLinkClick(missing), true);
  assert.ok(missing.prevented && modals.at(-1).opened, "missing knowledge links offer sync before native empty-file creation");
  assert.strictEqual(modals.at(-1).targets[0].subpath, "#来源");
  files.set(card.path, { path: card.path });
  const existing = event(card.path);
  plugin.app.metadataCache.getFirstLinkpathDest = () => ({ path: card.path });
  assert.strictEqual(library.handleLinkClick(existing), true);
  assert.ok(!existing.prevented, "resolved knowledge links retain native opening and modifier behavior");
  plugin.app.metadataCache.getFirstLinkpathDest = () => ({ path: "私人笔记/欲望.md" });
  assert.strictEqual(library.handleLinkClick(event("欲望")), false, "a private note's resolved name wins over a remote card title");
  plugin.app.metadataCache.getFirstLinkpathDest = () => null;
  const alias = event("désir#来源");
  assert.strictEqual(library.handleLinkClick(alias), true);
  assert.ok(alias.prevented, "remote-only aliases use the resolved knowledge path rather than create a native empty file");
  await Promise.resolve();
  assert.ok(calls.some(([type, path]) => type === "open" && path === `${card.path}#来源`));
  assert.strictEqual(library.handleLinkClick(event("private/other")), false);
  statuses[card.path] = { status: "modified", label: "本地已修改" };
  await library.refresh();
  assert.strictEqual(library.getEntries().find((item) => item.path === card.path).status, "modified");
  let backgroundChecks = 0;
  engine.getKnowledgeEntryStatuses = async () => { backgroundChecks++; return statuses; };
  library.scheduleRefresh();
  plugin.syncInProgress = true;
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.strictEqual(backgroundChecks, 0, "a queued idle refresh cannot interfere with a newly started sync");
  plugin.syncInProgress = false;
  library.dispose();
  assert.strictEqual(plugin.projectKnowledgeViews.size, 0);
  assert.ok(notices.some((text) => text.includes("已有本地修改")));
  console.log("Knowledge library orchestration, local inventory, sync/open, link targets and failure tests passed");
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
