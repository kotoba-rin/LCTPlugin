const assert = require("assert");
const Module = require("module");
const { SegmentParser } = require("../segment-ai/segment-parser");

const originalLoad = Module._load;
const markdownRenders = [];
const components = [];
let renderGate = null;

class MockElement {
  constructor(tag = "div", options = {}) {
    this.tag = tag;
    this.className = options.cls || "";
    this.textContent = options.text || "";
    this.attributes = options.attr || {};
    this.children = [];
    this.dataset = {};
    this.listeners = {};
    this.scrollTop = 0;
    this.ownerDocument = { createElement: (name) => new MockElement(name) };
  }

  get childNodes() { return this.children; }
  empty() { this.children = []; this.scrollTop = 0; }
  replaceChildren(...children) { this.empty(); this.children = children; }
  addClass(value) { this.className += ` ${value}`; }
  appendChild(child) { this.children.push(child); return child; }
  insertBefore(child, before) {
    this.children = this.children.filter((element) => element !== child);
    this.children.splice(this.children.indexOf(before), 0, child);
    return child;
  }
  querySelector(selector) { return this.children.find((child) => child.className === selector.slice(1)) || null; }
  remove() { this.removed = true; }
  createEl(tag, options) { return this.appendChild(new MockElement(tag, options)); }
  createDiv(options) { return this.createEl("div", options); }
  createSpan(options) { return this.createEl("span", options); }
  addEventListener(name, listener) { this.listeners[name] = listener; }
}

Module._load = function load(request, parent, isMain) {
  if (request === "obsidian") {
    return {
      ItemView: class {
        constructor(leaf) { this.leaf = leaf; this.contentEl = leaf.contentEl; }
        async setState() {}
      },
      FileView: class {
        constructor(leaf) { this.leaf = leaf; this.contentEl = leaf.contentEl; this.file = null; this.navigation = true; this.actions = []; }
        getState() { return { file: this.file?.path || "" }; }
        addAction(icon, title, callback) { this.actions.push({ icon, title, callback }); }
        async setState(state) {
          const file = this.plugin.app.vault.getAbstractFileByPath(state.file) || null;
          if (file !== this.file) {
            if (this.file) { await this.onUnloadFile(this.file); }
            this.file = file;
            if (file) { await this.onLoadFile(file); }
          }
        }
        async onRename() { this.nativeRenameTitle = this.getDisplayText(); }
        async onClose() { if (this.file) { await this.onUnloadFile(this.file); } this.file = null; this.nativeClosed = true; }
      },
      Component: class {
        constructor() { components.push(this); this.unloads = 0; }
        load() { this.loaded = true; }
        unload() { this.unloads += 1; }
      },
      Scope: class {
        constructor(parent) { this.parent = parent; this.keys = []; }
        register(modifiers, key, callback) { this.keys.push({ modifiers, key, callback }); }
      },
      MarkdownRenderer: {
        async render(app, markdown, element, sourcePath, component) {
          markdownRenders.push({ markdown, sourcePath, component });
          if (renderGate) { await renderGate; }
          element.textContent = markdown;
        },
      },
      normalizePath: (value) => value.replace(/\\/g, "/"),
    };
  }
  return originalLoad(request, parent, isMain);
};

const {
  LACAN_BILINGUAL_VIEW_TYPE,
  LacanBilingualReadingView,
  pairBilingualBlocks,
  blockReadingMarkdown,
} = require("../src/bilingual-reading-view");
Module._load = originalLoad;

const originalPath = "texts/s7-ethique/original/Leçon-01.md";
const translationPath = originalPath.replace("/original/", "/translation/");
const originalText = [
  "# Leçon 01 | 18 Novembre 1959",
  "<!-- id: s7-01-0001 -->",
  "Bonjour [^1]. ![figure](assets/figure.png)",
  "<!-- id: s7-01-0002 -->",
  "Deuxième.",
  "<!-- id: s7-01-0003 -->",
  "Troisième.",
  "[^1]: Note française.",
  "    Suite de la note.",
].join("\n\n");
const translationText = [
  "# 第一课",
  "<!-- id: s7-01-0001 -->",
  "你好 [^1]。",
  "> 注释保留。\n> $$a+b$$",
  "<!-- id: s7-01-0002 -->",
  "<!-- ids: s7-01-0002 s7-01-0003 -->",
  "合并译文。",
  "[^1]: 中文注释。",
].join("\n\n");

const run = async () => {
  const parser = new SegmentParser();
  const originals = parser.parse(originalText, originalPath);
  const translations = parser.parse(translationText, translationPath);
  const pairs = pairBilingualBlocks(originals, translations);
  assert.strictEqual(pairs.length, 2, "merged Chinese must appear once for both French segments");
  assert.deepStrictEqual(pairs[1].originals.map((block) => block.primaryId), ["s7-01-0002", "s7-01-0003"]);
  assert.deepStrictEqual(pairs[1].translations.map((block) => block.primaryId), ["s7-01-0002"]);
  assert.deepStrictEqual(pairs[1].ids, ["s7-01-0002", "s7-01-0003"]);
  assert.strictEqual(pairBilingualBlocks(originals, []).length, 3);
  assert.strictEqual(pairBilingualBlocks([], translations).length, 2);
  assert.throws(() => pairBilingualBlocks([originals[0], originals[0]], translations), /出现多次/);
  const prepared = blockReadingMarkdown(originals[0], originalText, "fr-s7-01-0001");
  assert.ok(prepared.includes("[^fr-s7-01-0001-1]: Note française."));
  assert.ok(prepared.includes("    Suite de la note."));
  assert.ok(!blockReadingMarkdown(originals[2], originalText, "fr-last").includes("Note française"));
  for (const wrapper of ["\n\n## Notes", "## Notes", "\n\n---\n\n## Notes"]) {
    assert.strictEqual(blockReadingMarkdown({ markdown: `Dernière phrase.${wrapper}\n\n[^1]: Note.` }, "[^1]: Note.", "last"), "Dernière phrase.");
  }
  assert.strictEqual(blockReadingMarkdown({ markdown: "Une section.\n\n## Notes\n\nAnnotation conservée." }, "", "body"), "Une section.\n\n## Notes\n\nAnnotation conservée.");

  const files = new Map([
    [originalPath, { path: originalPath, extension: "md", content: originalText }],
    [translationPath, { path: translationPath, extension: "md", content: translationText }],
  ]);
  let modifyListener;
  let removedEvent = null;
  const aiCalls = [];
  const plugin = {
    settings: { segmentAiEnabled: true },
    app: { vault: {
      getAbstractFileByPath: (pathname) => files.get(pathname),
      cachedRead: async (file) => file.content,
      on: (name, listener) => { modifyListener = listener; return "modify-listener"; },
      offref: (ref) => { removedEvent = ref; },
    } },
    pathsFromOriginal: (pathname) => pathname.includes("/original/") ? { originalPath: pathname, translationPath: pathname.replace("/original/", "/translation/") } : null,
    pathsFromTranslation: (pathname) => pathname.includes("/translation/") ? { originalPath: pathname.replace("/translation/", "/original/"), translationPath: pathname } : null,
    renderReadingToolbar() {},
    openMonolingualReading: (sourceView, path, options) => (
      sourceView.leaf.openFile(files.get(path), options)
    ),
    createSegmentAiPreviewControl: (pathname, id) => {
      const element = new MockElement("button", { text: "Ф" });
      element.listeners.click = () => aiCalls.push({ pathname, id });
      return element;
    },
  };
  const openedFiles = [];
  const restoredRoot = new MockElement();
  let restoredScrollTop = 0;
  Object.defineProperty(restoredRoot, "scrollTop", {
    get: () => restoredScrollTop,
    set: (value) => {
      restoredScrollTop = restoredRoot.children.some((element) => element.className === "lacan-bilingual-pairs") ? value : 0;
    },
  });
  const restoredView = new LacanBilingualReadingView({ contentEl: restoredRoot }, plugin);
  await restoredView.setState({ sourcePath: originalPath, scrollTop: 144 });
  assert.strictEqual(restoredRoot.scrollTop, 144, "restoration must wait until the scrollable lesson body exists");
  await restoredView.onClose();
  markdownRenders.length = 0;
  components.length = 0;
  const leaf = { contentEl: new MockElement(), openFile: async (file, options) => openedFiles.push({ path: file.path, options }) };
  const view = new LacanBilingualReadingView(leaf, plugin);
  assert.strictEqual(view.navigation, true, "bilingual reading must retain file navigation");
  assert.strictEqual(view.getViewType(), LACAN_BILINGUAL_VIEW_TYPE);
  assert.strictEqual(typeof view.showSearch, "function", "Obsidian's Find command must be able to open search in the bilingual view");
  await view.onOpen();
  await view.setState({ sourcePath: translationPath, scrollTop: 81 });
  const searchActions = [];
  view.readingSearch = {
    isOpen: true,
    open: () => searchActions.push("open"),
    move: (direction) => searchActions.push(direction),
    close: () => searchActions.push("close"),
  };
  view.showSearch();
  const searchKey = (key, shift = false) => view.scope.keys.find((binding) => (
    binding.key === key && binding.modifiers.includes("Shift") === shift
  ));
  assert.strictEqual(searchKey("g").callback({}), false);
  assert.strictEqual(searchKey("g", true).callback({}), false);
  assert.strictEqual(searchKey("Escape").callback({ target: { closest: () => ({}) } }), undefined,
    "Escape inside an inline editor must remain available to cancel editing");
  assert.strictEqual(searchKey("Escape").callback({}), false);
  assert.deepStrictEqual(searchActions, ["open", 1, -1, "close"]);
  view.readingSearch.isOpen = false;
  assert.strictEqual(searchKey("g").callback({}), undefined, "closed find must not consume navigation keys");
  view.readingSearch = null;
  assert.strictEqual(view.file, files.get(translationPath), "native breadcrumbs must remain attached to the source markdown");
  assert.deepStrictEqual(view.getState(), { file: translationPath, sourcePath: translationPath, scrollTop: 81 });
  const pairsEl = leaf.contentEl.children.find((element) => element.className === "lacan-bilingual-pairs");
  assert.strictEqual(pairsEl.children.length, 2);
  assert.deepStrictEqual(pairsEl.children[1].children.map((element) => element.attributes.lang), ["fr", "fr", "zh"]);
  const firstPair = pairsEl.children[0];
  firstPair.children[0].children[0].children[1].listeners.click();
  firstPair.children[1].children[0].children[1].listeners.click();
  assert.deepStrictEqual(aiCalls, [
    { pathname: originalPath, id: "s7-01-0001" },
    { pathname: translationPath, id: "s7-01-0001" },
  ], "each language must pass its own source file to the Φ action");
  assert.strictEqual(markdownRenders.length, 5);
  assert.ok(markdownRenders.every((render) => !render.markdown.includes("<!--")));
  assert.ok(markdownRenders[0].markdown.includes("![figure](assets/figure.png)"));
  assert.strictEqual(markdownRenders[0].sourcePath, originalPath);
  assert.ok(markdownRenders[1].markdown.includes("> 注释保留。\n> $$a+b$$"));
  assert.ok(markdownRenders[1].markdown.includes("[^zh-s7-01-0001-1]: 中文注释。"));
  assert.strictEqual(leaf.contentEl.children[0].children[0].tag, "h1",
    "language options belong in the toolbar popup, leaving only the title in the reading header");
  assert.strictEqual(pairsEl.children[1].children[1].dataset.segmentId, "s7-01-0003",
    "each French lane must keep its exact ID within a merged pair");
  assert.strictEqual(pairsEl.children[1].children[2].dataset.segmentIds, "s7-01-0002 s7-01-0003");
  await view.openMonolingual(translationPath);
  await view.openMonolingual(originalPath);
  assert.deepStrictEqual(openedFiles.map((file) => file.path), [translationPath, originalPath], "language buttons must open their corresponding markdown in the same leaf");
  assert.strictEqual(view.actions.length, 1, "native header must retain a reading action");
  await view.actions[0].callback();
  assert.deepStrictEqual(openedFiles[2], { path: translationPath, options: { state: { mode: "preview" } } });

  leaf.contentEl.scrollTop = 0;
  assert.strictEqual(view.getState().scrollTop, 0, "scrolling to the top must override an older saved position");
  plugin.settings.segmentAiEnabled = false;
  await view.render();
  const noAiPairs = leaf.contentEl.children.find((element) => element.className === "lacan-bilingual-pairs");
  assert.strictEqual(noAiPairs.children[0].children[0].children[0].children.length, 1);
  assert.ok(components.slice(0, 5).every((component) => component.unloads === 1));
  assert.strictEqual(view.getState().scrollTop, 0);

  files.delete(translationPath);
  await view.render();
  const missingPairs = leaf.contentEl.children.find((element) => element.className === "lacan-bilingual-pairs");
  assert.strictEqual(missingPairs.children[0].children[1].children[0].textContent, "[没有对应中文译文]");
  files.set(translationPath, { path: translationPath, extension: "md", content: "<!-- id: s7-01-0001 -->\n\n<!-- untranslated -->" });
  await view.render();
  const untranslatedPairs = leaf.contentEl.children.find((element) => element.className === "lacan-bilingual-pairs");
  assert.strictEqual(untranslatedPairs.children[0].children[1].children[1].children[0].textContent, "[该段尚未翻译]");

  const childrenBeforeInlineEdit = [...leaf.contentEl.children];
  plugin.translationInlineEditor = { isActiveWithin: () => true };
  await view.render();
  assert.deepStrictEqual(leaf.contentEl.children, childrenBeforeInlineEdit, "file changes must not replace an active inline editor");
  assert.strictEqual(view.pendingInlineRefresh, true);
  plugin.translationInlineEditor.isActiveWithin = () => false;
  await view.render();
  assert.strictEqual(view.pendingInlineRefresh, false, "closing the editor lets deferred changes render");
  delete plugin.translationInlineEditor;

  // Like Chromium, clearing a scroll container clamps its position to zero.
  // Saving and the delayed vault modify event can refresh the same view together.
  leaf.contentEl.scrollTop = 640;
  let releaseOverlappingRender;
  renderGate = new Promise((resolve) => { releaseOverlappingRender = resolve; });
  const visibleLesson = [...leaf.contentEl.children];
  const firstRefresh = view.render();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepStrictEqual(leaf.contentEl.children, visibleLesson, "a pending refresh must keep the mounted lesson visible");
  assert.strictEqual(leaf.contentEl.scrollTop, 640, "a pending refresh must keep the mounted lesson scrollable");
  const secondRefresh = view.render();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepStrictEqual(leaf.contentEl.children, visibleLesson, "a newer refresh must leave the visible lesson intact until ready");
  releaseOverlappingRender();
  await Promise.all([firstRefresh, secondRefresh]);
  renderGate = null;
  assert.strictEqual(leaf.contentEl.scrollTop, 640, "overlapping save and file-change refreshes must retain the reading position");

  let finishScrolledRender;
  renderGate = new Promise((resolve) => { finishScrolledRender = resolve; });
  const scrolledRefresh = view.render();
  await new Promise((resolve) => setImmediate(resolve));
  leaf.contentEl.scrollTop = 420;
  finishScrolledRender();
  await scrolledRefresh;
  renderGate = null;
  assert.strictEqual(leaf.contentEl.scrollTop, 420, "scrolling during a refresh must retain the reader's latest position");

  let finishEditedRender;
  renderGate = new Promise((resolve) => { finishEditedRender = resolve; });
  const editedRefresh = view.render();
  await new Promise((resolve) => setImmediate(resolve));
  const lessonBeforeEditor = [...leaf.contentEl.children];
  const mountedComponents = [...view.markdownComponents];
  plugin.translationInlineEditor = { isActiveWithin: () => true };
  finishEditedRender();
  await editedRefresh;
  renderGate = null;
  assert.deepStrictEqual(leaf.contentEl.children, lessonBeforeEditor, "opening an editor during rendering must prevent replacement");
  assert.ok(mountedComponents.every((component) => component.unloads === 0), "discarding a staged render must keep mounted Markdown resources alive");
  assert.strictEqual(view.pendingInlineRefresh, true);
  delete plugin.translationInlineEditor;
  await view.render();

  let failRender;
  renderGate = new Promise((resolve, reject) => { failRender = reject; });
  const lessonBeforeFailure = [...leaf.contentEl.children];
  const componentsBeforeFailure = [...view.markdownComponents];
  const failedRefresh = view.render();
  await new Promise((resolve) => setImmediate(resolve));
  failRender(new Error("Markdown rendering failed"));
  await failedRefresh;
  renderGate = null;
  assert.deepStrictEqual(leaf.contentEl.children.slice(0, lessonBeforeFailure.length), lessonBeforeFailure, "failed rendering must retain the last readable lesson");
  assert.strictEqual(leaf.contentEl.scrollTop, 420);
  assert.ok(componentsBeforeFailure.every((component) => component.unloads === 0), "a failed staged render must not unload the visible lesson");

  let releaseRender;
  renderGate = new Promise((resolve) => { releaseRender = resolve; });
  const pending = view.render();
  await new Promise((resolve) => setImmediate(resolve));
  await view.onClose();
  releaseRender();
  await pending;
  renderGate = null;
  assert.strictEqual(removedEvent, "modify-listener");
  assert.ok(components.every((component) => component.unloads === 1), "closing during rendering must unload every Markdown component exactly once");
  assert.strictEqual(view.markdownComponents.size, 0);
  assert.strictEqual(view.nativeClosed, true, "closing must release native FileView resources");

  const nativeStateView = new LacanBilingualReadingView({ contentEl: new MockElement() }, plugin);
  await nativeStateView.setState({ file: originalPath, scrollTop: 30 });
  assert.strictEqual(nativeStateView.getState().sourcePath, originalPath, "native file-only history states must restore bilingual reading");
  await nativeStateView.setState({ file: originalPath, scrollTop: 46 });
  assert.strictEqual(nativeStateView.getState().scrollTop, 46, "same-file navigation must restore the requested position");
  nativeStateView.file.path = originalPath.replace("Leçon-01.md", "Leçon-02.md");
  await nativeStateView.onRename(nativeStateView.file);
  assert.strictEqual(nativeStateView.nativeRenameTitle, "Leçon-02 · 双语阅读", "native rename must update the tab title from the current source path");
  nativeStateView.file.path = originalPath;
  await nativeStateView.onClose();

  const navigationRoot = new MockElement();
  navigationRoot.getBoundingClientRect = () => ({ top: 100, bottom: 600 });
  navigationRoot.querySelectorAll = () => {
    const lanes = [];
    const visit = (element) => {
      if (element.dataset?.language) {
        const top = Number(element.dataset.segmentId.slice(-4)) * 200
          + (element.dataset.language === "translation" ? 60 : 0) - navigationRoot.scrollTop;
        element.getBoundingClientRect = () => ({ top: 100 + top, bottom: 160 + top, height: 60 });
        lanes.push(element);
      }
      element.children.forEach(visit);
    };
    navigationRoot.children.forEach(visit);
    return lanes;
  };
  const navigationView = new LacanBilingualReadingView({ contentEl: navigationRoot }, plugin);
  const readingPosition = { segmentId: "s7-01-0003", segmentIds: ["s7-01-0003"], language: "original" };
  await navigationView.onOpen();
  await navigationView.setState({ sourcePath: originalPath, readingPosition });
  assert.strictEqual(navigationRoot.scrollTop, 600, "opening bilingual reading must restore the requested segment after rendering");
  assert.deepStrictEqual(navigationView.getState().readingPosition, readingPosition,
    "history states retain the reading segment ID and language");
  await navigationView.onClose();

  const invalid = new LacanBilingualReadingView({ contentEl: new MockElement() }, plugin);
  await invalid.setState({ sourcePath: "../texts/s7/original/Leçon-01.md" });
  assert.strictEqual(invalid.getState().sourcePath, "");
  assert.ok(invalid.contentEl.children[0].textContent.includes("请从研讨班"));
  await invalid.onClose();
  console.log("bilingual reading tests passed");
};

run().catch((error) => { console.error(error); process.exitCode = 1; });
