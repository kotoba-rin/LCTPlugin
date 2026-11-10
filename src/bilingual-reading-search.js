let nextSearchId = 0;
const BLOCK_TAGS = new Set(["P", "DIV", "SECTION", "BLOCKQUOTE", "LI", "UL", "OL", "PRE", "TABLE", "TR", "TD", "TH", "H1", "H2", "H3", "H4", "H5", "H6"]);
const EXCLUDED = "script, style, input, textarea, button, select, svg, .katex-mathml, .lacan-translation-inline-editor";

// Ranges span inline Markdown formatting without wrapping or replacing its DOM.
function findTextRanges(rootEl, query) {
  if (!query) return [];
  const doc = rootEl.ownerDocument;
  const win = doc.defaultView;
  const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu");
  const ranges = [];
  for (const body of rootEl.querySelectorAll(".lacan-bilingual-content")) {
    const nodes = [];
    let text = "";
    const newline = () => { if (text && !text.endsWith("\n")) text += "\n"; };
    const visit = (node) => {
      if (node.nodeType === 3) {
        const value = node.nodeValue || "";
        nodes.push({ node, start: text.length, end: text.length + value.length });
        text += value;
        return;
      }
      if (node.nodeType !== 1 || node.matches(EXCLUDED) || node.hidden) return;
      const style = win?.getComputedStyle?.(node);
      if (style?.display === "none" || style?.visibility === "hidden") return;
      if (node.tagName === "BR") { newline(); return; }
      const block = BLOCK_TAGS.has(node.tagName);
      if (block) newline();
      for (const child of node.childNodes) visit(child);
      if (block) newline();
    };
    visit(body);
    pattern.lastIndex = 0;
    let firstIndex = 0;
    let lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const end = match.index + match[0].length;
      // Literal matches are ordered and non-overlapping, as are text nodes.
      while (firstIndex < nodes.length && nodes[firstIndex].end <= match.index) firstIndex += 1;
      while (lastIndex < nodes.length && nodes[lastIndex].end < end) lastIndex += 1;
      const first = nodes[firstIndex];
      const last = nodes[lastIndex];
      if (!first || !last || last.start >= end) continue;
      const range = doc.createRange();
      range.setStart(first.node, match.index - first.start);
      range.setEnd(last.node, end - last.start);
      ranges.push(range);
    }
  }
  return ranges;
}

class BilingualReadingSearch {
  constructor(view) {
    this.view = view;
    this.matches = [];
    this.index = 0;
    const id = ++nextSearchId;
    this.matchName = `lacan-bilingual-find-${id}`;
    this.activeName = `${this.matchName}-active`;
  }

  get isOpen() { return Boolean(this.bar && !this.bar.hidden); }

  mount() {
    const root = this.view.contentRoot();
    const doc = root.ownerDocument;
    const bar = doc.createElement("div");
    bar.className = "lacan-bilingual-search";
    bar.setAttribute("role", "search");
    bar.setAttribute("aria-label", "在双语正文中查找");
    const input = bar.appendChild(doc.createElement("input"));
    input.className = "lacan-bilingual-search-input";
    input.type = "search";
    input.placeholder = "查找中法正文…";
    input.setAttribute("aria-label", "查找中法正文");
    input.setAttribute("spellcheck", "false");
    const count = bar.appendChild(doc.createElement("span"));
    count.className = "lacan-bilingual-search-count";
    count.setAttribute("role", "status");
    count.setAttribute("aria-live", "polite");
    const button = (label, text, callback) => {
      const element = bar.appendChild(doc.createElement("button"));
      element.type = "button";
      element.textContent = text;
      element.setAttribute("aria-label", label);
      element.setAttribute("title", label);
      element.addEventListener("click", callback);
      return element;
    };
    this.previous = button("上一个匹配（Shift+Enter）", "↑", () => this.move(-1));
    this.next = button("下一个匹配（Enter）", "↓", () => this.move(1));
    button("关闭查找（Esc）", "×", () => this.close());
    input.addEventListener("input", () => {
      this.index = 0;
      this.refresh({ scroll: true });
    });
    input.addEventListener("keydown", (event) => {
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key === "Enter" || event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (event.key === "Escape") this.close();
        else this.move(event.shiftKey ? -1 : 1);
      }
    });
    // Keep the input outside the body that render() replaces on file changes.
    this.view.containerEl.insertBefore(bar, root);
    const style = doc.createElement("style");
    style.textContent = `
      ::highlight(${this.matchName}) { background-color: var(--text-highlight-bg, #ffe580); }
      ::highlight(${this.activeName}) { background-color: var(--interactive-accent, #725bf5); color: var(--text-on-accent, white); }`;
    bar.appendChild(style);
    this.bar = bar;
    this.input = input;
    this.count = count;
    const Observer = doc.defaultView?.MutationObserver;
    if (Observer) {
      this.observer = new Observer(() => {
        clearTimeout(this.refreshTimer);
        this.refreshTimer = setTimeout(() => this.refresh(), 80);
      });
    }
  }

  open() {
    if (!this.bar) this.mount();
    const root = this.view.contentRoot();
    const selection = root.ownerDocument.getSelection?.();
    const selected = selection && root.contains(selection.anchorNode) && root.contains(selection.focusNode)
      ? selection.toString().trim() : "";
    if (selected && selected.length <= 300) { this.input.value = selected; this.index = 0; }
    this.bar.hidden = false;
    this.observer?.observe(root, { childList: true, characterData: true, attributes: true, attributeFilter: ["style", "class", "hidden"], subtree: true });
    this.refresh({ scroll: true });
    this.input.focus();
    this.input.select();
  }

  clearMatches() {
    this.matches = [];
    this.paint();
  }

  refresh({ scroll = false } = {}) {
    clearTimeout(this.refreshTimer);
    if (!this.isOpen) return;
    this.matches = findTextRanges(this.view.contentRoot(), this.input.value);
    this.index = Math.min(this.index, Math.max(0, this.matches.length - 1));
    this.paint();
    if (scroll) this.scrollToMatch();
  }

  paint() {
    const win = this.view.contentRoot().ownerDocument?.defaultView;
    const highlights = win?.CSS?.highlights;
    // Moving a leaf to another Obsidian window changes its highlight registry.
    if (this.highlights && this.highlights !== highlights) {
      this.highlights.delete(this.matchName);
      this.highlights.delete(this.activeName);
    }
    this.highlights = highlights;
    highlights?.delete(this.matchName);
    highlights?.delete(this.activeName);
    if (this.matches.length && highlights && win.Highlight) {
      const all = new win.Highlight();
      for (const range of this.matches) all.add(range);
      highlights.set(this.matchName, all);
      highlights.set(this.activeName, new win.Highlight(this.matches[this.index]));
    }
    if (this.count) this.count.textContent = `${this.matches.length ? this.index + 1 : 0} / ${this.matches.length}`;
    if (this.previous) this.previous.disabled = !this.matches.length;
    if (this.next) this.next.disabled = !this.matches.length;
  }

  move(direction) {
    if (!this.isOpen || !this.matches.length) return;
    this.index = (this.index + direction + this.matches.length) % this.matches.length;
    this.paint();
    this.scrollToMatch();
  }

  scrollToMatch() {
    const range = this.matches[this.index];
    if (!range) return;
    const root = this.view.contentRoot();
    const rect = range.getBoundingClientRect?.();
    const rootRect = root.getBoundingClientRect?.();
    if (rect && rootRect && root.clientHeight) {
      root.scrollTop += rect.top - rootRect.top - root.clientHeight / 2 + rect.height / 2;
    } else {
      range.startContainer.parentElement?.scrollIntoView?.({ block: "center", inline: "nearest" });
    }
  }

  close({ focus = true } = {}) {
    if (!this.bar) return;
    this.bar.hidden = true;
    this.observer?.disconnect();
    clearTimeout(this.refreshTimer);
    this.clearMatches();
    if (focus) {
      const root = this.view.contentRoot();
      root.setAttribute("tabindex", "-1");
      root.focus({ preventScroll: true });
    }
  }

  destroy() {
    this.close({ focus: false });
    this.bar?.remove();
    this.bar = null;
  }
}

module.exports = { BilingualReadingSearch };
