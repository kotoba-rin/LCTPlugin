const assert = require("assert");
const Module = require("module");

const menus = [];
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "obsidian") return {
    Plugin: class {}, FileView: class {}, ItemView: class {}, Component: class {},
    PluginSettingTab: class {}, Setting: class {}, Notice: class {},
    TFile: class {}, BasesView: class {}, normalizePath: (value) => value,
    Menu: class {
      constructor() { this.items = []; menus.push(this); }
      addItem(build) {
        const item = {
          setTitle(title) { this.title = title; return this; },
          setDisabled(disabled) { this.disabled = disabled; return this; },
          onClick(callback) { this.callback = callback; return this; },
        };
        build(item); this.items.push(item); return this;
      }
      showAtPosition(position) { this.position = position; }
    },
  };
  if (request === "@codemirror/view") return {};
  return originalLoad(request, parent, isMain);
};
const PluginClass = require("../src/main");
Module._load = originalLoad;

async function run() {
  const plugin = Object.create(PluginClass.prototype);
  const originalPath = "texts/s14-la-logique-du-fantasme/original/Leçon-12.md";
  const translationPath = originalPath.replace("/original/", "/translation/");
  const texts = {
    [originalPath]: "# Leçon 12\n\n<!-- id: s14-12-0085 -->\n\nAvant.\n\n<!-- id: s14-12-0086 -->\n\nSuite.",
    [translationPath]: "# 第十二课\n\n<!-- id: s14-12-0085 -->\n<!-- ids: s14-12-0085 s14-12-0086 -->\n\n合并译文。",
  };
  plugin.app = { vault: {
    getAbstractFileByPath: (path) => texts[path] ? { path, extension: "md" } : null,
    cachedRead: async (file) => texts[file.path],
  } };
  plugin.runWithNotice = (action) => action();
  let refreshed = 0;
  plugin.app.workspace = { getLeavesOfType: () => [
    { view: { getViewType: () => "lacan-bilingual-reading" } },
    { view: { render: () => { refreshed += 1; } } },
  ] };
  assert.doesNotThrow(() => plugin.refreshBilingualReadingViews(),
    "Obsidian's deferred background leaves must not prevent the plugin from loading");
  assert.strictEqual(refreshed, 1);
  const opened = [];
  const states = [];
  const position = { segmentId: "s14-12-0086", segmentIds: ["s14-12-0086"], language: "original" };
  const leaf = {
    openFile: async (file, options) => opened.push({ file, options }),
    setViewState: async (state) => states.push(state),
  };
  const bilingualView = {
    sourcePath: originalPath, leaf,
    getViewType: () => "lacan-bilingual-reading",
    getReadingPosition: () => position,
    lessonPaths: () => ({ originalPath, translationPath }),
    openMonolingual: (path) => plugin.openMonolingualReading(bilingualView, path),
  };
  leaf.view = bilingualView;
  assert.strictEqual(typeof plugin.openMonolingualReading, "function",
    "language switching must carry the current segment into the target Markdown view");
  await plugin.openMonolingualReading(bilingualView, translationPath);
  assert.strictEqual(opened[0].file.path, translationPath);
  assert.strictEqual(opened[0].options.state.mode, "preview");
  assert.strictEqual(opened[0].options.eState.scroll, 5,
    "a merged Chinese segment must resolve the French alias to its visible body line");
  assert.strictEqual(opened[0].options.eState.line, undefined,
    "restoring reading progress must use native scroll state without flashing a search result");
  await plugin.openMonolingualReading(bilingualView, originalPath);
  assert.strictEqual(opened[1].options.eState.scroll, 8);

  const button = {
    listeners: {}, attributes: {},
    setAttribute(key, value) { this.attributes[key] = value; },
    addEventListener(name, callback) { this.listeners[name] = callback; },
    getBoundingClientRect: () => ({ left: 120, bottom: 64 }),
  };
  const toolbar = {
    empty() {}, createEl: () => button,
    createSpan: () => ({ setAttribute() {} }),
  };
  plugin.renderReadingToolbarContent(toolbar, originalPath, leaf);
  button.listeners.click();
  assert.strictEqual(states.length, 0, "clicking bilingual reading while reading must not reset the view");
  assert.strictEqual(menus.length, 1);
  assert.deepStrictEqual(menus[0].items.map((item) => item.title), ["中文", "法语"]);
  assert.deepStrictEqual(menus[0].position, { x: 120, y: 64 });
  await menus[0].items[0].callback();
  assert.strictEqual(opened.at(-1).file.path, translationPath);

  leaf.view = {
    file: { path: originalPath }, getMode: () => "preview",
    currentMode: { getScroll: () => 8.3 },
    // Obsidian keeps this editor even in preview; its cursor is not the reading position.
    editor: { getCursor: () => ({ line: 0 }) },
  };
  await plugin.openBilingualReading(originalPath, leaf);
  assert.strictEqual(states[0].state.readingPosition.segmentId, "s14-12-0086");
  assert.strictEqual(states[0].state.readingPosition.language, "original");
  leaf.view.currentMode.getScroll = () => 0;
  await plugin.openBilingualReading(originalPath, leaf);
  assert.ok(!states[1].state.readingPosition, "a reader at the title must stay at the title");

  texts[translationPath] = "# 译文\n\n<!-- id: s14-12-0001 -->\n\n其他段落。";
  const beforeMissing = opened.length;
  await assert.rejects(() => plugin.openMonolingualReading(bilingualView, translationPath), /分段/);
  assert.strictEqual(opened.length, beforeMissing, "missing target IDs must leave the current reading view intact");
  console.log("reading navigation tests passed");
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
