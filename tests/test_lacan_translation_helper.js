const assert = require("assert");
const Module = require("module");
const path = require("path");

const originalLoad = Module._load;

class MockPlugin {}
class MockTFile {}

const mockNormalizePath = (value) => {
  const normalized = String(value || "")
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .replace(/^\.\//, "");
  return normalized || "/";
};

Module._load = function load(request, parent, isMain) {
  if (request === "obsidian") {
    return {
      BasesView: class {},
      Component: class {
        load() {}
        unload() {}
      },
      Notice: class {},
      ItemView: class {
        constructor(leaf) {
          this.leaf = leaf;
          this.containerEl = leaf?.containerEl;
        }
      },
      FileView: class {},
      MarkdownView: class {},
      MarkdownRenderer: {
        async render() {},
      },
      Plugin: MockPlugin,
      PluginSettingTab: class {},
      Setting: class {},
      TFile: MockTFile,
      normalizePath: mockNormalizePath,
    };
  }
  if (request === "@codemirror/view") {
    return {
      Decoration: {
        none: [],
        set(ranges) {
          return ranges;
        },
        widget(options) {
          return {
            range(from) {
              return { from, to: from, value: options };
            },
          };
        },
      },
      ViewPlugin: {
        fromClass(cls, spec) {
          return { cls, spec };
        },
      },
      WidgetType: class {},
    };
  }
  return originalLoad(request, parent, isMain);
};

const run = async () => {
try {
  const PluginClass = require(path.join(
    __dirname,
    "..",
    "main.js"
  ));
  const plugin = Object.create(PluginClass.prototype);
  assert.strictEqual(mockNormalizePath(""), "/");

  const graphPlugin = Object.create(PluginClass.prototype);
  graphPlugin.projectGraphViews = new WeakSet();
  let graphUpdates = 0;
  let graphSaves = 0;
  let graphReveals = 0;
  let graphOptions = { search: "file:README", linkDistance: 250, scale: 0.4 };
  const graphLeaf = {
    view: {
      getViewType: () => "graph",
      dataEngine: {
        getOptions: () => graphOptions,
        setOptions: (options) => { graphOptions = options; graphUpdates += 1; },
      },
    },
  };
  const localGraphLeaf = {
    view: { dataEngine: { setOptions: () => assert.fail("local graph must be unchanged") } },
  };
  const graphCore = {
    enabled: true,
    instance: { options: {}, saveOptions: () => { graphSaves += 1; } },
  };
  graphPlugin.app = {
    internalPlugins: { getPluginById: () => graphCore },
    workspace: {
      getLeavesOfType: (type) => type === "graph" ? [graphLeaf] : [localGraphLeaf],
      revealLeaf: async (leaf) => { assert.strictEqual(leaf, graphLeaf); graphReveals += 1; },
      getLeaf: () => assert.fail("reuse the existing graph tab"),
    },
  };
  await graphPlugin.openProjectGraph();
  assert.strictEqual(graphReveals, 1);
  assert.strictEqual(graphSaves, 1);
  assert.strictEqual(graphOptions.linkDistance, 250, "preserve graph layout preferences");
  assert.strictEqual(graphOptions.scale, 0.4);
  assert.strictEqual(graphOptions.hideUnresolved, true);
  assert.strictEqual(graphOptions.showOrphans, false);
  assert.strictEqual(graphOptions.showAttachments, false);
  assert.strictEqual(graphOptions.showTags, false);
  assert.ok(graphOptions.search.includes(" OR "), "include cards and translations together");
  assert.ok(graphOptions.search.includes("-file:/^(README|index|SUMMARY)"));
  const pathPatterns = graphOptions.colorGroups.map(({ query }) => new RegExp(query.slice(6, -1)));
  for (const [file, included] of [
    ["知识库/对象a.md", true],
    ["texts/s8-le-transfert/translation/Leçon-01.md", true],
    ["texts/Écricts/translation/Article-01.md", true],
    ["texts/s8-le-transfert/original/Leçon-01.md", false],
    ["texts/s8-le-transfert/notes/阅读笔记.md", false],
    ["texts/s8-le-transfert/glossary.md", false],
    ["output/book/知识库/对象a.md", false],
    ["tmp/texts/s8-le-transfert/translation/Leçon-01.md", false],
    ["知识库/图片.png", false],
  ]) {
    assert.strictEqual(pathPatterns.some((pattern) => pattern.test(file)), included, file);
  }
  const excludedNames = new RegExp(graphOptions.search.split("-file:/")[1].slice(0, -1), "i");
  for (const name of ["README.md", "readme.md", "README", "index.md", "SUMMARY.md"]) {
    assert.ok(excludedNames.test(name), `exclude ${name}`);
  }
  graphOptions.search = "file:对象a";
  const updatesBeforeLayoutChange = graphUpdates;
  graphPlugin.applyProjectGraphToViews();
  assert.strictEqual(graphUpdates, updatesBeforeLayoutChange, "do not reset a user's active filter on every layout event");
  assert.strictEqual(graphOptions.search, "file:对象a");
  await graphPlugin.openProjectGraph();
  assert.ok(graphOptions.search.includes(" OR "), "the command reapplies the project filter");
  graphCore.enabled = false;
  await assert.rejects(() => graphPlugin.openProjectGraph(), /核心插件/);
  graphLeaf.view.dataEngine = {};
  assert.doesNotThrow(() => graphPlugin.applyProjectGraphToViews({ force: true }));

  let resolveMcpPreflight;
  let mcpPreflightCalls = 0;
  let mcpSettingsSaves = 0;
  plugin.settings = {
    segmentAiEnabled: true,
    segmentAiMcpServerCatalog: [],
    segmentAiMcpEnabledServers: [],
  };
  plugin.segmentAiRuntime = {
    preflightMcpServers() {
      mcpPreflightCalls += 1;
      return new Promise((resolve) => {
        resolveMcpPreflight = resolve;
      });
    },
  };
  plugin.saveSettings = async () => {
    mcpSettingsSaves += 1;
  };
  const scheduledMcpPreflight =
    plugin.scheduleSegmentAiMcpBackgroundCheck();
  assert.ok(
    scheduledMcpPreflight instanceof Promise,
    "plugin startup should schedule MCP preflight without awaiting it"
  );
  assert.strictEqual(mcpPreflightCalls, 1);
  resolveMcpPreflight({
    status: "disabled",
    configuredServerNames: ["server-b", "server-a"],
    enabledServerNames: [],
    checkedServerNames: [],
    unavailableServerNames: [],
    checkedAt: 1234,
  });
  await scheduledMcpPreflight;
  assert.deepStrictEqual(
    plugin.settings.segmentAiMcpServerCatalog,
    ["server-a", "server-b"]
  );
  assert.strictEqual(
    plugin.settings.segmentAiMcpServerCatalogUpdatedAt,
    1234
  );
  assert.strictEqual(mcpSettingsSaves, 1);
  plugin.settings.segmentAiEnabled = false;
  assert.strictEqual(plugin.scheduleSegmentAiMcpBackgroundCheck(), null);
  assert.strictEqual(
    mcpPreflightCalls,
    1,
    "disabling the AI feature must keep Codex and MCP preflight stopped"
  );

  const viewActionsEl = {};
  const viewHeaderEl = {
    querySelector(selector) {
      return selector === ":scope > .view-actions" ? viewActionsEl : null;
    },
  };
  const viewContentEl = {};
  const markdownView = {
    containerEl: {
      querySelector(selector) {
        if (selector === ".view-header") {
          return viewHeaderEl;
        }
        if (selector === ".view-content") {
          return viewContentEl;
        }
        return null;
      },
    },
  };
  assert.strictEqual(typeof plugin.resolveComparisonToolbarMount, "function");
  assert.deepStrictEqual(plugin.resolveComparisonToolbarMount(markdownView), {
    hostEl: viewHeaderEl,
    beforeEl: viewActionsEl,
    location: "header",
  });

  assert.strictEqual(
    plugin.readingNotePathForSegment("texts/s8-le-transfert/translation/Leçon-01.md", "s8-01-0001"),
    "texts/s8-le-transfert/notes/s8-01.md"
  );
  assert.strictEqual(plugin.isReadingNotePath("texts/s8-le-transfert/notes/s8-11-0041.md"), true);
  assert.strictEqual(plugin.isReadingNotePath("texts/s8-le-transfert/translation/Leçon-11.md"), false);

  assert.strictEqual(
    plugin.readingNoteWikiLinkForSegment("s8-01-0001"),
    "[[notes/s8-01#s8-01-0001|阅读笔记]]"
  );

  assert.strictEqual(plugin.readingNotePathForSegment("texts/s8-le-transfert/translation/Leçon-01.md", "s8-01-0002"),
    "texts/s8-le-transfert/notes/s8-01.md");
  for (const target of ["notes/s8-01#s8-01-0001", "texts/s8-le-transfert/notes/s8-01.md#s8-01-0001"]) {
    assert.strictEqual(plugin.segmentIdFromLinkElement({
      getAttribute: (name) => name === "data-href" ? target : "",
    }), "", "chapter note links must not be redirected to the translation");
  }

  const titledReadingNote = new MockTFile();
  titledReadingNote.path = "texts/s8-le-transfert/notes/爱欲的投资、占有与增值.md";
  titledReadingNote.basename = "爱欲的投资、占有与增值";
  plugin.app = {
    metadataCache: {
      getFirstLinkpathDest(linkpath, sourcePath) {
        assert.strictEqual(linkpath, "爱欲的投资、占有与增值");
        assert.strictEqual(sourcePath, "texts/s8-le-transfert/translation/Leçon-04.md");
        return titledReadingNote;
      },
      getFileCache(file) {
        assert.strictEqual(file, titledReadingNote);
        return {
          frontmatter: {
            title: "从“提携年轻人”到“老丈人爱女婿”：爱欲的投资、占有与增值",
          },
        };
      },
    },
  };
  const renderedReadingNoteLink = {
    textContent: "阅读笔记",
    getAttribute(name) {
      return name === "data-href" ? "爱欲的投资、占有与增值" : "";
    },
  };
  assert.strictEqual(typeof plugin.decorateRenderedReadingNoteLinks, "function");
  plugin.decorateRenderedReadingNoteLinks(
    {
      querySelectorAll() {
        return [renderedReadingNoteLink];
      },
    },
    "texts/s8-le-transfert/translation/Leçon-04.md"
  );
  assert.strictEqual(
    renderedReadingNoteLink.textContent,
    "爱欲的投资、占有与增值"
  );

  const note = plugin.buildReadingNoteContent(
    "s8-01-0001",
    "texts/s8-le-transfert/translation/Leçon-01.md",
    { ids: ["s8-01-0001"], original: "Bonjour.", translation: "你好。", annotations: "", commentary: "" }
  );
  assert.ok(note.includes("title: s8-01 章节笔记"));
  assert.ok(note.includes("segments:\n  - s8-01-0001"));
  assert.ok(note.includes("[[texts/s8-le-transfert/translation/Leçon-01.md#s8-01-0001|「s8-01-0001」译文]]"));
  assert.strictEqual(
    plugin.translationWikiLinkForSegment(
      "texts/s8-le-transfert/translation/Leçon-11.md",
      "s8-11-0041"
    ),
    "[[texts/s8-le-transfert/translation/Leçon-11.md#s8-11-0041|「s8-11-0041」译文]]"
  );
  assert.strictEqual(
    plugin.segmentIdFromLinkTarget("texts/s8-le-transfert/translation/Leçon-11.md#s8-11-0041"),
    "s8-11-0041"
  );
  assert.strictEqual(
    plugin.segmentIdFromLinkElement({
      dataset: {},
      getAttribute(name) {
        return name === "data-href" ? "texts/s8-le-transfert/translation/Leçon-11.md#s8-11-0041" : "";
      },
      textContent: "对应译文段落",
    }),
    "s8-11-0041"
  );
  assert.strictEqual(
    plugin.segmentIdFromLinkElement({
      dataset: {},
      getAttribute(name) {
        return name === "data-href" ? "s8-11-0041" : "";
      },
      textContent: "对应译文段落",
    }),
    ""
  );
  assert.strictEqual(
    plugin.segmentIdFromLinkElement({
      dataset: {},
      getAttribute(name) {
        return name === "data-href" ? "s8-11-0041" : "";
      },
      textContent: "「s8-11-0041」译文",
    }),
    ""
  );
  assert.strictEqual(
    plugin.segmentIdFromLinkElement({
      dataset: {},
      getAttribute(name) {
        return name === "data-href" ? "s8-11-0041" : "";
      },
      textContent: "s8-11-0041 阅读笔记",
    }),
    ""
  );
  assert.strictEqual(
    plugin.isPotentialSegmentLinkElement({
      classList: { contains() { return false; } },
      dataset: {},
      getAttribute(name) {
        return name === "data-href" ? "普通笔记" : "";
      },
    }),
    false
  );
  assert.strictEqual(
    plugin.isPotentialSegmentLinkElement({
      classList: { contains() { return false; } },
      dataset: {},
      getAttribute(name) {
        return name === "data-href" ? "texts/s8-le-transfert/translation/Leçon-11.md#s8-11-0041" : "";
      },
    }),
    true
  );
  assert.strictEqual(
    plugin.segmentTargetPathFromLinkElement({
      dataset: {},
      getAttribute(name) {
        return name === "data-href" ? "texts/s8-le-transfert/translation/Le%C3%A7on-11.md#s8-11-0041" : "";
      },
    }),
    "texts/s8-le-transfert/translation/Leçon-11.md"
  );
  assert.strictEqual(
    plugin.segmentTargetPathFromLinkElement({
      dataset: { lacanSegmentTargetPath: "texts/s8-le-transfert/translation/Leçon-11.md" },
      getAttribute() {
        return "#";
      },
    }),
    "texts/s8-le-transfert/translation/Leçon-11.md"
  );
  assert.strictEqual(
    plugin.segmentTargetPathFromLinkElement({
      dataset: {},
      getAttribute(name) {
        return name === "href"
          ? "app://obsidian.md/texts/s8-le-transfert/original/Le%C3%A7on-06.md#s8-06-0009"
          : "";
      },
    }),
    "texts/s8-le-transfert/original/Leçon-06.md"
  );
  assert.strictEqual(
    plugin.segmentDocumentLabel("texts/s8-le-transfert/original/Leçon-06.md"),
    "原文"
  );
  assert.strictEqual(
    plugin.segmentDocumentLabel("texts/s8-le-transfert/translation/Leçon-06.md"),
    "译文"
  );

  const originalPreviewFile = new MockTFile();
  originalPreviewFile.path = "texts/s8-le-transfert/original/Leçon-06.md";
  const translationPreviewFile = new MockTFile();
  translationPreviewFile.path = "texts/s8-le-transfert/translation/Leçon-06.md";
  const previewFiles = new Map([
    [originalPreviewFile.path, originalPreviewFile],
    [translationPreviewFile.path, translationPreviewFile],
  ]);
  const previewTexts = new Map([
    [
      originalPreviewFile.path,
      "<!-- id: s8-06-0009 -->\n\nTexte français.",
    ],
    [
      translationPreviewFile.path,
      "<!-- id: s8-06-0009 -->\n\n中文译文。",
    ],
  ]);
  plugin.segmentPreviewCache = new Map();
  plugin.app = {
    vault: {
      getAbstractFileByPath(filePath) {
        return previewFiles.get(filePath) || null;
      },
      getAllLoadedFiles() {
        return [...previewFiles.values()];
      },
      async cachedRead(file) {
        return previewTexts.get(file.path) || "";
      },
    },
  };
  assert.deepStrictEqual(
    await plugin.loadSegmentPreviewContent("s8-06-0009", originalPreviewFile.path),
    {
      sourcePath: originalPreviewFile.path,
      content: "Texte français.",
    }
  );
  assert.deepStrictEqual(
    await plugin.loadSegmentPreviewContent("s8-06-0009", translationPreviewFile.path),
    {
      sourcePath: translationPreviewFile.path,
      content: "中文译文。",
    }
  );
  assert.strictEqual(
    plugin.segmentPreviewContent(
      "<!-- id: s8-11-0041 -->\n\n[[notes/s8-11-0041|阅读笔记]]\n\n这里是真正的译文。",
      "s8-11-0041"
    ),
    "这里是真正的译文。"
  );
  const segmentSource = [
    "<!-- id: s8-11-0041 -->",
    "",
    "[[notes/s8-11-0041|阅读笔记]]",
    "",
    "这里是真正的译文。",
    "",
    "<!-- id: s8-11-0042 -->",
    "",
    "下一段。",
  ].join("\n");
  const firstMarker = plugin.extractSegmentMarkers(segmentSource)[0];
  assert.strictEqual(firstMarker.targetLine, 4);
  assert.strictEqual(firstMarker.snippet, "这里是真正的译文。");
  assert.strictEqual(plugin.findSegmentLine(segmentSource, "s8-11-0041"), 4);
  assert.deepStrictEqual(plugin.findSegmentLocation(segmentSource, "s8-11-0041"), {
    line: 4,
    col: 0,
    offset: segmentSource.indexOf("这里是真正的译文。"),
  });
  assert.deepStrictEqual(
    plugin.openStateForSegmentLocation(plugin.findSegmentLocation(segmentSource, "s8-11-0041")),
    {
      active: true,
      eState: {
        line: 4,
        startLoc: {
          line: 4,
          col: 0,
          offset: segmentSource.indexOf("这里是真正的译文。"),
        },
        endLoc: {
          line: 4,
          col: 0,
          offset: segmentSource.indexOf("这里是真正的译文。"),
        },
      },
    }
  );
  assert.strictEqual(plugin.segmentPreviewContent(segmentSource, "s8-11-0041"), "这里是真正的译文。");

  const groupedSegmentSource = [
    "<!-- id: s8-06-0058 -->",
    "<!-- ids: s8-06-0058 s8-06-0059 -->",
    "",
    "合并译文。",
  ].join("\n");
  assert.strictEqual(plugin.extractSegmentsById(groupedSegmentSource).get("s8-06-0059"), "合并译文。");
  assert.strictEqual(plugin.findSegmentLine(groupedSegmentSource, "s8-06-0059"), 3);

  const repeatedPrimaryGroupedSegmentSource = [
    "<!-- id: s8-17-0024 -->",
    "<!-- id: s8-17-0024 s8-17-0025 id: s8-17-0026 -->",
    "",
    "合并后的译文。",
  ].join("\n");
  const repeatedPrimaryGroupedMarkers = plugin.extractSegmentMarkers(
    repeatedPrimaryGroupedSegmentSource
  );
  assert.strictEqual(repeatedPrimaryGroupedMarkers.length, 1);
  assert.deepStrictEqual(
    repeatedPrimaryGroupedMarkers[0].ids,
    ["s8-17-0024", "s8-17-0025", "s8-17-0026"]
  );
  const repeatedPrimaryGroupedSegments = plugin.extractSegmentsById(
    repeatedPrimaryGroupedSegmentSource
  );
  assert.strictEqual(repeatedPrimaryGroupedSegments.get("s8-17-0024"), "合并后的译文。");
  assert.strictEqual(repeatedPrimaryGroupedSegments.get("s8-17-0025"), "合并后的译文。");
  assert.strictEqual(repeatedPrimaryGroupedSegments.get("s8-17-0026"), "合并后的译文。");

  const source = [
    "# Leçon 01",
    "",
    "<!-- id: s8-01-0001 -->",
    "",
    "译文正文。",
  ].join("\n");
  const updated = plugin.insertReadingNoteLink(source, "s8-01-0001");
  assert.ok(updated.includes("<!-- id: s8-01-0001 -->\n\n译文正文。\n\n[[notes/s8-01#s8-01-0001|阅读笔记]]\n\n"));
  assert.strictEqual(plugin.insertReadingNoteLink(updated, "s8-01-0001"), updated);
  const moved = plugin.insertReadingNoteLink(
    [
      "# Leçon 01",
      "",
      "<!-- id: s8-01-0001 -->",
      "",
      "[[notes/s8-01#s8-01-0001|阅读笔记]]",
      "",
      "译文正文。",
      "",
      "> 译者说明。",
    ].join("\n"),
    "s8-01-0001"
  );
  assert.ok(moved.includes("<!-- id: s8-01-0001 -->\n\n译文正文。\n\n> 译者说明。\n\n[[notes/s8-01#s8-01-0001|阅读笔记]]\n"));

  const file = new MockTFile();
  file.path = "texts/s8-le-transfert/translation/Leçon-01.md";
  plugin.app = {
    workspace: {
      iterateAllLeaves(callback) {
        callback({
          view: {
            containerEl: {
              contains() {
                return true;
              },
            },
            file,
          },
        });
      },
      getActiveFile() {
        return file;
      },
    },
  };
  const editorApp = plugin.app;
  const lines = [
    { number: 1, from: 0, to: 23, text: "<!-- id: s8-01-0001 -->" },
    { number: 2, from: 24, to: 27, text: "正文。" },
    { number: 3, from: 28, to: 51, text: "<!-- id: s8-01-0002 -->" },
  ];
  const fakeView = {
    dom: {},
    visibleRanges: [{ from: 0, to: lines[0].to }],
    state: {
      doc: {
        length: lines[2].to,
        lineAt(position) {
          return lines.find((line) => position >= line.from && position <= line.to) || lines[0];
        },
      },
    },
  };
  plugin.settings = { segmentAiEnabled: true };
  const decorations = plugin.buildReadingNoteEditorDecorations(fakeView);
  assert.strictEqual(decorations.length, 1);
  assert.strictEqual(decorations[0].from, lines[0].to);

  // Exercise the complete note workflow with an in-memory Vault, including concurrent clicks.
  const noteOpeningSourcePath = "texts/s8-le-transfert/translation/Leçon-01.md";
  const originalPath = noteOpeningSourcePath.replace("/translation/", "/original/");
  const chapterPath = "texts/s8-le-transfert/notes/s8-01.md";
  const legacyPath = "texts/s8-le-transfert/notes/s8-01-0001.md";
  const noteTexts = new Map([
    [noteOpeningSourcePath, [
      "<!-- id: s8-01-0001 -->", "", "第一段。", "",
      "> [注1] 第一条注释。", "> 注释续行。", "",
      "> <!-- 建言 -->", "> 第一条建言。", "",
      "[[notes/s8-01-0001|阅读笔记]]", "",
      "<!-- id: s8-01-0002 -->", "<!-- ids: s8-01-0002 s8-01-0003 -->", "",
      "第二、三段合并译文。", "", "> 未标记的建言。", "",
      "<!-- id: s8-01-0004 -->", "", "缺少对应法文。",
    ].join("\n")],
    [originalPath, "<!-- id: s8-01-0001 -->\nBonjour.\n<!-- id: s8-01-0002 -->\nDeux.\n<!-- id: s8-01-0003 -->\nTrois."],
    [legacyPath, "用户以前的笔记，必须保留。"],
  ]);
  const noteFiles = new Map([...noteTexts.keys()].map((path) => [path, Object.assign(new MockTFile(), { path })]));
  const openedOnLeft = [];
  const originalOpenReadingNoteOnLeft = plugin.openReadingNoteOnLeft;
  plugin.app = {
    vault: {
      getAbstractFileByPath: (path) => noteFiles.get(path),
      read: async (file) => noteTexts.get(file.path),
      async createFolder(path) { noteFiles.set(path, { path }); },
      async create(path, text) {
        assert.ok(!noteFiles.has(path), "a chapter must only be created once");
        const file = Object.assign(new MockTFile(), { path });
        noteFiles.set(path, file);
        noteTexts.set(path, text);
        return file;
      },
      async process(file, update) { noteTexts.set(file.path, update(noteTexts.get(file.path))); },
    },
    fileManager: {
      async processFrontMatter(file, update) {
        const text = noteTexts.get(file.path);
        const header = text.match(/^---\n([\s\S]*?)\n---/)[0];
        const fm = {
          title: header.match(/title: (.*)/)[1],
          segments: [...header.matchAll(/  - (.*)/g)].map((match) => match[1]),
        };
        update(fm);
        noteTexts.set(file.path, text.replace(header, ["---", `title: ${fm.title}`, "segments:", ...fm.segments.map((id) => `  - ${id}`), "---"].join("\n")));
      },
    },
  };
  plugin.openReadingNoteOnLeft = async (file) => openedOnLeft.push(file.path);
  await Promise.all([
    plugin.createReadingNoteForSegment(noteOpeningSourcePath, "s8-01-0001"),
    plugin.createReadingNoteForSegment(noteOpeningSourcePath, "s8-01-0001"),
  ]);
  const firstNote = noteTexts.get(chapterPath);
  assert.ok(firstNote.includes("### 法语原文\n\nBonjour."));
  assert.ok(firstNote.includes("### 中文译文\n\n第一段。"));
  assert.ok(firstNote.includes("### 当前段落注释\n\n> [注1] 第一条注释。\n> 注释续行。"));
  assert.ok(firstNote.includes("### 当前段落建言\n\n> <!-- 建言 -->\n> 第一条建言。"));
  assert.ok(!firstNote.includes("[[notes/"), "source helper links must not enter the snapshot");
  noteTexts.set(chapterPath, firstNote.replace("Bonjour.", "用户编辑过的法文") + "\n手写分析。\n");
  const editedNote = noteTexts.get(chapterPath);
  await plugin.createReadingNoteForSegment(noteOpeningSourcePath, "s8-01-0001");
  assert.strictEqual(noteTexts.get(chapterPath), editedNote, "repeat click must preserve user edits byte for byte");
  await Promise.all([
    plugin.createReadingNoteForSegment(noteOpeningSourcePath, "s8-01-0002"),
    plugin.createReadingNoteForSegment(noteOpeningSourcePath, "s8-01-0003"),
    plugin.createReadingNoteForSegment(noteOpeningSourcePath, "s8-01-0002"),
  ]);
  const completeNote = noteTexts.get(chapterPath);
  assert.strictEqual((completeNote.match(/第二、三段合并译文。/g) || []).length, 1);
  assert.ok(completeNote.includes("Deux.\n\nTrois."));
  assert.ok(completeNote.includes("> 未标记的建言。"));
  assert.ok(completeNote.includes("手写分析。"));
  assert.ok(completeNote.includes("用户编辑过的法文"));
  assert.ok(completeNote.includes("  - s8-01-0003"));
  assert.strictEqual(noteTexts.get(legacyPath), "用户以前的笔记，必须保留。");
  assert.ok(noteTexts.get(noteOpeningSourcePath).includes("[[notes/s8-01-0001|阅读笔记]]"));
  assert.ok(noteTexts.get(noteOpeningSourcePath).includes("[[notes/s8-01#s8-01-0002|阅读笔记]]"));
  assert.deepStrictEqual(openedOnLeft, Array(6).fill(chapterPath));
  assert.deepStrictEqual([...noteTexts.keys()], [noteOpeningSourcePath, originalPath, legacyPath, chapterPath]);
  const beforeFailure = new Map(noteTexts);
  await assert.rejects(plugin.createReadingNoteForSegment(noteOpeningSourcePath, "s8-01-0004"), /找不到分段/);
  await assert.rejects(plugin.createReadingNoteForSegment(noteOpeningSourcePath, "s8-01-9999"), /找不到分段/);
  assert.deepStrictEqual(noteTexts, beforeFailure, "missing sources must not create partial notes or links");
  assert.strictEqual(plugin.readingNotePathForSegment(noteOpeningSourcePath, "s8-02-0001"), "");
  assert.strictEqual(plugin.readingNotePathForSegment(noteOpeningSourcePath, "s9-01-0001"), "");
  await plugin.createReadingNoteForSegment(noteOpeningSourcePath, "s8-01-0001");
  plugin.openReadingNoteOnLeft = originalOpenReadingNoteOnLeft;

  const oldDocument = global.document;
  const createFakeElement = (tagName) => ({
    tagName: tagName.toUpperCase(),
    children: [],
    className: "",
    textContent: "",
    dataset: {},
    appendChild(child) {
      this.children.push(child);
      return child;
    },
    setAttribute() {},
    listeners: {},
    addEventListener(name, handler) { this.listeners[name] = handler; },
  });
  global.document = {
    createElement(tagName) {
      return createFakeElement(tagName);
    },
  };
  try {
    const actions = decorations[0].value.widget.toDOM();
    assert.strictEqual(actions.className, "lacan-segment-actions");
    for (const name of ["pointerdown", "mousedown"]) {
      let prevented = false;
      let stopped = false;
      actions.children[0].listeners[name]({
        preventDefault() { prevented = true; },
        stopPropagation() { stopped = true; },
      });
      assert.ok(prevented && stopped, "pressing the note button must preserve editor focus");
    }
    assert.deepStrictEqual(
      actions.children.map((child) => child.textContent),
      ["记笔记", "Ф"]
    );
    assert.strictEqual(actions.children[1].className, "lacan-segment-ai-button");
    plugin.settings.segmentAiSkillProfiles = [{
      id: "legacy-fixed",
      title: "旧固定方案",
      primarySkill: { name: "translate-lacan-seminars", scope: "repo" },
      supportingSkills: [],
    }];
    plugin.settings.segmentAiDefaultSkillProfileId = "legacy-fixed";
    const legacyControl = plugin.createSegmentAiPreviewControl(file.path, "s8-01-0001");
    assert.strictEqual(legacyControl.children.length, 1, "saved legacy profiles must not add a Skill selector");
    assert.ok(!legacyControl.children[0].title.includes("旧固定方案"));

    plugin.app = editorApp;
    const translationEditorPath = file.path;
    file.path = translationEditorPath.replace("/translation/", "/original/");
    const originalDecorations = plugin.buildReadingNoteEditorDecorations(fakeView);
    assert.strictEqual(originalDecorations.length, 1, "original IDs must receive an AI widget");
    const originalActions = originalDecorations[0].value.widget.toDOM();
    assert.deepStrictEqual(originalActions.children.map((child) => child.textContent), ["Ф"]);
    assert.ok(originalActions.children[0].title.includes("原文解析"));
    assert.strictEqual(plugin.createSegmentAiPreviewControl(file.path, "s8-01-0001").children.length, 1, "quick original translation must not advertise unused Skills");
    const originalButtonCalls = [];
    const savedInterpretSegment = plugin.interpretSegment;
    plugin.interpretSegment = (sourcePath, segmentId) => {
      originalButtonCalls.push({ sourcePath, segmentId });
    };
    originalActions.children[0].listeners.click({ preventDefault() {}, stopPropagation() {} });
    assert.deepStrictEqual(originalButtonCalls, [{ sourcePath: file.path, segmentId: "s8-01-0001" }]);
    plugin.interpretSegment = savedInterpretSegment;
    plugin.settings.segmentAiEnabled = false;
    assert.deepStrictEqual(plugin.buildReadingNoteEditorDecorations(fakeView), [], "disabled AI must leave originals undecorated");
    file.path = translationEditorPath;

    plugin.settings.segmentAiEnabled = false;
    plugin.app = editorApp;
    const noteOnlyDecorations = plugin.buildReadingNoteEditorDecorations(fakeView);
    assert.strictEqual(
      decorations[0].value.widget.eq(noteOnlyDecorations[0].value.widget),
      false
    );
    const noteOnlyActions = noteOnlyDecorations[0].value.widget.toDOM();
    assert.deepStrictEqual(
      noteOnlyActions.children.map((child) => child.textContent),
      ["记笔记"]
    );

    plugin.settings.segmentAiEnabled = true;
    const previewControls = [];
    const previewContainer = {
      querySelectorAll() {
        return previewControls;
      },
      prepend(element) {
        previewControls.unshift(element);
      },
    };
    assert.strictEqual(
      plugin.renderSegmentAiPreviewActions(
        previewContainer,
        "texts/s8-le-transfert/translation/Leçon-06.md",
        {
          text: [
            "<!-- id: s8-06-0058 -->",
            "<!-- ids: s8-06-0058 s8-06-0059 -->",
            "",
            "合并译文。",
          ].join("\n"),
          lineStart: 20,
        }
      ),
      1
    );
    assert.strictEqual(previewControls.length, 1);
    assert.strictEqual(previewControls[0].dataset.segmentId, "s8-06-0058");
    assert.strictEqual(
      previewControls[0].children[0].textContent,
      "【s8-06-0058】 Ф"
    );
    assert.ok(
      previewControls[0].children[0].className.includes("has-segment-id"),
      "reading-mode AI buttons should use the wider segment label style"
    );

    const originalPreviewControls = [];
    assert.strictEqual(plugin.renderSegmentAiPreviewActions({
      querySelectorAll: () => originalPreviewControls,
      prepend: (element) => originalPreviewControls.push(element),
    }, "texts/s8-le-transfert/original/Leçon-06.md", {
      text: "<!-- id: s8-06-0058 -->\nBonjour.",
      lineStart: 20,
    }), 1);
    assert.ok(originalPreviewControls[0].children[0].title.includes("原文解析"));
    assert.strictEqual(originalPreviewControls[0].children[0].textContent, "【s8-06-0058】 Ф");

    const bilingualSourcePath = "texts/s7-l-ethique-de-la-psychanalyse/original/Leçon-01.md";
    const bilingualViewStates = [];
    const bilingualLeaf = {
      async setViewState(state) { bilingualViewStates.push(state); },
    };
    await plugin.openBilingualReading(bilingualSourcePath, bilingualLeaf);
    await plugin.openBilingualReading(bilingualSourcePath.replace("/original/", "/translation/"), bilingualLeaf);
    assert.deepStrictEqual(bilingualViewStates.map((state) => state.type), [
      "lacan-bilingual-reading", "lacan-bilingual-reading",
    ]);
    assert.ok(bilingualViewStates.every((state) => state.active));
    assert.strictEqual(bilingualViewStates[0].state.sourcePath, bilingualSourcePath);
    assert.ok(bilingualViewStates[1].state.sourcePath.includes("/translation/"));
    await assert.rejects(() => plugin.openBilingualReading("知识库/欲望.md", bilingualLeaf), /仅适用于/);

    const toolbar = createFakeElement("div");
    toolbar.empty = () => { toolbar.children = []; };
    toolbar.createEl = (tag, options) => {
      const element = createFakeElement(tag);
      element.className = options.cls;
      element.textContent = options.text;
      toolbar.appendChild(element);
      return element;
    };
    toolbar.createSpan = (options) => toolbar.createEl("span", options);
    plugin.renderComparisonToolbarContent(toolbar, [], bilingualSourcePath, bilingualLeaf);
    const bilingualToolbarButton = toolbar.children.find((child) => child.textContent === "双语阅读");
    assert.ok(bilingualToolbarButton, "双语阅读 must be available even without configured forks");
    const previousRunWithNotice = plugin.runWithNotice;
    plugin.runWithNotice = (action) => action();
    bilingualToolbarButton.listeners.click();
    assert.strictEqual(bilingualViewStates.length, 3, "toolbar opens bilingual reading in the source leaf");
    plugin.runWithNotice = previousRunWithNotice;
    plugin.renderComparisonToolbarContent(toolbar, [], "知识库/欲望.md", bilingualLeaf);
    assert.ok(!toolbar.children.some((child) => child.textContent === "双语阅读"));

    const toolbarPlugin = Object.create(PluginClass.prototype);
    toolbarPlugin.settings = { forks: [{ id: "old", name: "老版本", localBranch: "fork-old", enabled: true }] };
    toolbarPlugin.activeComparisonForks = new Set();
    toolbarPlugin.comparisonRenderRevision = 0;
    let removedToolbars = 0;
    let bilingualComparisons = 0;
    let markdownComparisons = 0;
    toolbarPlugin.removeComparisonToolbars = () => { removedToolbars += 1; };
    toolbarPlugin.canRenderComparisonSegments = () => true;
    toolbarPlugin.renderInlineComparisonControlsForActiveView = async () => { markdownComparisons += 1; };
    const sourceFile = Object.assign(new MockTFile(), { path: bilingualSourcePath, extension: "md" });
    const originalCreateElement = global.document.createElement;
    const createToolbarElement = (tagName) => {
      const element = createFakeElement(tagName);
      element.classList = { toggle() {} };
      element.empty = () => { element.children = []; };
      element.createEl = (tag, options) => {
        const child = createToolbarElement(tag);
        child.className = options.cls || "";
        child.textContent = options.text || "";
        return element.appendChild(child);
      };
      element.createSpan = (options) => element.createEl("span", options);
      return element;
    };
    const actionsEl = createFakeElement("div");
    const headerEl = {
      children: [actionsEl],
      querySelector: () => actionsEl,
      insertBefore(element, beforeEl) {
        this.children = this.children.filter((child) => child !== element);
        this.children.splice(this.children.indexOf(beforeEl), 0, element);
      },
    };
    const contentEl = {};
    const toolbarContainer = {
      querySelector(selector) {
        if (selector === ".view-header") { return headerEl; }
        if (selector === ".view-content") { return contentEl; }
        if (selector === ".lacan-compare-toolbar") {
          return headerEl.children.find((child) => child.className === "lacan-compare-toolbar");
        }
        return null;
      },
    };
    const activeBilingualView = {
      containerEl: toolbarContainer,
      sourcePath: bilingualSourcePath,
      getViewType: () => "lacan-bilingual-reading",
      renderComparisonControls() { bilingualComparisons += 1; },
    };
    const activeBilingualLeaf = { view: activeBilingualView };
    activeBilingualView.leaf = activeBilingualLeaf;
    toolbarPlugin.app = {
      vault: { getAbstractFileByPath: (pathname) => pathname === bilingualSourcePath ? sourceFile : null },
      workspace: {
        activeLeaf: activeBilingualLeaf,
        getActiveFile: () => null,
        getActiveViewOfType: () => null,
      },
    };
    try {
      global.document.createElement = createToolbarElement;
      toolbarPlugin.renderComparisonToolbar();
      assert.strictEqual(removedToolbars, 0, "a bilingual source must retain its toolbar even when getActiveFile is empty");
      assert.strictEqual(headerEl.children.length, 2, "bilingual toolbar must mount before native view actions");
      assert.strictEqual(headerEl.children[1], actionsEl, "native view actions must be preserved");
      let mountedToolbar = headerEl.children[0];
      assert.ok(mountedToolbar.children.some((child) => child.textContent === "Fork 对照版本"));
      const oldVersionButton = mountedToolbar.children.find((child) => child.textContent === "选择 老版本");
      assert.ok(oldVersionButton, "the existing Fork selector must remain available in bilingual reading");
      assert.strictEqual(bilingualComparisons, 1);
      assert.strictEqual(markdownComparisons, 0, "bilingual controls must use their own language lanes");
      await oldVersionButton.listeners.click();
      assert.ok(toolbarPlugin.activeComparisonForks.has("old"));
      assert.ok(mountedToolbar.children.some((child) => child.textContent === "已选 老版本"));
      assert.strictEqual(bilingualComparisons, 2, "selecting a Fork must refresh bilingual segment comparisons");
      const unrelatedFile = Object.assign(new MockTFile(), { path: "知识库/欲望.md", extension: "md" });
      toolbarPlugin.app.workspace.getActiveFile = () => unrelatedFile;
      toolbarPlugin.renderComparisonToolbar({ renderSegments: false });
      assert.ok(mountedToolbar.dataset.toolbarSignature.startsWith(`${bilingualSourcePath}::`), "a stale active file must not redirect bilingual toolbar actions");
      assert.strictEqual(bilingualComparisons, 2, "header-only updates must not rerender bilingual comparisons");

      const normalView = { containerEl: toolbarContainer, leaf: {}, getViewType: () => "markdown" };
      headerEl.children = [actionsEl];
      toolbarPlugin.app.workspace.activeLeaf = { view: normalView };
      toolbarPlugin.app.workspace.getActiveFile = () => sourceFile;
      toolbarPlugin.app.workspace.getActiveViewOfType = () => normalView;
      toolbarPlugin.renderComparisonToolbar();
      mountedToolbar = headerEl.children[0];
      assert.strictEqual(headerEl.children[1], actionsEl);
      assert.ok(mountedToolbar.children.some((child) => child.textContent === "双语阅读"));
      assert.ok(mountedToolbar.children.some((child) => child.textContent === "已选 老版本"));
      assert.strictEqual(markdownComparisons, 1, "normal Markdown views must keep their existing comparison render path");
    } finally {
      global.document.createElement = originalCreateElement;
    }

    const commentaryControls = [];
    const commentaryContainer = {
      querySelectorAll() {
        return commentaryControls;
      },
      prepend(element) {
        commentaryControls.unshift(element);
      },
      closest(selector) {
        return selector === "blockquote" ? this : null;
      },
    };
    assert.strictEqual(
      plugin.renderSegmentAiPreviewActions(
        commentaryContainer,
        "texts/s17-l-envers-de-la-psychanalyse/translation/Leçon-01.md",
        {
          text: [
            "<!-- id: s17-01-0001 -->",
            "",
            "亲爱的朋友们，请允许我再一次追问你们给予我的这份“到场相助”。",
          ].join("\n"),
          lineStart: 15,
        }
      ),
      0,
      "reading-mode AI controls must not be inserted inside commentary blockquotes"
    );
    assert.strictEqual(commentaryControls.length, 0);

    const anchoredPreviewControls = [];
    const blockquoteAnchor = {
      closest(selector) {
        return selector === "blockquote" ? this : null;
      },
      parentNode: {
        insertBefore(control) {
          anchoredPreviewControls.push(control);
        },
      },
    };
    const regularAnchor = {
      closest() {
        return null;
      },
      parentNode: {
        insertBefore(control) {
          anchoredPreviewControls.push(control);
        },
      },
    };
    const mixedPreviewContainer = {
      closest() {
        return null;
      },
      querySelectorAll() {
        return [];
      },
    };
    const originalBuildRenderedAnchorIndex = plugin.buildRenderedAnchorIndex;
    const originalFindRenderedSegmentAnchor = plugin.findRenderedSegmentAnchor;
    plugin.buildRenderedAnchorIndex = () => [];
    plugin.findRenderedSegmentAnchor = (_container, marker) => (
      marker.id === "s17-01-0001" ? blockquoteAnchor : regularAnchor
    );
    try {
      assert.strictEqual(
        plugin.renderSegmentAiPreviewActions(
          mixedPreviewContainer,
          "texts/s17-l-envers-de-la-psychanalyse/translation/Leçon-01.md",
          {
            text: [
              "<!-- id: s17-01-0001 -->",
              "开头译文。",
              "<!-- id: s17-01-0067 -->",
              "后续译文。",
            ].join("\n"),
            lineStart: 0,
          }
        ),
        1,
        "reading-mode AI controls must skip concrete anchors inside commentary blockquotes"
      );
      assert.deepStrictEqual(
        anchoredPreviewControls.map((control) => control.dataset.segmentId),
        ["s17-01-0067"]
      );
    } finally {
      plugin.buildRenderedAnchorIndex = originalBuildRenderedAnchorIndex;
      plugin.findRenderedSegmentAnchor = originalFindRenderedSegmentAnchor;
    }

    const stalePreviewControl = {
      removed: false,
      remove() {
        this.removed = true;
      },
    };
    let previewRerendered = false;
    plugin.settings.segmentAiEnabled = true;
    plugin.app = {
      workspace: {
        containerEl: {
          querySelectorAll(selector) {
            assert.strictEqual(selector, ".lacan-segment-ai-control");
            return [stalePreviewControl];
          },
        },
        updateOptions() {},
        iterateAllLeaves(callback) {
          callback({
            view: {
              previewMode: {
                rerender(force) {
                  assert.strictEqual(force, true);
                  previewRerendered = true;
                },
              },
            },
          });
        },
      },
    };
    plugin.refreshSegmentAiEntrances();
    assert.strictEqual(
      stalePreviewControl.removed,
      true,
      "restarting the enabled plugin must remove stale reading-mode AI controls"
    );
    assert.strictEqual(previewRerendered, true);
  } finally {
    global.document = oldDocument;
  }

  const aiViewStates = [];
  const aiLeaf = {
    view: null,
    async setViewState(state) {
      assert.strictEqual(state.type, "lacan-segment-interpretation");
      assert.strictEqual(state.active, true);
      this.view = {
        setState(viewState) {
          aiViewStates.push(viewState);
        },
      };
    },
  };
  let aiLeafRevealed = false;
  plugin.segmentAiState = { status: "empty" };
  plugin.app = {
    workspace: {
      getLeavesOfType() {
        return [];
      },
      getRightLeaf(create) {
        assert.strictEqual(create, false);
        return aiLeaf;
      },
      async revealLeaf(leaf) {
        assert.strictEqual(leaf, aiLeaf);
        aiLeafRevealed = true;
      },
    },
  };
  assert.strictEqual(typeof plugin.openSegmentInterpretationView, "function");
  assert.strictEqual(await plugin.openSegmentInterpretationView(), aiLeaf);
  assert.strictEqual(aiLeafRevealed, true);
  assert.deepStrictEqual(aiViewStates, [{ status: "empty" }]);

  const discoveryPlugin = Object.create(PluginClass.prototype);
  discoveryPlugin.settings = { segmentAiSkillCatalog: [], segmentAiSkillCatalogUpdatedAt: 0 };
  discoveryPlugin.segmentAiRuntime = {};
  let finishOldDiscovery;
  let finishCurrentDiscovery;
  let discoverySaves = 0;
  discoveryPlugin.saveSettings = async () => { discoverySaves += 1; };
  discoveryPlugin.segmentAiSkillCatalog = {
    refresh: () => new Promise((resolve) => { finishOldDiscovery = resolve; }),
  };
  const oldDiscovery = discoveryPlugin.discoverSegmentAiSkills();
  discoveryPlugin.segmentAiSkillDiscoveryPromise = null;
  discoveryPlugin.segmentAiSkillCatalog = {
    refresh: () => new Promise((resolve) => { finishCurrentDiscovery = resolve; }),
  };
  const currentDiscovery = discoveryPlugin.discoverSegmentAiSkills();
  finishOldDiscovery([{ name: "old-agent-skill" }]);
  await assert.rejects(oldDiscovery, /Agent 配置已变化/);
  assert.ok(discoveryPlugin.segmentAiSkillDiscoveryPromise, "a stale refresh must not clear the current Agent's pending discovery");
  assert.deepStrictEqual(discoveryPlugin.settings.segmentAiSkillCatalog, [], "a stale Agent must not replace the displayed Skill list");
  finishCurrentDiscovery([{ name: "current-agent-skill" }]);
  assert.deepStrictEqual(await currentDiscovery, [{ name: "current-agent-skill" }]);
  assert.deepStrictEqual(discoveryPlugin.settings.segmentAiSkillCatalog, [{ name: "current-agent-skill" }]);
  assert.strictEqual(discoverySaves, 1);
  assert.strictEqual(discoveryPlugin.segmentAiSkillDiscoveryPromise, null);

  const interpretationCalls = [];
  plugin.settings = {
    segmentAiEnabled: true,
    segmentAiDefaultSkillProfileId: "legacy-fixed",
    segmentAiSkillProfiles: [{ id: "legacy-fixed", title: "旧方案" }],
  };
  plugin.segmentAiController = {
    async interpret(sourcePath, segmentId, options) {
      interpretationCalls.push({ sourcePath, segmentId, options });
      return { state: "completed" };
    },
  };
  plugin.openSegmentInterpretationView = async () => aiLeaf;
  assert.deepStrictEqual(
    await plugin.interpretSegment(
      "texts/s8-le-transfert/translation/Leçon-01.md",
      "s8-01-0001"
    ),
    { state: "completed" }
  );
  assert.deepStrictEqual(interpretationCalls, [{
    sourcePath: "texts/s8-le-transfert/translation/Leçon-01.md",
    segmentId: "s8-01-0001",
    options: { model: "", effort: "", forceNew: false },
  }]);
  plugin.openSegmentInterpretationView = async () => {
    throw new Error("right leaf unavailable");
  };
  const failedInterpretation = await plugin.interpretSegment(
    "texts/s8-le-transfert/translation/Leçon-01.md",
    "s8-01-0001"
  );
  assert.strictEqual(failedInterpretation.state, "failed");
  assert.strictEqual(plugin.segmentAiState.workspaceError.code, "Unknown");

  const leftPaneNote = Object.assign(new MockTFile(), { path: "texts/s8-le-transfert/notes/s8-01.md" });
  const anotherNote = Object.assign(new MockTFile(), { path: "texts/s8-le-transfert/notes/s8-02.md" });
  const cursor = { line: 7, ch: 12 };
  const focusedDocument = { activeElement: null };
  const sourceEditor = {
    isConnected: true,
    ownerDocument: focusedDocument,
    focus(options) {
      assert.deepStrictEqual(options, { preventScroll: true });
      focusedDocument.activeElement = this;
    },
  };
  focusedDocument.activeElement = sourceEditor;
  const sourceLeaf = { view: { file, editor: { cursor }, containerEl: { ownerDocument: focusedDocument, getBoundingClientRect: () => ({ left: 500, right: 1000, width: 500 }) } } };
  const openCalls = [];
  const leaves = [sourceLeaf];
  let splitCalls = 0;
  const workspace = {
    activeLeaf: sourceLeaf,
    getLeavesOfType(type) { assert.strictEqual(type, "markdown"); return leaves; },
    createLeafBySplit(anchor, direction, before) {
      assert.strictEqual(anchor, sourceLeaf);
      assert.strictEqual(direction, "vertical");
      assert.strictEqual(before, true, "new note split must be on the left");
      splitCalls += 1;
      const leaf = {
        view: { file: null, containerEl: { ownerDocument: focusedDocument, getBoundingClientRect: () => ({ left: 0, right: 500, width: 500 }), contains: (element) => element === leaf } },
        async openFile(file, options) {
          assert.deepStrictEqual(options, { active: false });
          openCalls.push(file.path);
          this.view.file = file;
        },
      };
      leaves.push(leaf);
      return leaf;
    },
    setActiveLeaf(leaf, options) {
      assert.deepStrictEqual(options, { focus: false });
      this.activeLeaf = leaf;
    },
    revealLeaf() { throw new Error("must not reveal/focus the note editor"); },
  };
  // An old note on the right must not prevent opening the requested left pane.
  leaves.push({ view: { file: leftPaneNote, containerEl: {
    ownerDocument: focusedDocument,
    getBoundingClientRect: () => ({ left: 1000, right: 1500, width: 500 }),
  } } });
  plugin.app = { workspace };
  await plugin.openReadingNoteOnLeft(leftPaneNote);
  leaves.splice(1, 1);
  assert.strictEqual(splitCalls, 1);
  assert.strictEqual(workspace.activeLeaf, sourceLeaf);
  assert.strictEqual(focusedDocument.activeElement, sourceEditor);
  assert.strictEqual(sourceLeaf.view.editor.cursor, cursor);
  const noteLeaf = leaves[1];
  await plugin.openReadingNoteOnLeft(leftPaneNote);
  assert.strictEqual(splitCalls, 1, "repeat click must reuse the existing note pane");
  assert.deepStrictEqual(openCalls, [leftPaneNote.path], "do not reopen the same file or reset its scroll");
  plugin.readingNoteLeaf = null;
  await plugin.openReadingNoteOnLeft(leftPaneNote);
  assert.strictEqual(splitCalls, 1, "discover an already open note after plugin reload");
  await plugin.openReadingNoteOnLeft(anotherNote);
  assert.strictEqual(splitCalls, 1, "other chapters should reuse the managed note pane");
  assert.deepStrictEqual(openCalls, [leftPaneNote.path, anotherNote.path]);
  assert.strictEqual(workspace.activeLeaf, sourceLeaf);

  noteLeaf.openFile = async () => {
    workspace.activeLeaf = noteLeaf;
    focusedDocument.activeElement = noteLeaf;
    throw new Error("open failed");
  };
  await assert.rejects(plugin.openReadingNoteOnLeft(leftPaneNote), /open failed/);
  assert.strictEqual(workspace.activeLeaf, sourceLeaf, "restore source even when opening fails");
  assert.strictEqual(focusedDocument.activeElement, sourceEditor);

  // A closed leaf must not be reused.
  leaves.splice(1);
  await plugin.openReadingNoteOnLeft(leftPaneNote);
  assert.strictEqual(splitCalls, 2);
  assert.strictEqual(workspace.activeLeaf, sourceLeaf);

  const navigatedLeaf = { view: {} };
  leaves[1].openFile = async () => { workspace.activeLeaf = navigatedLeaf; };
  await plugin.openReadingNoteOnLeft(anotherNote);
  assert.strictEqual(workspace.activeLeaf, navigatedLeaf, "do not steal focus if the user navigated during I/O");

} finally {
  Module._load = originalLoad;
}
};

run().then(() => console.log("lacan translation helper tests passed")).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
