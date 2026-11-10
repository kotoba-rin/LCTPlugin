const assert = require("assert");
const Module = require("module");
const { PROJECT_BASE_PATH, PROJECT_BASE_CONTENT } = require("../src/project-library-base");
const { formatSkipNotice } = require("../src/project-sync-status");

class TFile { constructor(path) { this.path = path; } }
class Element {
  constructor(tag = "div", options = {}) {
    this.tag = tag; this.className = options.cls || ""; this.textContent = options.text || "";
    this.children = []; this.attributes = {}; this.dataset = {}; this.events = new Map();
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
const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === "obsidian") return {
    Plugin: class {}, PluginSettingTab: class {}, BasesView: class {}, Component: class {},
    ItemView: class {}, FileView: class {}, MarkdownView: class {}, Setting: class {}, TFile,
    Notice: class { setMessage() {} hide() {} }, normalizePath: (path) => path,
  };
  if (request === "@codemirror/view") return { WidgetType: class {} };
  return originalLoad(request, parent, isMain);
};
let Plugin;
try { Plugin = require("../main.js"); } finally { Module._load = originalLoad; }

const first = "texts/s99/original/Leçon-01.md";
const translated = first.replace("/original/", "/translation/");
const catalog = {
  version: "v1", lessonCount: 2,
  seminars: [{ slug: "s99", code: "s99", order: 99, title: "s99", glossaryPath: "texts/s99/glossary.md",
    lessons: [1, 2].map((number) => ({ title: `s99-${number} · Leçon 0${number}`, originalPath: `texts/s99/original/Leçon-0${number}.md`, translationPath: `texts/s99/translation/Leçon-0${number}.md` })) }],
};
const result = { version: "v1", added: 2, updated: 0, deleted: 0, merged: 0, unchanged: 0, conflicts: [], scopePaths: [first, translated] };

function setup() {
  const plugin = Object.create(Plugin.prototype);
  const files = new Map();
  const writes = [];
  const calls = [];
  plugin.settings = { projectLessonSync: {} };
  plugin.projectCatalogViews = new Set();
  plugin.app = { vault: {
    getAbstractFileByPath: (path) => files.get(path),
    create: async (path, contents) => { writes.push({ path, contents }); const file = new TFile(path); files.set(path, file); return file; },
  } };
  plugin.openFile = async (file) => calls.push(["open", file.path]);
  plugin.ensureFolder = async (path) => calls.push(["folder", path]);
  plugin.saveSettings = async () => calls.push(["save"]);
  plugin.refreshReadingAfterRepositorySync = () => calls.push(["refresh-reading"]);
  const engine = {
    cleanupLegacyBaseCache: async () => { calls.push(["cleanup-cache"]); return 0; },
    readCachedCatalog: async () => null,
    getCatalog: async () => { calls.push(["catalog"]); return catalog; },
    initializeSeminar: async (slug) => { calls.push(["glossary", slug]); return { ...result, added: 1 }; },
    syncLesson: async (path) => {
      calls.push(["pair", path]);
      for (const event of [{ phase: "downloading", completed: 1, total: 2 }, { phase: "applying", completed: 1, total: 2 }, { phase: "complete", completed: 2, total: 2 }]) engine.onProgress?.(event);
      return result;
    },
    sync: () => assert.fail("the plugin must never invoke whole-library sync"),
  };
  plugin.createProjectSyncEngine = (onProgress) => { engine.onProgress = onProgress; return engine; };
  return { plugin, engine, files, writes, calls };
}

async function run() {
  const { plugin, engine, files, writes, calls } = setup();
  await plugin.initializeProjectLibrary();
  assert.strictEqual(calls.filter(([name]) => name === "cleanup-cache").length, 1, "startup migrates legacy text caches before reading the library");
  assert.strictEqual(plugin.projectCatalog.lessonCount, 2, "an empty vault must have the entire remote catalog");
  assert.deepStrictEqual(writes.map((entry) => entry.path), [PROJECT_BASE_PATH], "installation writes only the Base, never lesson stubs");
  assert.strictEqual(writes[0].contents, PROJECT_BASE_CONTENT);
  assert.ok(!/name: (reader|editer)|mode:/.test(PROJECT_BASE_CONTENT));
  await plugin.ensureProjectBase();
  assert.strictEqual(writes.length, 1, "existing Bases must not be overwritten");
  await plugin.syncProjectContent();
  assert.strictEqual(calls.filter(([name]) => name === "catalog").length, 2, "legacy Sync command refreshes only metadata");
  assert.ok(!calls.some(([name]) => name === "pair"));

  await plugin.initializeProjectSeminar("s99");
  assert.deepStrictEqual(calls.filter(([name]) => name === "folder").map(([, path]) => path), ["original", "translation", "notes", "assets"].map((folder) => `texts/s99/${folder}`));
  assert.ok(calls.some(([name, slug]) => name === "glossary" && slug === "s99"));
  assert.ok(!calls.some(([name]) => name === "pair"), "seminar initialization must not download lessons");

  let descriptor;
  plugin.registerBasesView = (_type, options) => { descriptor = options; };
  plugin.registerProjectBasesView();
  const parent = new Element();
  const view = descriptor.factory({}, parent);
  let nodes = parent.descendants();
  assert.ok(nodes.some((node) => node.textContent.includes("2 个课次")), "remote catalog is visible even with zero local MD files");
  assert.ok(nodes.some((node) => node.tag === "a" && node.textContent === "初始化研讨班"));
  assert.ok(!nodes.some((node) => node.textContent === "批量新建译文"));
  const details = nodes.find((node) => node.tag === "details");
  details.open = true; details.events.get("toggle")();
  nodes = parent.descendants();
  assert.strictEqual(nodes.filter((node) => node.tag === "a" && node.textContent === "同步").length, 2);
  assert.ok(!nodes.some((node) => node.tag === "a" && ["笔记", "新建翻译"].includes(node.textContent)));
  assert.deepStrictEqual(nodes.filter((node) => node.className === "lacan-bases-progress").map((node) => node.textContent), ["0%", "0%"]);
  const search = nodes.find((node) => node.tag === "input");
  search.value = "Leçon 02";
  search.events.get("input")();
  assert.deepStrictEqual(parent.descendants().filter((node) => node.className === "lacan-bases-entry-title").map((node) => node.textContent), ["s99-2 · Leçon 02"]);
  search.value = ""; search.events.get("input")();

  const percentages = [];
  const setProgress = plugin.setLessonSyncPercent.bind(plugin);
  plugin.setLessonSyncPercent = (path, percent) => { percentages.push(percent); setProgress(path, percent); };
  await plugin.syncProjectLesson(first);
  assert.ok(calls.some(([name, path]) => name === "pair" && path === first));
  assert.deepStrictEqual(percentages, [0, 35, 82, 99, 100]);
  assert.strictEqual(plugin.getLessonSyncPercent(first), 100);
  assert.strictEqual(plugin.getLessonSyncPercent(catalog.seminars[0].lessons[1].originalPath), 0);
  assert.strictEqual(plugin.settings.projectLessonSync[first].version, "v1");
  assert.strictEqual(plugin.syncInProgress, false);

  percentages.length = 0;
  engine.syncLesson = async () => {
    for (const event of [
      { phase: "downloading", completed: 2, total: 2 },
      { phase: "downloading", completed: 0, total: 13 },
      { phase: "downloading", completed: 1, total: 13 },
      { phase: "applying", completed: 15, total: 15 },
    ]) engine.onProgress(event);
    return result;
  };
  await plugin.syncProjectLesson(first);
  assert.deepStrictEqual(percentages, [0, 65, 65, 65, 99, 100], "discovering referenced assets must not move progress backwards");

  const oldConflict = { path: translated, kind: "local_modified" };
  const skippedFiles = [
    { path: translated, reason: "local_modified" },
    { path: first, reason: "paired_file_modified", triggerPath: translated },
  ];
  engine.syncLesson = async () => ({ ...result, added: 0, skippedFiles, conflicts: [oldConflict] });
  await plugin.syncProjectLesson(first);
  assert.strictEqual(plugin.getLessonSyncPercent(first), 0, "skipped must not be reported as successfully synced");
  assert.strictEqual(plugin.settings.projectLessonSync[first].status, "skipped");
  assert.strictEqual(plugin.settings.projectLessonSync[first].version, undefined, "a previous successful version cannot survive on a skipped row");
  assert.strictEqual(plugin.settings.projectSyncLastResult.skippedCount, 2);
  assert.strictEqual(plugin.settings.projectSyncLastResult.conflictCount, 1, "old records remain distinguishable from new skips");
  assert.ok(parent.descendants().some((node) => node.textContent === "已跳过"));
  plugin.projectLessonSyncProgress.delete(first);
  assert.strictEqual(plugin.getLessonSyncPercent(first), 0, "reloading must not restore the old 100% after a skip");
  const message = formatSkipNotice(skippedFiles);
  assert.ok(message.includes(translated));
  assert.ok(!message.includes(first), "the notice must identify the edited translation, not tell the user to delete its unchanged partner");
  assert.ok(!message.includes("冲突"));
  assert.ok(formatSkipNotice([{ path: translated, reason: "unsaved_changes" }]).includes("保存或关闭未保存的编辑"));

  await assert.rejects(() => view.openDownloadedFile(first), /请先点击同步/);
  files.set(first, new TFile(first));
  await view.openDownloadedFile(first);
  engine.syncLesson = async () => { throw new Error("second file network failure"); };
  await assert.rejects(() => plugin.syncProjectLesson(first), /second file/);
  assert.strictEqual(plugin.getLessonSyncPercent(first), 0);
  assert.strictEqual(plugin.syncInProgress, false);
  view.onunload();
  assert.strictEqual(plugin.projectCatalogViews.size, 0);

  const cached = setup();
  cached.files.set(PROJECT_BASE_PATH, new TFile(PROJECT_BASE_PATH));
  cached.engine.readCachedCatalog = async () => catalog;
  await cached.plugin.initializeProjectLibrary();
  assert.ok(!cached.calls.some(([name]) => name === "catalog"), "offline cached catalog opens without an automatic content request");
  const reload = setup();
  const savedState = { type: "bases", state: { file: PROJECT_BASE_PATH, viewName: "custom" } };
  const states = [];
  reload.plugin.app.workspace = { getLeavesOfType: () => [
    { view: { file: { path: PROJECT_BASE_PATH } }, getViewState: () => savedState, setViewState: async (state) => states.push(state) },
    { view: { file: { path: "my-other.base" } }, setViewState: () => assert.fail("unrelated Base must not be reopened") },
  ] };
  await reload.plugin.reloadProjectBaseViews();
  await reload.plugin.reloadProjectBaseViews();
  assert.deepStrictEqual(states, [{ type: "empty" }, savedState], "hot reload replaces a stale custom view once, preserving the leaf's saved state");
  console.log("Project Base initialization, remote inventory, seminar setup and paired sync UI tests passed");
}
run().catch((error) => { console.error(error); process.exitCode = 1; });
