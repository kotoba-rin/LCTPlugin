const { buildFrenchLookup, getFrenchWordAt } = require("./french-lookup-text");
const { readPdfTextLayer } = require("./pdf-lookup-text");

const EXCLUDED_TARGETS = ".lacan-french-lookup, .view-header, .inline-title, .cm-gutters, .modal-container, .setting-item, button, input, textarea, select, .lacan-segment-ai-control, .lacan-segment-note-actions, .lacan-translation-inline-editor";

function createElement(parent, tag, className, text) {
  const element = parent.ownerDocument.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = String(text);
  parent.appendChild(element);
  return element;
}

function asElement(node) {
  return node?.nodeType === 3 ? node.parentElement : node;
}

function isLookupView(view) {
  const type = view?.getViewType?.();
  return type === "markdown" || type === "lacan-bilingual-reading" || type === "pdf";
}

function dictionaryUrl(query) {
  return `https://www.frdic.com/dicts/fr/${encodeURIComponent(query)}`;
}

function safeDictionaryGlyph(glyph) {
  if (!/^〔法助字图:\d+〕$/.test(glyph?.marker || "")) return null;
  try {
    const url = new URL(glyph.src);
    if (url.origin !== "https://www.frdic.com" || url.username || url.password || url.search || url.hash
      || !/^\/tmp\/wordimg\/[A-Za-z0-9@=_+\-]{1,128}\.png$/.test(url.pathname)) return null;
    return { ...glyph, src: url.href };
  } catch (_) {
    return null;
  }
}

function appendDictionaryText(parent, text, glyphs = []) {
  const byMarker = new Map();
  for (const candidate of Array.isArray(glyphs) ? glyphs : []) {
    const glyph = safeDictionaryGlyph(candidate);
    if (glyph) byMarker.set(glyph.marker, glyph);
  }
  const value = String(text);
  let offset = 0;
  for (const match of value.matchAll(/〔法助字图:[^〕]*〕/g)) {
    if (match.index > offset) parent.appendChild(parent.ownerDocument.createTextNode(value.slice(offset, match.index)));
    const glyph = byMarker.get(match[0]);
    if (glyph) {
      const image = createElement(parent, "img", "lacan-french-lookup-glyph");
      image.src = glyph.src;
      image.alt = String(glyph.alt || "〔图文〕");
      image.decoding = "async";
      for (const dimension of ["width", "height"]) {
        const size = Number(glyph[dimension]);
        if (Number.isFinite(size) && size > 0 && size <= 128) image[dimension] = size;
      }
    } else {
      parent.appendChild(parent.ownerDocument.createTextNode("〔图文〕"));
    }
    offset = match.index + match[0].length;
  }
  if (offset < value.length) parent.appendChild(parent.ownerDocument.createTextNode(value.slice(offset)));
}

function positionLookupPopup(rect, popupSize, viewport) {
  const margin = 12;
  const width = Math.min(popupSize.width || 420, Math.max(0, viewport.width - margin * 2));
  const height = Math.min(popupSize.height || 440, Math.max(0, viewport.height - margin * 2));
  const x = Number.isFinite(rect?.left) ? rect.left : margin;
  const top = Number.isFinite(rect?.top) ? rect.top : margin;
  const bottom = Number.isFinite(rect?.bottom) ? rect.bottom : top;
  const below = bottom + 10;
  const y = below + height <= viewport.height - margin ? below : top - height - 10;
  return {
    left: Math.max(margin, Math.min(x, viewport.width - width - margin)),
    top: Math.max(margin, Math.min(y, viewport.height - height - margin)),
    maxWidth: Math.max(0, viewport.width - margin * 2),
    maxHeight: Math.max(0, viewport.height - margin * 2),
  };
}

class FrenchLookupPopup {
  constructor(plugin, { service, translate, getLookup = buildFrenchLookup, createMenu } = {}) {
    this.plugin = plugin;
    this.service = service;
    this.translate = translate;
    this.getLookup = getLookup;
    this.createMenu = createMenu;
    this.popupEl = null;
    this.lookup = null;
    this.mode = "dictionary";
    this.pinned = false;
    this.generation = 0;
    this.timer = null;
    this.listeners = [];
    this.documents = new Set();
    this.destroyed = false;
    this.started = false;
    this.workspaceEvent = null;
    this.speechState = null;
  }

  start() {
    if (this.started || this.destroyed) return;
    this.started = true;
    const mainDocument = this.plugin.app.workspace.containerEl?.ownerDocument || globalThis.document;
    this.bindDocument(mainDocument);
    this.plugin.app.workspace.iterateAllLeaves?.((leaf) => {
      if (isLookupView(leaf?.view)) this.bindDocument(leaf.view.containerEl?.ownerDocument);
    });
    this.bindDocument(this.activeView()?.containerEl?.ownerDocument);
    if (this.plugin.app.workspace.on) {
      this.workspaceEvent = this.plugin.app.workspace.on("active-leaf-change", () => {
        if (this.destroyed) return;
        const doc = this.plugin.app.workspace.activeLeaf?.view?.containerEl?.ownerDocument;
        this.bindDocument(doc);
        if (!this.pinned) this.close();
      });
      this.plugin.registerEvent?.(this.workspaceEvent);
    }
  }

  bindDocument(doc) {
    if (this.destroyed || !doc || this.documents.has(doc)) return;
    this.documents.add(doc);
    this.listen(doc, "pointerup", (event) => this.handleSelectionEvent(event));
    this.listen(doc, "dblclick", (event) => this.handleSelectionEvent(event));
    this.listen(doc, "contextmenu", (event) => this.handleContextMenu(event));
    this.listen(doc, "keyup", (event) => {
      if (event.key === "Escape") this.close();
      else if (event.shiftKey && ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) this.handleSelectionEvent(event);
    });
    this.listen(doc, "pointerdown", (event) => {
      if (!this.popupEl || this.popupEl.contains(event.target) || this.pinned) return;
      this.close();
    });
  }

  listen(target, type, listener) {
    target.addEventListener(type, listener, true);
    this.listeners.push(() => target.removeEventListener(type, listener, true));
  }

  activeView(target = null) {
    const view = this.plugin.app.workspace.activeLeaf?.view;
    if (!target) return isLookupView(view) ? view : null;
    const element = asElement(target);
    if (isLookupView(view) && view.containerEl?.contains(element)) return view;
    let containingView = null;
    this.plugin.app.workspace.iterateAllLeaves?.((leaf) => {
      if (!containingView && isLookupView(leaf?.view) && leaf.view.containerEl?.contains(element)) {
        containingView = leaf.view;
      }
    });
    return containingView;
  }

  allowedTarget(target, view) {
    const element = asElement(target);
    if (!element || !view?.containerEl?.contains(element) || element.closest?.(EXCLUDED_TARGETS)) return false;
    // Only the PDF text layer is readable text; its toolbar and annotations are UI.
    if (view.getViewType?.() === "pdf" && !element.closest?.(".textLayer")) return false;
    const editable = element.closest?.("[contenteditable='true']");
    return !editable || Boolean(element.closest?.(".cm-content"));
  }

  readSelection(target, { allowCursor = false, expandWord = false } = {}) {
    const view = this.activeView(target);
    if (!view || (target && !this.allowedTarget(target, view))) return null;
    const doc = view.containerEl.ownerDocument;
    const selection = doc.getSelection?.() || doc.defaultView?.getSelection?.();
    let text = "";
    let context = "";
    let rect = null;
    if (selection?.rangeCount && !selection.isCollapsed) {
      const range = selection.getRangeAt(0);
      if (this.allowedTarget(range.startContainer, view) && this.allowedTarget(range.endContainer, view)) {
        text = selection.toString();
        if (view.getViewType?.() === "pdf") {
          const pageText = readPdfTextLayer(range);
          if (!pageText) return null;
          const startLayer = asElement(range.startContainer)?.closest?.(".textLayer");
          const endLayer = asElement(range.endContainer)?.closest?.(".textLayer");
          if (startLayer === endLayer) {
            const endText = readPdfTextLayer({ startContainer: range.endContainer, startOffset: range.endOffset });
            if (endText && endText.offset > pageText.offset) text = pageText.text.slice(pageText.offset, endText.offset);
          }
          if (expandWord) text = getFrenchWordAt(pageText.text, pageText.offset) || text;
          // Keep the selected passage in the bounded context even on long pages.
          const contextStart = Math.max(0, pageText.offset - 180);
          context = pageText.text.slice(contextStart, contextStart + 600);
        } else {
          const parent = asElement(range.commonAncestorContainer);
          const paragraph = parent?.closest?.("p, .cm-line, li, h1, h2, h3, h4, blockquote") || parent;
          context = paragraph?.textContent || "";
          if (expandWord && paragraph && doc.createRange && Number.isFinite(range.startOffset)) {
            const preceding = doc.createRange();
            preceding.selectNodeContents(paragraph);
            preceding.setEnd(range.startContainer, range.startOffset);
            text = getFrenchWordAt(context, preceding.toString().length) || text;
          } else if (expandWord && range.startContainer === range.endContainer && range.startContainer.nodeType === 3) {
            text = getFrenchWordAt(range.startContainer.textContent || "", range.startOffset) || text;
          }
        }
        rect = range.getBoundingClientRect?.();
      }
    }
    const editor = view.editor;
    if (!text && editor) {
      text = editor.getSelection?.() || "";
      const cursor = editor.getCursor?.();
      if (cursor) {
        context = editor.getLine?.(cursor.line) || "";
        if (expandWord || (!text && allowCursor)) text = getFrenchWordAt(context, cursor.ch) || text;
      }
      rect = asElement(target)?.getBoundingClientRect?.() || view.containerEl.getBoundingClientRect?.();
    }
    const lookup = this.getLookup(text, context);
    return lookup ? { lookup, rect, doc } : null;
  }

  handleSelectionEvent(event) {
    if (!this.plugin.settings.frenchLookupEnabled || this.destroyed || this.pinned) return;
    if (event.button !== undefined && event.button !== 0) return;
    const trigger = this.plugin.settings.frenchLookupTrigger || "selection";
    if (trigger === "double-click" ? event.type !== "dblclick" : event.type === "dblclick") return;
    if (!this.allowedTarget(event.target, this.activeView(event.target))) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      const selected = this.readSelection(event.target, { expandWord: event.type === "dblclick" });
      if (!selected) {
        if (!this.pinned) this.close();
        return;
      }
      if (this.lookup?.selection === selected.lookup.selection && this.lookup?.context === selected.lookup.context && this.popupEl) return;
      void this.showLookup(selected.lookup, selected.rect, { doc: selected.doc });
    }, event.type === "dblclick" ? 0 : 180);
  }

  handleContextMenu(event) {
    if (!this.plugin.settings.frenchLookupEnabled || this.destroyed || !this.createMenu) return;
    const element = asElement(event.target);
    const view = this.activeView(element);
    if (!this.allowedTarget(element, view) || element.closest?.("a")) return;
    // Editing already has editor-menu; rendered reading surfaces need their own menu.
    if (!element.closest?.(".lacan-bilingual-content, .markdown-preview-view, .markdown-reading-view, .textLayer")) return;
    if (element.closest?.(".cm-content")) return;
    const doc = view.containerEl.ownerDocument;
    const selection = doc.getSelection?.() || doc.defaultView?.getSelection?.();
    if (!selection?.rangeCount || selection.isCollapsed) return;
    const range = selection.getRangeAt(0);
    if (!this.allowedTarget(range.startContainer, view) || !this.allowedTarget(range.endContainer, view)) return;
    const selected = this.readSelection(element);
    if (!selected) return;
    const copyText = selection.toString();
    clearTimeout(this.timer);
    this.timer = null;
    event.preventDefault();
    event.stopPropagation();
    this.contextMenu?.hide();
    const menu = this.createMenu();
    this.contextMenu = menu;
    for (const [title, icon, mode] of [
      ["法语词典查词", "book-open", "dictionary"],
      ["翻译选区并解释法语语法", "languages", "translation"],
    ]) {
      menu.addItem((item) => item.setTitle(title).setIcon(icon)
        .onClick(() => this.showLookup(selected.lookup, selected.rect, { mode, doc: selected.doc })));
    }
    const clipboard = doc.defaultView?.navigator?.clipboard;
    if (clipboard?.writeText) {
      menu.addSeparator();
      menu.addItem((item) => item.setTitle("复制").setIcon("copy")
        .onClick(() => clipboard.writeText(copyText)));
    }
    menu.showAtMouseEvent(event);
  }

  async lookupCurrentSelection(mode) {
    const selected = this.readSelection(null, { allowCursor: true });
    if (!selected) return false;
    await this.showLookup(selected.lookup, selected.rect, { mode, doc: selected.doc });
    return true;
  }

  async showLookup(lookup, rect, { mode, doc } = {}) {
    if (this.destroyed || !lookup) return;
    this.close();
    this.lookup = lookup;
    this.anchorRect = rect;
    this.mode = mode || (lookup.isPhrase && this.plugin.settings.frenchLookupAutoTranslate !== false ? "translation" : "dictionary");
    this.abortController = new AbortController();
    this.dictionaryResult = null;
    this.translationResult = null;
    this.dictionaryPromise = null;
    this.translationPromise = null;
    this.saved = false;
    this.saving = false;
    this.syncingWordbook = false;
    this.wordbookSyncRequest = 0;
    this.savedCategoryId = null;
    this.pendingWordbookSave = null;
    this.pinned = false;
    const generation = this.generation;
    this.buildPopup(doc || this.activeView()?.containerEl?.ownerDocument || globalThis.document);
    await this.loadMode(generation);
  }

  buildPopup(doc) {
    this.bindDocument(doc);
    const root = createElement(doc.body, "div", "lacan-french-lookup");
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-label", "法语取词");
    root.setAttribute("tabindex", "-1");
    this.popupEl = root;
    if (this.lookup.isPhrase) root.className += " is-phrase";
    const header = createElement(root, "div", "lacan-french-lookup-header");
    createElement(header, "span", "lacan-french-lookup-brand", "法语取词");
    const headerTools = createElement(header, "div", "lacan-french-lookup-header-tools");
    this.pinButton = this.button(headerTools, "固定", "lacan-french-lookup-pin", () => {
      this.pinned = !this.pinned;
      this.pinButton.setAttribute("aria-pressed", String(this.pinned));
      this.pinButton.textContent = this.pinned ? "已固定" : "固定";
    });
    this.pinButton.setAttribute("aria-pressed", "false");
    this.button(headerTools, "×", "lacan-french-lookup-close", () => this.close()).setAttribute("aria-label", "关闭取词浮窗");
    const hero = createElement(root, "div", "lacan-french-lookup-hero");
    this.titleEl = createElement(hero, "h3", "lacan-french-lookup-title", this.lookup.selection);
    this.formEl = createElement(hero, "div", "lacan-french-lookup-form");
    const pronunciation = createElement(hero, "div", "lacan-french-lookup-pronunciation");
    this.phoneticEl = createElement(pronunciation, "span", "lacan-french-lookup-phonetic");
    this.speechButton = this.button(pronunciation, "朗读", "lacan-french-lookup-speech", () => this.toggleSpeech());
    this.updateSpeechButton();
    const tabs = createElement(root, "div", "lacan-french-lookup-tabs");
    this.dictionaryButton = this.button(tabs, "词典", "lacan-french-lookup-tab", () => this.switchMode("dictionary"));
    this.translationButton = this.button(tabs, "翻译", "lacan-french-lookup-tab", () => this.switchMode("translation"));
    this.saveButton = this.button(tabs, "☆ 加入生词本", "lacan-french-lookup-save", () => this.saveWord());
    this.saveButton.title = "加入设置中选择的欧路法语生词本";
    this.bodyEl = createElement(root, "div", "lacan-french-lookup-body");
    this.bodyEl.setAttribute("aria-live", "polite");
    const footer = createElement(root, "div", "lacan-french-lookup-footer");
    this.sourceEl = createElement(footer, "span", "lacan-french-lookup-source");
    this.detailEl = createElement(footer, "a", "lacan-french-lookup-detail", "详细释义 ↗");
    this.detailEl.href = dictionaryUrl(this.lookup.query);
    this.detailEl.target = "_blank";
    this.detailEl.rel = "noopener noreferrer";
    this.statusEl = createElement(root, "div", "lacan-french-lookup-status");
    this.updateTabs();
    this.updateSaveButton();
    this.position();
  }

  button(parent, label, className, callback) {
    const button = createElement(parent, "button", className, label);
    button.type = "button";
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const reportError = (error) => {
        if (this.statusEl && this.popupEl) this.statusEl.textContent = error?.message || "操作失败，请重试。";
      };
      try {
        Promise.resolve(callback()).catch(reportError);
      } catch (error) {
        reportError(error);
      }
    });
    return button;
  }

  async switchMode(mode) {
    this.stopSpeech();
    this.mode = mode;
    this.updateTabs();
    await this.loadMode(this.generation);
  }

  updateTabs() {
    this.dictionaryButton?.setAttribute("aria-pressed", String(this.mode === "dictionary"));
    this.translationButton?.setAttribute("aria-pressed", String(this.mode === "translation"));
  }

  updateSpeechButton() {
    if (!this.speechButton) return;
    const speaking = Boolean(this.speechState);
    this.speechButton.textContent = speaking ? "停止" : "朗读";
    this.speechButton.title = speaking ? "停止法语朗读" : "用系统法语语音朗读";
    this.speechButton.setAttribute("aria-label", speaking ? "停止法语朗读" : "朗读法语");
    this.speechButton.setAttribute("aria-pressed", String(speaking));
  }

  async toggleSpeech() {
    if (this.speechState) {
      this.stopSpeech();
      return;
    }
    if (!this.popupEl) return;
    const win = this.popupEl.ownerDocument.defaultView;
    const synthesis = win?.speechSynthesis;
    if (!synthesis?.speak || !synthesis?.cancel || !synthesis?.getVoices || !win?.SpeechSynthesisUtterance) {
      this.statusEl.textContent = "当前环境不支持系统朗读。";
      return;
    }
    const state = { synthesis, utterance: null, cancelWait: null };
    this.speechState = state;
    this.statusEl.textContent = "";
    this.updateSpeechButton();
    try {
      const voices = await this.waitForSpeechVoices(state);
      if (this.speechState !== state) return;
      const voice = voices.find((item) => /^fr[-_]fr$/i.test(item.lang))
        || voices.find((item) => /^fr(?:[-_]|$)/i.test(item.lang));
      if (!voice) throw new Error("未找到法语语音，请在系统语音设置中安装法语语音后重试。");
      const utterance = new win.SpeechSynthesisUtterance(this.titleEl.textContent);
      utterance.lang = voice.lang;
      utterance.voice = voice;
      state.utterance = utterance;
      utterance.onend = () => this.finishSpeech(state);
      utterance.onerror = (event) => this.finishSpeech(state,
        ["language-unavailable", "voice-unavailable"].includes(event.error)
          ? "法语语音暂不可用，请检查系统语音设置后重试。"
          : "朗读失败，请检查系统语音和音频输出后重试。");
      synthesis.speak(utterance);
    } catch (error) {
      if (this.speechState !== state) return;
      this.stopSpeech();
      this.statusEl.textContent = error?.message ? `朗读失败：${error.message}` : "朗读失败，请重试。";
    }
  }

  waitForSpeechVoices(state) {
    const voices = state.synthesis.getVoices();
    if (voices.length) return Promise.resolve(voices);
    return new Promise((resolve) => {
      let timer;
      const finish = (items) => {
        clearTimeout(timer);
        state.synthesis.removeEventListener?.("voiceschanged", changed);
        state.cancelWait = null;
        resolve(items);
      };
      const changed = () => {
        const items = state.synthesis.getVoices();
        if (items.length) finish(items);
      };
      state.cancelWait = () => finish([]);
      state.synthesis.addEventListener?.("voiceschanged", changed);
      timer = setTimeout(() => finish(state.synthesis.getVoices()), 2000);
      changed();
    });
  }

  finishSpeech(state, error) {
    if (this.speechState !== state) return;
    this.speechState = null;
    state.utterance.onend = null;
    state.utterance.onerror = null;
    this.updateSpeechButton();
    if (error && this.popupEl) this.statusEl.textContent = error;
  }

  stopSpeech() {
    const state = this.speechState;
    if (!state) return;
    this.speechState = null;
    state.cancelWait?.();
    if (state.utterance) {
      state.utterance.onend = null;
      state.utterance.onerror = null;
      state.synthesis.cancel();
    }
    this.updateSpeechButton();
  }

  async loadMode(generation) {
    const mode = this.mode;
    if (!this.popupEl || generation !== this.generation) return;
    this.bodyEl.replaceChildren();
    createElement(this.bodyEl, "div", "lacan-french-lookup-loading", mode === "dictionary" ? "正在查询法语词典…" : "正在翻译选中文本…");
    this.sourceEl.textContent = mode === "dictionary" ? "法语助手在线词典" : "语境翻译";
    try {
      if (mode === "dictionary") {
        if (!this.dictionaryPromise) this.dictionaryPromise = Promise.resolve().then(() => this.service.lookup(this.lookup.query));
        const result = await this.dictionaryPromise;
        if (generation !== this.generation || !this.popupEl) return;
        this.dictionaryResult = result;
        this.updateSaveButton();
        if (this.mode === mode) this.renderDictionary(result);
        await this.syncWordbookState(generation);
      } else {
        if (!this.translate) throw new Error("尚未配置语境翻译，请先在插件中配置本地 Agent。");
        if (!this.translationPromise) this.translationPromise = Promise.resolve().then(() => this.translate(this.lookup, { signal: this.abortController.signal }));
        const response = await this.translationPromise;
        if (generation !== this.generation || !this.popupEl) return;
        const result = typeof response === "string" ? { text: response, source: "语境翻译" } : response;
        this.translationResult = result;
        if (this.mode === mode) this.renderTranslation(result);
      }
    } catch (error) {
      if (generation !== this.generation || !this.popupEl || this.mode !== mode || error?.name === "AbortError") return;
      if (mode === "dictionary") this.dictionaryPromise = null;
      else this.translationPromise = null;
      this.bodyEl.replaceChildren();
      createElement(this.bodyEl, "div", "lacan-french-lookup-error", error?.message || "查询失败，请重试。");
      this.button(this.bodyEl, "重试", "lacan-french-lookup-retry", () => this.loadMode(this.generation));
      this.updateSaveButton();
      this.position();
    }
  }

  renderDictionary(result) {
    this.bodyEl.replaceChildren();
    const headword = result?.headword || this.lookup.query;
    if (this.titleEl.textContent !== headword) this.stopSpeech();
    this.titleEl.textContent = headword;
    this.formEl.textContent = this.lookup.selection !== headword ? `原文：${this.lookup.selection} → 词条：${headword}` : "";
    this.phoneticEl.textContent = result?.phonetic || "";
    this.sourceEl.textContent = result?.source || "法语助手在线词典";
    this.detailEl.href = dictionaryUrl(headword);
    this.renderGrammar(result?.grammar);
    const definitions = Array.isArray(result?.definitions) ? result.definitions : [];
    if (definitions.length) {
      const list = createElement(this.bodyEl, "ol", "lacan-french-lookup-definitions");
      for (const definition of definitions) appendDictionaryText(createElement(list, "li"), definition, result.glyphs);
    } else {
      createElement(this.bodyEl, "div", "lacan-french-lookup-empty", result?.suggestions?.length ? "该词形有以下候选词条，请选择：" : "暂无可显示的词典释义，可打开原站查看或切换语境翻译。");
    }
    if (result?.suggestions?.length) {
      const suggestions = createElement(this.bodyEl, "div", "lacan-french-lookup-suggestions");
      if (definitions.length) createElement(suggestions, "div", "lacan-french-lookup-note", "相关词形／候选词条");
      for (const suggestion of result.suggestions) {
        const word = typeof suggestion === "string" ? suggestion : suggestion.headword;
        if (!word) continue;
        this.button(suggestions, word, "lacan-french-lookup-suggestion", () => (
          this.showLookup({ ...this.lookup, query: word }, this.anchorRect, { mode: "dictionary", doc: this.popupEl.ownerDocument })
        ));
      }
    }
    if (result?.partial) createElement(this.bodyEl, "div", "lacan-french-lookup-note", "在线词条部分内容需在原站查看。");
    if (this.lookup.elision) createElement(this.bodyEl, "div", "lacan-french-lookup-note", `已保留原文省音形式；查询词：${this.lookup.query}`);
    this.updateSaveButton();
    this.position();
  }

  renderTranslation(result) {
    this.bodyEl.replaceChildren();
    if (this.titleEl.textContent !== this.lookup.selection) this.stopSpeech();
    this.titleEl.textContent = this.lookup.selection;
    this.formEl.textContent = "";
    this.phoneticEl.textContent = "";
    this.sourceEl.textContent = result?.source || "语境翻译";
    this.renderGrammar(result?.grammar);
    createElement(this.bodyEl, "div", "lacan-french-lookup-translation", result?.text || "暂未返回译文。");
    this.position();
  }

  renderGrammar(items) {
    if (!Array.isArray(items) || !items.length) return;
    const grammar = createElement(this.bodyEl, "div", "lacan-french-lookup-grammar");
    for (const item of items) createElement(grammar, "span", "lacan-french-lookup-grammar-item", item);
  }

  updateSaveButton() {
    if (!this.saveButton) return;
    const result = this.dictionaryResult;
    this.saveTarget = !result?.ambiguous && result?.definitions?.length ? result.headword || this.lookup.query : "";
    const saved = this.saved && this.savedCategoryId === this.currentWordbookId();
    this.saveButton.disabled = this.saving || this.syncingWordbook || !this.saveTarget || saved;
    this.saveButton.textContent = this.syncingWordbook ? "正在同步…" : saved ? "★ 已加入" : this.saving ? "正在加入…" : this.hasPendingWordbookSave() ? "重试同步" : "☆ 加入生词本";
    this.saveButton.title = this.saveTarget ? `收藏词条：${this.saveTarget}` : "先选择词典词条，再加入欧路法语生词本";
  }

  currentWordbookId() {
    return String(this.plugin.settings.frenchLookupWordbookId || "0");
  }

  hasPendingWordbookSave() {
    return this.pendingWordbookSave?.word === this.saveTarget
      && this.pendingWordbookSave?.categoryId === this.currentWordbookId();
  }

  async syncWordbookState(generation = this.generation) {
    if (generation !== this.generation || !this.popupEl || !this.saveTarget) return;
    const word = this.saveTarget;
    const categoryId = this.currentWordbookId();
    const request = ++this.wordbookSyncRequest;
    const isCurrent = () => generation === this.generation && this.popupEl && request === this.wordbookSyncRequest;
    this.syncingWordbook = true;
    this.updateSaveButton();
    try {
      const saved = await this.service.isWordInWordbook(word, categoryId);
      if (!isCurrent() || categoryId !== this.currentWordbookId()) return;
      this.saved = saved;
      this.savedCategoryId = categoryId;
      if (this.hasPendingWordbookSave()) {
        this.statusEl.textContent = saved
          ? `已将 ${word} 加入欧路法语生词本，并同步当前状态。`
          : `已提交 ${word}，当前生词本尚未确认收录，请重试同步。`;
        if (saved) this.pendingWordbookSave = null;
      } else {
        this.statusEl.textContent = saved ? `${word} 已在当前欧路法语生词本中。` : "";
      }
    } catch (error) {
      if (!isCurrent() || categoryId !== this.currentWordbookId()) return;
      const message = error?.message || "请稍后重试。";
      this.statusEl.textContent = this.hasPendingWordbookSave()
        ? `已提交 ${word}，生词本状态同步失败：${message}`
        : error?.code === "AUTH_REQUIRED" ? "" : `生词本状态同步失败：${message}`;
    } finally {
      if (isCurrent()) {
        this.syncingWordbook = false;
        this.updateSaveButton();
        this.position();
        if (categoryId !== this.currentWordbookId()) await this.syncWordbookState(generation);
      }
    }
  }

  async saveWord() {
    if (!this.saveTarget || this.saving || this.syncingWordbook
      || (this.saved && this.savedCategoryId === this.currentWordbookId())) return;
    const generation = this.generation;
    const word = this.saveTarget;
    const categoryId = this.currentWordbookId();
    this.saving = true;
    this.updateSaveButton();
    this.statusEl.textContent = "";
    try {
      if (!this.hasPendingWordbookSave()) {
        await this.service.addWord(word, categoryId);
        if (generation !== this.generation || !this.popupEl) return;
        this.pendingWordbookSave = { word, categoryId };
      }
      await this.syncWordbookState(generation);
    } catch (error) {
      if (generation === this.generation && this.popupEl) this.statusEl.textContent = error?.message || "加入生词本失败，请重试。";
    } finally {
      if (generation === this.generation && this.popupEl) {
        this.saving = false;
        this.updateSaveButton();
      }
    }
  }

  position() {
    if (!this.popupEl) return;
    const win = this.popupEl.ownerDocument.defaultView || globalThis.window;
    const size = this.popupEl.getBoundingClientRect();
    const position = positionLookupPopup(this.anchorRect, size, { width: win.innerWidth, height: win.innerHeight });
    Object.assign(this.popupEl.style, {
      left: `${position.left}px`, top: `${position.top}px`,
      maxWidth: `${position.maxWidth}px`, maxHeight: `${position.maxHeight}px`,
    });
  }

  close() {
    this.stopSpeech();
    clearTimeout(this.timer);
    this.timer = null;
    this.generation += 1;
    this.abortController?.abort();
    this.abortController = null;
    this.popupEl?.remove();
    this.popupEl = null;
    this.lookup = null;
    this.pinned = false;
  }

  destroy() {
    this.destroyed = true;
    this.contextMenu?.hide();
    this.contextMenu = null;
    this.close();
    for (const removeListener of this.listeners.splice(0)) removeListener();
    this.documents.clear();
    if (this.workspaceEvent) this.plugin.app.workspace.offref?.(this.workspaceEvent);
    this.workspaceEvent = null;
  }
}

module.exports = { FrenchLookupPopup, positionLookupPopup };
