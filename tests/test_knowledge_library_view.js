const assert = require("assert");
const { createKnowledgeBasesViewClass, matchesKnowledgeFilters } = require("../src/knowledge-library-view");
const { PROJECT_BASE_CONTENT, migrateProjectBaseContent } = require("../src/project-library-base");

class Element {
  constructor(tag = "div", options = {}) {
    this.tag = tag; this.className = options.cls || ""; this.textContent = options.text || "";
    this.children = []; this.attributes = options.attr || {}; this.events = new Map(); this.value = options.value || "";
  }
  createEl(tag, options) { const child = new Element(tag, options); this.children.push(child); return child; }
  createDiv(cls) { return this.createEl("div", { cls }); }
  createSpan(options) { return this.createEl("span", options); }
  empty() { this.children = []; }
  setAttribute(key, value) { this.attributes[key] = value; }
  addEventListener(name, callback) { this.events.set(name, callback); }
  addClass(name) { this.className += ` ${name}`; }
  descendants() { return this.children.flatMap((child) => [child, ...child.descendants()]); }
}
const entries = [
  { path: "知识库/父亲隐喻.md", title: "父亲隐喻与父之名", tags: ["领域/精神分析/能指言说与书写", "研讨班IV", "研讨班V", "概念/父之名"], excerpt: "父亲能指替代母亲的位置", status: "not_synced" },
  { path: "知识库/Agalma.md", title: "Agalma 的希腊语义", tags: ["领域/古典学/古希腊", "研讨班VIII"], aliases: ["ἀγάλμα"], excerpt: "苏格拉底的譬喻", status: "synced" },
  { path: "知识库/局部.md", title: "私人笔记", tags: ["领域/精神分析/临床"], status: "local_only", localOnly: true },
  { path: "知识库/旧卡.md", title: "旧词条", tags: [], status: "removed", removed: true },
];
const event = () => ({ preventDefault() {}, stopPropagation() {} });
const titles = (parent) => parent.descendants().filter((node) => node.className === "lacan-knowledge-title").map((node) => node.textContent);

function migrationTests() {
  assert.match(PROJECT_BASE_CONTENT, /type: lacan-knowledge-list\n\s+name: 知识库/);
  assert.strictEqual(migrateProjectBaseContent(PROJECT_BASE_CONTENT), PROJECT_BASE_CONTENT);
  const original = 'filters:\n  and:\n    - file.folder.contains("/original")\n# keep comment\nviews:\n  - type: table\n    name: My custom view\n    limit: 7\nproperties:\n  file.name:\n    displayName: 自定义标题\n';
  const migrated = migrateProjectBaseContent(original);
  assert.strictEqual(migrated.replace('  - type: lacan-knowledge-list\n    name: 知识库\n', ''), original, "migration only inserts the new view");
  assert.ok(migrated.indexOf("name: 知识库") < migrated.indexOf("properties:"), "new view must remain within views");
  assert.strictEqual(migrateProjectBaseContent(migrated), migrated, "migration is idempotent");
  assert.strictEqual(migrateProjectBaseContent(original.replace(/\n/g, "\r\n")), migrated.replace(/\n/g, "\r\n"), "CRLF is preserved");
  assert.strictEqual(migrateProjectBaseContent("filters: true\n"), "filters: true\nviews:\n  - type: lacan-knowledge-list\n    name: 知识库\n");
  assert.strictEqual(migrateProjectBaseContent("views: [] # empty\n"), "views: # empty\n  - type: lacan-knowledge-list\n    name: 知识库\n");
  assert.strictEqual(migrateProjectBaseContent("views:\n- type: table\n  name: A\nother: true\n"), "views:\n- type: table\n  name: A\n- type: lacan-knowledge-list\n  name: 知识库\nother: true\n");
  assert.throws(() => migrateProjectBaseContent("views:\n  invalid: yes\n"), /必须是列表/);
  assert.throws(() => migrateProjectBaseContent("views: [{type: table}]\n"), /复杂 views/);
  const preservedView = { type: "table", name: "A", extra: { untouched: true } };
  let serialized;
  const flow = migrateProjectBaseContent("filters: custom\nviews: [{type: table}]\nother: keep\n", {
    parseYaml: () => ({ views: [preservedView] }),
    stringifyYaml: (data) => { serialized = data; return "views:\n  - type: table\n    name: A\n    extra: {untouched: true}\n  - type: lacan-knowledge-list\n    name: 知识库\n"; },
  });
  assert.deepStrictEqual(serialized.views, [preservedView, { type: "lacan-knowledge-list", name: "知识库" }]);
  assert.ok(flow.startsWith("filters: custom\n") && flow.endsWith("other: keep\n"));
  assert.strictEqual(migrateProjectBaseContent("views:\n  - name: 我的知识\n    type: lacan-knowledge-list\n", {
    parseYaml: () => ({ views: [{ name: "我的知识", type: "lacan-knowledge-list" }] }),
  }), "views:\n  - name: 我的知识\n    type: lacan-knowledge-list\n");
}

async function run() {
  migrationTests();
  assert.ok(matchesKnowledgeFilters(entries[0], { search: "父亲 研讨班V" }));
  assert.ok(matchesKnowledgeFilters(entries[1], { search: "AGALMA" }));
  assert.ok(matchesKnowledgeFilters(entries[1], { search: "ἀγάλμα" }));
  assert.ok(matchesKnowledgeFilters(entries[0], { search: "母亲的位置" }));
  assert.ok(matchesKnowledgeFilters(entries[0], { search: "父亲隐喻.md" }));
  assert.ok(!matchesKnowledgeFilters(entries[0], { category: "古典学" }));
  const calls = [];
  const library = { statuses: {}, failures: {} };
  const plugin = {
    settings: {}, projectCatalog: { knowledgeMetadataAvailable: true }, projectKnowledgeViews: new Set(),
    knowledgeSyncProgress: new Map(), getKnowledgeEntries: () => entries, saveSettings: async () => calls.push(["save"]),
    refreshProjectCatalog: async (options) => calls.push(["refresh", options]),
    syncProjectKnowledgeEntry: async (path, options) => calls.push(["sync", path, options]),
    syncAllProjectKnowledge: async (...args) => calls.push(["sync-all", ...args]),
    cancelProjectSync: () => calls.push(["cancel"]), getKnowledgeLibrary: () => library,
    openKnowledgeEntry: async (path) => calls.push(["open", path]), runWithNotice: async (action) => action(),
  };
  const parent = new Element();
  const View = createKnowledgeBasesViewClass(class {});
  const view = new View({}, parent, plugin);
  const toolbarLink = (text) => parent.descendants().find((node) => node.tag === "a" && node.textContent === text);
  const toolbar = parent.descendants().find((node) => node.className === "lacan-knowledge-toolbar");
  assert.deepStrictEqual(toolbar.children.filter((node) => node.tag === "a").slice(0, 2).map((node) => node.textContent), ["更新目录", "同步全部知识库"]);
  assert.deepStrictEqual(titles(parent), entries.map((entry) => entry.title), "complete catalog renders without local Base rows");
  assert.strictEqual(plugin.projectKnowledgeViews.size, 1);
  const search = parent.descendants().find((node) => node.tag === "input");
  let searchRenders = 0;
  const renderEntries = view.renderEntries.bind(view);
  view.renderEntries = () => { searchRenders++; return renderEntries(); };
  const savedBeforeTyping = calls.filter(([type]) => type === "save").length;
  for (const query of ["父", "父亲隐", "父亲"]) { search.value = query; search.events.get("input")(); }
  assert.strictEqual(searchRenders, 0, "rapid typing defers repeated full table rendering");
  assert.strictEqual(calls.filter(([type]) => type === "save").length, savedBeforeTyping);
  await new Promise((resolve) => setTimeout(resolve, 130));
  assert.strictEqual(searchRenders, 1, "rapid inputs render only the latest query");
  assert.deepStrictEqual(titles(parent), [entries[0].title]);
  assert.strictEqual(plugin.settings.projectKnowledgeFilters.search, "父亲");
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.strictEqual(calls.filter(([type]) => type === "save").length, savedBeforeTyping + 1, "rapid input persists the full settings once");
  view.onDataUpdated();
  assert.strictEqual(parent.descendants().find((node) => node.tag === "input").value, "父亲", "redraw retains query");
  await toolbarLink("同步全部知识库").events.get("click")(event());
  assert.deepStrictEqual(calls.at(-1), ["sync-all"], "bulk sync uses the full directory without passing the active filters");
  view.changeFilter("search", "");
  const select = (label) => parent.descendants().find((node) => node.tag === "select" && node.attributes["aria-label"] === label);
  select("分类").value = "精神分析"; select("分类").events.get("change")();
  assert.deepStrictEqual(titles(parent), [entries[0].title, entries[2].title]);
  select("主题").value = "能指言说与书写"; select("主题").events.get("change")();
  assert.deepStrictEqual(titles(parent), [entries[0].title]);
  select("关联研讨班").value = "研讨班V"; select("关联研讨班").events.get("change")();
  assert.deepStrictEqual(titles(parent), [entries[0].title]);
  select("同步状态").value = "synced"; select("同步状态").events.get("change")();
  assert.deepStrictEqual(titles(parent), []);
  for (const field of ["category", "topic", "seminar", "status"]) view.changeFilter(field, "");
  const row = (path) => parent.descendants().find((node) => node.tag === "tr" && node.attributes["data-path"] === path);
  const link = (path, text) => row(path).descendants().find((node) => node.tag === "a" && node.textContent === text);
  await link(entries[0].path, "同步并打开").events.get("click")(event());
  assert.deepStrictEqual(calls.at(-1), ["sync", entries[0].path, { open: true }]);
  await link(entries[0].path, "同步").events.get("click")(event());
  assert.deepStrictEqual(calls.at(-1), ["sync", entries[0].path, { open: false }]);
  await link(entries[1].path, "打开").events.get("click")(event());
  assert.deepStrictEqual(calls.at(-1), ["open", entries[1].path]);
  await link(entries[1].path, "检查更新").events.get("click")(event());
  assert.deepStrictEqual(calls.at(-1), ["sync", entries[1].path, { open: false }]);
  for (const entry of entries.slice(2)) assert.deepStrictEqual(row(entry.path).descendants().filter((node) => node.tag === "a").map((node) => node.textContent), ["打开"]);
  const before = calls.length;
  plugin.syncInProgress = true;
  await link(entries[0].path, "同步").events.get("click")(event());
  await toolbarLink("同步全部知识库").events.get("click")(event());
  assert.strictEqual(calls.length, before, "a sync started after rendering still disables another request");
  plugin.activeKnowledgeSync = entries[0].path;
  plugin.knowledgeSyncProgress.set(entries[0].path, 51);
  view.onDataUpdated();
  assert.strictEqual(link(entries[0].path, "同步").attributes["aria-disabled"], "true");
  assert.strictEqual(toolbarLink("同步全部知识库").attributes["aria-disabled"], "true");
  assert.strictEqual(view.progressElements.get(entries[0].path).attributes["aria-valuenow"], "51");
  plugin.knowledgeSyncProgress.set(entries[0].path, 100);
  view.updateSyncProgress(entries[0].path);
  assert.strictEqual(view.progressElements.get(entries[0].path).textContent, " 100%");
  const table = parent.descendants().find((node) => node.tag === "table");
  const state = (path) => row(path).children[3].children[0].textContent;
  assert.strictEqual(state(entries[0].path), "同步中…");
  plugin.activeKnowledgeSync = entries[1].path;
  library.statuses[entries[0].path] = { status: "synced", label: "已同步" };
  view.updateSyncProgress(entries[0].path);
  view.updateSyncProgress(entries[1].path);
  assert.strictEqual(state(entries[0].path), "已同步");
  assert.strictEqual(state(entries[1].path), "同步中…", "the next row becomes active without redrawing the table");
  library.failures[entries[0].path] = { status: "error", label: "同步失败，可重试" };
  view.updateSyncProgress(entries[0].path);
  assert.strictEqual(state(entries[0].path), "同步失败，可重试", "failed download state wins over a background status scan");
  delete library.failures[entries[0].path];
  delete library.statuses[entries[0].path];
  plugin.knowledgeBulkSync = { completed: 1, total: 4, title: entries[1].title };
  view.updateBulkSyncProgress();
  const bulkProgress = parent.descendants().find((node) => node.attributes.role === "status");
  assert.strictEqual(bulkProgress.attributes["aria-live"], "polite");
  assert.ok(!bulkProgress.hidden && bulkProgress.textContent.includes("1 / 4") && bulkProgress.textContent.includes(entries[1].title));
  assert.strictEqual(toolbarLink("取消同步").hidden, false);
  await toolbarLink("取消同步").events.get("click")(event());
  assert.deepStrictEqual(calls.at(-1), ["cancel"], "cancel remains available while other sync actions are disabled");
  plugin.knowledgeBulkSync = { completed: 2, total: 4, title: "" };
  view.updateBulkSyncProgress();
  assert.ok(bulkProgress.textContent.includes("2 / 4"));
  assert.strictEqual(parent.descendants().find((node) => node.tag === "table"), table, "progress updates retain the existing table and search controls");
  plugin.knowledgeBulkSync = null;
  view.updateBulkSyncProgress();
  assert.strictEqual(bulkProgress.hidden, true);
  assert.strictEqual(toolbarLink("取消同步").hidden, true);
  plugin.activeKnowledgeSync = null;
  plugin.syncInProgress = false;
  plugin.projectCatalog.knowledgeMetadataAvailable = false;
  view.onDataUpdated();
  assert.ok(parent.descendants().some((node) => node.textContent.includes("未下载词条的目录目前仅提供标题")));
  await parent.descendants().find((node) => node.tag === "a" && node.textContent === "更新目录").events.get("click")(event());
  assert.deepStrictEqual(calls.at(-1), ["refresh", { notify: true }]);
  entries.push({ path: "知识库/失败.md", title: "下载失败词条", tags: [], status: "error", local: false });
  view.onDataUpdated();
  assert.ok(!link("知识库/失败.md", "打开"), "a failed download does not offer opening a missing file");
  assert.ok(link("知识库/失败.md", "重试") && link("知识库/失败.md", "同步并打开"));
  entries.pop();
  view.changeFilter("search", "AGALMA");
  const savesBeforeUnload = calls.filter(([type]) => type === "save").length;
  view.onunload();
  await Promise.resolve();
  assert.strictEqual(calls.filter(([type]) => type === "save").length, savesBeforeUnload + 1, "unload flushes pending filter persistence");
  assert.strictEqual(plugin.projectKnowledgeViews.size, 0);
  const restoredParent = new Element();
  const restored = new View({}, restoredParent, plugin);
  assert.deepStrictEqual(titles(restoredParent), [entries[1].title], "a new view restores saved filters");
  restored.onunload();
  const saveSettings = plugin.saveSettings;
  const reportError = console.error;
  const saveErrors = [];
  try {
    plugin.saveSettings = () => { throw new Error("save failed"); };
    console.error = (...args) => saveErrors.push(args);
    restored.changeFilter("search", "父亲", { debounce: true });
    restored.onunload();
    await restored.persistFilters();
    await Promise.resolve();
    assert.strictEqual(saveErrors.length, 1, "synchronous save failures are handled without an unhandled rejection");
  } finally { plugin.saveSettings = saveSettings; console.error = reportError; }
  console.log("Knowledge search burst: 3 inputs → 1 table render and 1 settings save");
  console.log("Knowledge Base migration, remote search, filters, single/bulk actions and live progress tests passed");
}
run().catch((error) => { console.error(error); process.exitCode = 1; });
