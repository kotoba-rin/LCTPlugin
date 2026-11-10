class TranslationInlineEditor {
  constructor({ readSegment, saveSegment, saveImage, onSaved, onClosed, notify = () => {} }) {
    this.readSegment = readSegment;
    this.saveSegment = saveSegment;
    this.saveImage = saveImage;
    this.onSaved = onSaved;
    this.onClosed = onClosed;
    this.notify = notify;
    this.active = null;
    this.openToken = 0;
    this.destroyed = false;
  }

  async open({ sourcePath, segmentId, hostEl, renderedEls = [] }) {
    if (this.destroyed || !hostEl?.isConnected) return false;
    if (this.active) {
      const current = this.active;
      if (current.sourcePath === sourcePath
        && (current.segmentId === segmentId || current.snapshot.ids?.includes(segmentId))) {
        if (!current.editor.isConnected && !this.reattach({ hostEl, renderedEls })) return false;
        current.input.focus();
        return true;
      }
      if (current.saving || current.pasting || current.input.value !== current.snapshot.markdown) {
        current.input.focus();
        this.report(`请先返回 ${current.segmentId}，保存或取消当前段落的修改。`);
        return false;
      }
      this.close();
    }

    const token = ++this.openToken;
    try {
      const snapshot = await this.readSegment(sourcePath, segmentId);
      if (this.destroyed || token !== this.openToken || !hostEl.isConnected) return false;
      const elements = [...new Set(renderedEls)].filter((element) => (
        element !== hostEl && hostEl.contains(element)
      ));
      // Mount beside the outermost rendered node, never inside a node we hide.
      const outerElements = elements.filter((element) => (
        !elements.some((other) => other !== element && other.contains(element))
      ));
      if (renderedEls.length && !outerElements.length) return false;
      const doc = hostEl.ownerDocument;
      const editor = doc.createElement("div");
      editor.className = "lacan-translation-inline-editor";
      editor.setAttribute("role", "group");
      editor.setAttribute("aria-label", "编辑中文译文");
      const label = editor.appendChild(doc.createElement("div"));
      label.className = "lacan-translation-inline-label";
      label.textContent = `编辑中文译文 · ${(snapshot.ids || [segmentId]).join("、")}`;
      const input = editor.appendChild(doc.createElement("textarea"));
      input.className = "lacan-translation-inline-input";
      input.setAttribute("aria-label", "中文译文 Markdown");
      input.setAttribute("spellcheck", "false");
      input.value = snapshot.markdown;
      input.rows = Math.max(4, Math.min(24, String(snapshot.markdown).split("\n").length + 1));
      const actions = editor.appendChild(doc.createElement("div"));
      actions.className = "lacan-translation-inline-actions";
      const saveButton = actions.appendChild(doc.createElement("button"));
      saveButton.className = "lacan-translation-inline-save mod-cta";
      saveButton.type = "button";
      saveButton.textContent = "保存";
      const cancelButton = actions.appendChild(doc.createElement("button"));
      cancelButton.className = "lacan-translation-inline-cancel";
      cancelButton.type = "button";
      cancelButton.textContent = "取消";
      const hint = editor.appendChild(doc.createElement("div"));
      hint.className = "lacan-translation-inline-hint";
      hint.textContent = "Ctrl + Enter 保存 · Esc 取消 · 支持 Markdown、粘贴图片、注释和建言";
      const errorEl = editor.appendChild(doc.createElement("div"));
      errorEl.className = "lacan-translation-inline-error";
      errorEl.setAttribute("role", "alert");

      const hiddenElements = outerElements.map((element) => ({ element, display: element.style.display }));
      this.active = {
        sourcePath, segmentId, hostEl, snapshot, editor, input, saveButton, cancelButton,
        errorEl, hiddenElements, saving: false, pasting: false,
      };
      const first = outerElements[0];
      if (first) first.parentNode.insertBefore(editor, first);
      else hostEl.appendChild(editor);
      for (const { element } of hiddenElements) element.style.display = "none";
      for (const type of ["click", "dblclick", "mousedown", "pointerdown"]) {
        editor.addEventListener(type, (event) => event.stopPropagation());
      }
      saveButton.addEventListener("click", () => { void this.save(); });
      cancelButton.addEventListener("click", () => this.close());
      input.addEventListener("keydown", (event) => {
        event.stopPropagation();
        if (event.isComposing || event.keyCode === 229) return;
        if (event.key === "Escape") {
          event.preventDefault();
          this.close();
        } else if (event.key === "Enter" && event.ctrlKey) {
          event.preventDefault();
          void this.save();
        }
      });
      input.addEventListener("input", () => this.resize(input));
      input.addEventListener("paste", (event) => { void this.paste(event); });
      this.resize(input);
      input.focus();
      return true;
    } catch (error) {
      if (token === this.openToken && !this.destroyed) {
        this.report(`无法编辑译文：${error.message || error}`);
      }
      return false;
    }
  }

  resize(input) {
    input.style.height = "auto";
    input.style.height = `${Math.max(120, input.scrollHeight || 120)}px`;
  }

  async paste(event) {
    const state = this.active;
    if (!state || !this.saveImage) return false;
    const clipboard = event.clipboardData;
    let images = Array.from(clipboard?.items || [])
      .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
      .map((item) => item.getAsFile()).filter(Boolean);
    if (!images.length) images = Array.from(clipboard?.files || []).filter((file) => file.type.startsWith("image/"));
    if (!images.length) return false;
    event.preventDefault();
    event.stopPropagation();
    if (state.saving || state.pasting) return false;

    const { input } = state;
    let start = input.selectionStart;
    let end = input.selectionEnd;
    state.pasting = true;
    input.readOnly = true;
    state.saveButton.disabled = true;
    state.cancelButton.disabled = true;
    state.saveButton.textContent = "粘贴图片中…";
    state.errorEl.textContent = "";
    try {
      // Reserve each attachment path after the preceding file has been created.
      for (let index = 0; index < images.length; index += 1) {
        if (this.active !== state || this.destroyed) return false;
        const link = await this.saveImage(images[index], state.sourcePath);
        if (this.active !== state || this.destroyed) return false;
        const insertion = (index ? "\n" : "") + link;
        input.setRangeText(insertion, start, end, "end");
        start += insertion.length;
        end = start;
        this.resize(input);
      }
      return true;
    } catch (error) {
      if (this.active === state && !this.destroyed) {
        state.errorEl.textContent = `粘贴图片失败：${error.message || error}`;
      }
      return false;
    } finally {
      state.pasting = false;
      if (this.active === state && !this.destroyed) {
        input.readOnly = false;
        state.saveButton.disabled = false;
        state.cancelButton.disabled = false;
        state.saveButton.textContent = "保存";
        input.focus();
        input.setSelectionRange(start, end);
      }
    }
  }

  async save() {
    const state = this.active;
    if (!state || state.saving || state.pasting) return false;
    state.saving = true;
    state.input.disabled = true;
    state.saveButton.disabled = true;
    state.cancelButton.disabled = true;
    state.errorEl.textContent = "";
    state.saveButton.textContent = "保存中…";
    try {
      await this.saveSegment(state.snapshot, state.input.value);
    } catch (error) {
      if (this.active === state) {
        state.errorEl.textContent = `保存失败：${error.message || error}`;
        state.input.disabled = false;
        state.saveButton.disabled = false;
        state.cancelButton.disabled = false;
        state.saveButton.textContent = "保存";
        state.saving = false;
        state.input.focus();
      }
      return false;
    }
    if (this.active !== state || this.destroyed) return true;
    this.close({ force: true });
    try {
      await this.onSaved?.({ sourcePath: state.sourcePath, segmentId: state.segmentId });
    } catch (error) {
      this.report(`译文已保存，刷新阅读视图失败：${error.message || error}`);
    }
    return true;
  }

  isActiveWithin(rootEl) {
    return Boolean(this.active && rootEl?.contains(this.active.editor));
  }

  reattach({ hostEl, renderedEls = [] }) {
    const state = this.active;
    if (!state || !hostEl?.isConnected) return false;
    if (hostEl.contains(state.editor)) return true;
    const elements = [...new Set(renderedEls)].filter((element) => (
      element !== hostEl && hostEl.contains(element)
    ));
    const outerElements = elements.filter((element) => (
      !elements.some((other) => other !== element && other.contains(element))
    ));
    if (renderedEls.length && !outerElements.length) return false;
    for (const { element, display } of state.hiddenElements) element.style.display = display;
    state.hostEl = hostEl;
    state.hiddenElements = outerElements.map((element) => ({ element, display: element.style.display }));
    const first = outerElements[0];
    if (first) first.parentNode.insertBefore(state.editor, first);
    else hostEl.appendChild(state.editor);
    for (const { element } of state.hiddenElements) element.style.display = "none";
    return true;
  }

  close({ force = false } = {}) {
    if ((this.active?.saving || this.active?.pasting) && !force) return false;
    this.openToken += 1;
    const state = this.active;
    this.active = null;
    if (!state) return true;
    for (const { element, display } of state.hiddenElements) element.style.display = display;
    state.editor.remove();
    if (!this.destroyed) {
      try {
        Promise.resolve(this.onClosed?.({ sourcePath: state.sourcePath, segmentId: state.segmentId }))
          .catch((error) => this.report(`关闭译文编辑器后刷新失败：${error.message || error}`));
      } catch (error) {
        this.report(`关闭译文编辑器后刷新失败：${error.message || error}`);
      }
    }
    return true;
  }

  destroy() {
    this.destroyed = true;
    this.close({ force: true });
  }

  report(message) {
    try { this.notify(message); } catch (error) {
      console.warn("Lacan Translation Helper: inline-edit notice failed.", error);
    }
  }
}

module.exports = { TranslationInlineEditor };
