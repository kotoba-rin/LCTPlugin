const { Component, FileView, MarkdownRenderer, Scope, normalizePath } = require("obsidian");
const { SegmentParser } = require("../segment-ai/segment-parser");
const { BilingualReadingSearch } = require("./bilingual-reading-search");
const { captureBilingualReadingPosition, restoreBilingualReadingPosition } = require("./reading-position");

const LACAN_BILINGUAL_VIEW_TYPE = "lacan-bilingual-reading";
const LESSON_PATH_RE = /^texts\/[^/]+\/(original|translation)\/(?:Leçon|Lecon|lesson)-\d+\.md$/i;
const FOOTNOTE_DEFINITION_RE = /^ {0,3}\[\^([^\]\n]+)\]:[^\n]*(?:\n(?:[ \t]*\n)*(?: {2,}|\t)[^\n]*)*/gm;

// Connected ID groups keep merged translations together without repeating them.
function pairBilingualBlocks(originalBlocks, translationBlocks) {
  const nodes = [
    ...originalBlocks.map((block) => ({ block, language: "original" })),
    ...translationBlocks.map((block) => ({ block, language: "translation" })),
  ];
  const parents = nodes.map((_, index) => index);
  const find = (index) => {
    while (parents[index] !== index) {
      parents[index] = parents[parents[index]];
      index = parents[index];
    }
    return index;
  };
  const byId = new Map();
  const seenPerLanguage = { original: new Set(), translation: new Set() };
  nodes.forEach(({ block, language }, index) => {
    for (const id of block.ids) {
      if (seenPerLanguage[language].has(id)) {
        throw new Error(`分段 ID ${id} 在${language === "original" ? "法语原文" : "中文译文"}中出现多次。`);
      }
      seenPerLanguage[language].add(id);
      if (byId.has(id)) {
        parents[find(index)] = find(byId.get(id));
      } else {
        byId.set(id, index);
      }
    }
  });

  const groups = new Map();
  nodes.forEach(({ block, language }, index) => {
    const key = find(index);
    if (!groups.has(key)) {
      groups.set(key, { ids: [], originals: [], translations: [] });
    }
    const group = groups.get(key);
    group[language === "original" ? "originals" : "translations"].push(block);
    group.ids.push(...block.ids.filter((id) => !group.ids.includes(id)));
  });
  const compareId = (left, right) => left.localeCompare(right, "en", { numeric: true });
  return [...groups.values()].map((group) => ({
    ...group,
    ids: group.ids.sort(compareId),
  })).sort((left, right) => compareId(left.ids[0], right.ids[0]));
}

function blockReadingMarkdown(block, fileText, namespace) {
  const definitions = new Map(Array.from(
    String(fileText || "").matchAll(FOOTNOTE_DEFINITION_RE),
    (match) => [match[1], match[0].trimEnd()]
  ));
  const sourceMarkdown = String(block.markdown || "");
  const hasLocalFootnoteDefinitions = Array.from(sourceMarkdown.matchAll(FOOTNOTE_DEFINITION_RE)).length > 0;
  let markdown = sourceMarkdown
    .replace(FOOTNOTE_DEFINITION_RE, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .trim();
  if (hasLocalFootnoteDefinitions) {
    // Some source lessons glue the notes heading directly to the final sentence.
    markdown = markdown.replace(/(?:\n[ \t]*(?:-{3,}|\*{3,}|_{3,})[ \t]*\n)?(?:\n[ \t]*)?#{1,6}[ \t]+Notes[ \t]*#*[ \t]*$/i, "").trimEnd();
  }
  const references = Array.from(markdown.matchAll(/\[\^([^\]\n]+)\](?!:)/g), (match) => match[1]);
  const appended = [];
  const included = new Set();
  for (const id of references) {
    if (included.has(id) || !definitions.has(id)) {
      continue;
    }
    included.add(id);
    const definition = definitions.get(id);
    appended.push(definition);
    references.push(...Array.from(definition.matchAll(/\[\^([^\]\n]+)\](?!:)/g), (match) => match[1]));
  }
  if (appended.length) {
    markdown += `\n\n${appended.join("\n\n")}`;
  }
  return markdown.replace(/\[\^([^\]\n]+)\]/g, (_, id) => `[^${namespace}-${id}]`);
}

class LacanBilingualReadingView extends FileView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.allowNoFile = true;
    this.sourcePath = "";
    this.savedScrollTop = 0;
    this.pendingReadingPosition = null;
    this.renderToken = 0;
    this.markdownComponents = new Set();
    this.comparisonBlocks = [];
    this.refreshTimer = null;
    this.modifyEvent = null;
    this.closed = false;
    this.readingSearch = null;
    this.scope = new Scope(plugin.app.scope);
    for (const [modifiers, key, action] of [
      [["Mod"], "g", () => this.readingSearch.move(1)],
      [["Mod", "Shift"], "g", () => this.readingSearch.move(-1)],
      [[], "Escape", () => this.readingSearch.close()],
    ]) {
      this.scope.register(modifiers, key, (event) => {
        if (!this.readingSearch?.isOpen || event.isComposing
          || event.target?.closest?.(".lacan-translation-inline-editor")) return;
        action();
        return false;
      });
    }
    this.addAction("book-open", "打开当前文本的单语阅读视图", () => (
      this.openMonolingual(this.sourcePath, { state: { mode: "preview" } })
    ));
  }

  getViewType() {
    return LACAN_BILINGUAL_VIEW_TYPE;
  }

  getDisplayText() {
    const filename = this.sourcePath.split("/").pop()?.replace(/\.md$/i, "");
    return filename ? `${filename} · 双语阅读` : "双语阅读";
  }

  getIcon() {
    return "languages";
  }

  // Obsidian's Find command dispatches to the active view's showSearch method.
  showSearch() {
    if (this.closed) return;
    if (!this.readingSearch) this.readingSearch = new BilingualReadingSearch(this);
    this.readingSearch.open();
  }

  contentRoot() {
    return this.contentEl
      || this.containerEl?.querySelector?.(".view-content")
      || this.containerEl?.children?.[1];
  }

  getState() {
    const readingPosition = this.getReadingPosition();
    return {
      ...super.getState(),
      sourcePath: this.sourcePath,
      scrollTop: this.contentRoot()?.scrollTop ?? this.savedScrollTop,
      ...(readingPosition ? { readingPosition } : {}),
    };
  }

  getReadingPosition() {
    return captureBilingualReadingPosition(this.contentRoot());
  }

  async setState(state = {}, result) {
    const candidate = String(state.sourcePath || state.file || "").replace(/\\/g, "/");
    this.sourcePath = LESSON_PATH_RE.test(candidate) ? normalizePath(candidate) : "";
    this.savedScrollTop = Math.max(0, Number(state.scrollTop) || 0);
    this.pendingReadingPosition = state.readingPosition || null;
    const previousFile = this.file;
    await super.setState({ ...state, file: this.sourcePath }, result || {});
    // FileView only calls onLoadFile when the file changes.
    if (this.file === previousFile || !this.file) {
      await this.render({ scrollTop: this.savedScrollTop });
    }
    this.plugin.renderComparisonToolbar({ renderSegments: false });
  }

  async onLoadFile(file) {
    this.sourcePath = LESSON_PATH_RE.test(file.path) ? file.path : "";
    await this.render({ scrollTop: this.savedScrollTop });
  }

  async onUnloadFile() {
    this.renderToken += 1;
    this.unloadMarkdown();
  }

  async onRename(file) {
    if (file === this.file) {
      this.sourcePath = LESSON_PATH_RE.test(file.path) ? file.path : "";
    }
    await super.onRename(file);
    if (file === this.file) {
      await this.render();
      this.plugin.renderComparisonToolbar({ renderSegments: false });
    }
  }

  async openMonolingual(path, options) {
    return this.plugin.openMonolingualReading(this, path, options);
  }

  async onOpen() {
    this.closed = false;
    if (!this.modifyEvent && this.plugin.app.vault.on) {
      this.modifyEvent = this.plugin.app.vault.on("modify", (file) => {
        const paths = this.lessonPaths();
        if (file?.path !== paths?.originalPath && file?.path !== paths?.translationPath) {
          return;
        }
        clearTimeout(this.refreshTimer);
        this.refreshTimer = setTimeout(() => {
          this.refreshTimer = null;
          void this.render();
        }, 180);
      });
    }
    await this.render();
  }

  async onClose() {
    this.closed = true;
    this.renderToken += 1;
    clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
    this.readingSearch?.destroy();
    this.readingSearch = null;
    if (this.modifyEvent) {
      this.plugin.app.vault.offref?.(this.modifyEvent);
      this.modifyEvent = null;
    }
    this.unloadMarkdown();
    await super.onClose();
  }

  lessonPaths() {
    if (!LESSON_PATH_RE.test(this.sourcePath)) {
      return null;
    }
    return this.plugin.pathsFromOriginal(this.sourcePath)
      || this.plugin.pathsFromTranslation(this.sourcePath);
  }

  async readLesson(path) {
    const file = this.plugin.app.vault.getAbstractFileByPath(path);
    if (!file || file.extension !== "md") {
      return "";
    }
    return this.plugin.app.vault.cachedRead(file);
  }

  unloadMarkdown() {
    this.plugin.unloadMarkdownRenderComponents(this.contentRoot());
    this.comparisonBlocks = [];
    for (const component of this.markdownComponents) {
      component.unload();
    }
    this.markdownComponents.clear();
  }

  async render({ scrollTop: requestedScrollTop } = {}) {
    const rootEl = this.contentRoot();
    if (this.closed || !rootEl) {
      return;
    }
    if (this.plugin.translationInlineEditor?.isActiveWithin(rootEl)) {
      this.pendingInlineRefresh = true;
      return;
    }
    const token = ++this.renderToken;
    const paths = this.lessonPaths();
    // Keep the current lesson mounted until the asynchronous Markdown work ends.
    // A second refresh must never capture a position clamped by a partial page.
    const stagingEl = rootEl.ownerDocument.createElement("div");
    const rendered = { markdownComponents: new Set(), comparisonBlocks: [] };
    let committed = false;
    try {
      const [originalText, translationText] = paths
        ? await Promise.all([this.readLesson(paths.originalPath), this.readLesson(paths.translationPath)])
        : ["", ""];
      if (this.closed || token !== this.renderToken) {
        return;
      }
      if (this.plugin.translationInlineEditor?.isActiveWithin(rootEl)) {
        this.pendingInlineRefresh = true;
        return;
      }
      if (!paths) {
        stagingEl.createDiv({ cls: "lacan-bilingual-empty", text: "请从研讨班原文或译文打开双语阅读。" });
      } else {
        const headerEl = stagingEl.createDiv({ cls: "lacan-bilingual-header" });
        const title = [originalText, translationText].flatMap((text) => (
          String(text).match(/^#\s+(.+)$/m)?.[1] || []
        ))[0] || this.sourcePath.split("/").pop().replace(/\.md$/i, "");
        headerEl.createEl("h1", { text: title });
        const parser = new SegmentParser();
        const pairs = pairBilingualBlocks(
          parser.parse(originalText, paths.originalPath),
          parser.parse(translationText, paths.translationPath)
        );
        if (!pairs.length) {
          stagingEl.createDiv({ cls: "lacan-bilingual-empty", text: "没有找到可供双语阅读的分段。" });
        }
        const pairsEl = stagingEl.createDiv({ cls: "lacan-bilingual-pairs" });
        for (const pair of pairs) {
          const pairEl = pairsEl.createEl("section", { cls: "lacan-bilingual-pair" });
          pairEl.dataset.segmentId = pair.ids[0];
          for (const [language, blocks, text, sourcePath] of [
            ["original", pair.originals, originalText, paths.originalPath],
            ["translation", pair.translations, translationText, paths.translationPath],
          ]) {
            if (!blocks.length) {
              const laneEl = pairEl.createDiv({ cls: `lacan-bilingual-language is-${language}`, attr: { lang: language === "original" ? "fr" : "zh" } });
              laneEl.createDiv({ cls: "lacan-bilingual-empty", text: language === "original" ? "[没有对应法语原文]" : "[没有对应中文译文]" });
            }
            for (const block of blocks) {
              await this.renderBlock(pairEl, language, block, text, sourcePath, rendered);
              if (this.closed || token !== this.renderToken) {
                return;
              }
            }
          }
        }
      }
      // The old page stays interactive while rendering. Do not replace an editor
      // opened in that time, or restore a scroll position the reader has left.
      if (this.plugin.translationInlineEditor?.isActiveWithin(rootEl)) {
        this.pendingInlineRefresh = true;
        return;
      }
      const scrollTop = requestedScrollTop ?? rootEl.scrollTop ?? this.savedScrollTop;
      this.pendingInlineRefresh = false;
      this.readingSearch?.clearMatches();
      this.unloadMarkdown();
      rootEl.addClass("lacan-bilingual-view");
      rootEl.replaceChildren(...stagingEl.childNodes);
      this.markdownComponents = rendered.markdownComponents;
      this.comparisonBlocks = rendered.comparisonBlocks;
      committed = true;
      this.renderComparisonControls();
      rootEl.scrollTop = scrollTop;
      if (this.pendingReadingPosition && restoreBilingualReadingPosition(rootEl, this.pendingReadingPosition)) {
        this.pendingReadingPosition = null;
      }
      this.savedScrollTop = rootEl.scrollTop;
      this.readingSearch?.refresh();
    } catch (error) {
      if (!this.closed && token === this.renderToken) {
        rootEl.createDiv({ cls: "lacan-bilingual-error", text: `双语阅读加载失败：${error.message || error}` });
      }
    } finally {
      if (!committed) {
        for (const component of rendered.markdownComponents) component.unload();
      }
    }
  }

  renderComparisonControls() {
    const forks = this.plugin.getActiveComparisonForks();
    const signature = this.plugin.comparisonForkSignature(forks);
    for (const { laneEl, bodyEl, sourcePath, segmentId } of this.comparisonBlocks) {
      let controlEl = laneEl.querySelector(".lacan-segment-compare-control");
      if (!forks.length) {
        if (controlEl) {
          this.plugin.unloadMarkdownRenderComponents(controlEl);
          controlEl.remove();
        }
        continue;
      }
      if (!controlEl) {
        controlEl = laneEl.createDiv({ cls: "lacan-segment-compare-control" });
        laneEl.insertBefore(controlEl, bodyEl);
      }
      this.plugin.renderSegmentComparisonControlIfNeeded(controlEl, sourcePath, segmentId, forks, signature);
    }
  }

  async renderBlock(pairEl, language, block, fileText, sourcePath, rendered) {
    const isOriginal = language === "original";
    const laneEl = pairEl.createDiv({ cls: `lacan-bilingual-language is-${language}`, attr: { lang: isOriginal ? "fr" : "zh" } });
    laneEl.dataset.segmentId = block.primaryId;
    laneEl.dataset.segmentIds = block.ids.join(" ");
    laneEl.dataset.language = language;
    const headerEl = laneEl.createDiv({ cls: "lacan-bilingual-language-header" });
    headerEl.createSpan({ cls: "lacan-bilingual-language-label", text: isOriginal ? "法语原文" : "中文译文" });
    if (this.plugin.settings.segmentAiEnabled) {
      headerEl.appendChild(this.plugin.createSegmentAiPreviewControl(sourcePath, block.primaryId));
    }
    const bodyEl = laneEl.createDiv({ cls: "lacan-bilingual-content markdown-rendered" });
    if (!isOriginal) this.plugin.bindTranslationBlockEditing?.(bodyEl, sourcePath, block.primaryId);
    rendered.comparisonBlocks.push({ laneEl, bodyEl, sourcePath, segmentId: block.primaryId });
    const markdown = blockReadingMarkdown(block, fileText, `${isOriginal ? "fr" : "zh"}-${block.primaryId}`);
    if (!markdown) {
      bodyEl.createDiv({ cls: "lacan-bilingual-empty", text: !isOriginal && /<!--\s*untranslated\s*-->/i.test(block.markdown) ? "[该段尚未翻译]" : "[该段暂无正文]" });
      return;
    }
    const component = new Component();
    component.load();
    rendered.markdownComponents.add(component);
    await MarkdownRenderer.render(this.plugin.app, markdown, bodyEl, sourcePath, component);
  }
}

module.exports = {
  LACAN_BILINGUAL_VIEW_TYPE,
  LacanBilingualReadingView,
  pairBilingualBlocks,
  blockReadingMarkdown,
};
