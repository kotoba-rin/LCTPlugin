const assert = require("assert");
const Module = require("module");

class MockTFile {
  constructor(path) {
    this.path = path;
    this.extension = "md";
  }
}

const notices = [];
const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === "obsidian") {
    return {
      Plugin: class {},
      PluginSettingTab: class {},
      ItemView: class {},
      FileView: class {},
      Component: class {},
      TFile: MockTFile,
      Notice: class { constructor(message) { notices.push(message); } },
      normalizePath: (value) => String(value).replace(/\\/g, "/"),
    };
  }
  if (request === "@codemirror/view") return { WidgetType: class {} };
  return originalLoad(request, parent, isMain);
};
let PluginClass;
try {
  // Exercise source directly so regression tests can fail before rebuilding.
  PluginClass = require("../src/main");
} finally {
  Module._load = originalLoad;
}

class FakeTimers {
  constructor() {
    this.now = 0;
    this.nextId = 1;
    this.timers = new Map();
  }

  setTimeout(callback, delay) {
    const id = this.nextId++;
    this.timers.set(id, { callback, due: this.now + delay });
    return id;
  }

  clearTimeout(id) {
    this.timers.delete(id);
  }

  async advance(milliseconds) {
    const target = this.now + milliseconds;
    let callbacks = 0;
    while (true) {
      const next = [...this.timers].filter(([, timer]) => timer.due <= target)
        .sort((left, right) => left[1].due - right[1].due)[0];
      if (!next) break;
      assert.ok(++callbacks < 100, "progress maintenance must not create an endless timer loop");
      const [id, timer] = next;
      this.timers.delete(id);
      this.now = timer.due;
      await timer.callback();
    }
    this.now = target;
  }
}

const makeVault = (text = "") => {
  const plugin = Object.create(PluginClass.prototype);
  const translation = new MockTFile("texts/s8-le-transfert/translation/Leçon-01.md");
  const original = new MockTFile("texts/s8-le-transfert/original/Leçon-01.md");
  const texts = new Map([
    [translation.path, text],
    [original.path, "<!-- id: s8-01-0001 -->\nBonjour."],
  ]);
  const frontmatter = {};
  let writes = 0;
  plugin.app = {
    vault: {
      read: async (file) => texts.get(file.path),
      getAbstractFileByPath: (path) => path === translation.path ? translation : path === original.path ? original : null,
      modify: async (file, value) => { texts.set(file.path, value); },
      process: async (file, update) => { texts.set(file.path, update(texts.get(file.path))); },
    },
    metadataCache: { getFileCache: () => ({ frontmatter }) },
    fileManager: {
      processFrontMatter: async (file, update) => {
        update(frontmatter);
        writes += 1;
        plugin.handleModifiedFile(file);
      },
    },
  };
  plugin.segmentPreviewCache = new Map();
  plugin.progressTimers = new Map();
  plugin.progressWritePaths = new Set();
  plugin.progressDirtyPaths = new Set();
  plugin.progressWriteSuppressTimers = new Map();
  plugin.runWithNotice = async (action) => action();
  plugin.openFile = async () => {};
  return { plugin, translation, original, texts, frontmatter, writes: () => writes };
};

const tests = [
  ["preserve content written while an empty translation's original is loading", async () => {
    const { plugin, translation, original, texts } = makeVault();
    const read = plugin.app.vault.read;
    let originalReadStarted;
    let finishOriginalRead;
    const started = new Promise((resolve) => { originalReadStarted = resolve; });
    plugin.app.vault.read = async (file) => {
      if (file !== original) return read(file);
      originalReadStarted();
      return new Promise((resolve) => { finishOriginalRead = () => resolve(texts.get(file.path)); });
    };
    let opened = false;
    plugin.openFile = async () => { opened = true; };
    notices.length = 0;
    const filling = plugin.fillTranslationIfEmpty(translation, {
      updateProgress: false, openAfterCreate: true, notify: true, notifyExisting: true,
    });
    await started;
    texts.set(translation.path, "刚输入的中文译文，必须保留。");
    finishOriginalRead();
    await filling;
    assert.strictEqual(texts.get(translation.path), "刚输入的中文译文，必须保留。");
    assert.ok(opened, "the requested file must still open when filling is skipped");
    assert.deepStrictEqual(notices, ["译文文件已有内容，未覆盖。"]);
  }],
  ["fill a still-empty file and preserve a file already containing text", async () => {
    const { plugin, translation, texts } = makeVault(" \n");
    notices.length = 0;
    await plugin.fillTranslationIfEmpty(translation, { updateProgress: false, notify: true });
    assert.ok(texts.get(translation.path).includes("<!-- id: s8-01-0001 -->"));
    assert.ok(texts.get(translation.path).includes("<!-- untranslated -->"));
    assert.deepStrictEqual(notices, [`已填充译文骨架：${translation.path}`]);
    texts.set(translation.path, "已有译文。");
    plugin.app.vault.process = async () => { assert.fail("existing content needs no fill transaction"); };
    await plugin.fillTranslationIfEmpty(translation, { updateProgress: false });
    assert.strictEqual(texts.get(translation.path), "已有译文。");
  }],
  ["recompute progress for real edits made during generated-frontmatter suppression", async () => {
    const { plugin, translation, texts, frontmatter, writes } = makeVault(
      "<!-- id: s8-01-0001 -->\n<!-- untranslated -->"
    );
    const clock = new FakeTimers();
    const previousWindow = global.window;
    global.window = clock;
    try {
      await plugin.updateTranslationProgress(translation);
      assert.strictEqual(frontmatter.translation_progress, 0);
      await clock.advance(500);
      texts.set(translation.path, "<!-- id: s8-01-0001 -->\n你好。");
      plugin.handleModifiedFile(translation);
      await clock.advance(1000);
      assert.strictEqual(frontmatter.translation_progress, 100);
      assert.strictEqual(frontmatter.untranslated_count, 0);
      await clock.advance(10000);
      assert.strictEqual(writes(), 2, "trailing checks must stop once generated metadata is current");
      assert.strictEqual(clock.timers.size, 0);
    } finally {
      global.window = previousWindow;
    }
  }],
  ["a generated metadata event alone settles without repeated writes", async () => {
    const { plugin, translation, writes } = makeVault("<!-- id: s8-01-0001 -->\n你好。");
    const clock = new FakeTimers();
    const previousWindow = global.window;
    global.window = clock;
    try {
      await plugin.updateTranslationProgress(translation);
      await clock.advance(10000);
      assert.strictEqual(writes(), 1);
      assert.strictEqual(clock.timers.size, 0);
      assert.strictEqual(plugin.progressDirtyPaths.size, 0);
    } finally {
      global.window = previousWindow;
    }
  }],
];

(async () => {
  let failed = 0;
  for (const [name, test] of tests) {
    try {
      await test();
      console.log(`PASS ${name}`);
    } catch (error) {
      failed += 1;
      console.error(`FAIL ${name}`);
      console.error(error);
    }
  }
  process.exitCode = failed ? 1 : 0;
})();
