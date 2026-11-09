const assert = require("assert");
const { BilingualReadingSearch } = require("../src/bilingual-reading-search");

// Keep the tests dependency-free, while retaining real text-node boundaries.
class Node {
  constructor(doc, type) { this.ownerDocument = doc; this.nodeType = type; this.childNodes = []; }
  get parentElement() { return this.parentNode?.nodeType === 1 ? this.parentNode : null; }
  get isConnected() { return this === this.ownerDocument.body || Boolean(this.parentNode?.isConnected); }
  get children() { return this.childNodes.filter((child) => child.nodeType === 1); }
  get firstChild() { return this.childNodes[0] || null; }
  get textContent() { return this.nodeType === 3 ? this.data : this.childNodes.map((child) => child.textContent).join(""); }
  set textContent(text) {
    for (const node of this.childNodes) node.parentNode = null;
    this.childNodes = [];
    if (text) this.appendChild(this.ownerDocument.createTextNode(String(text)));
  }
  appendChild(child) { child.remove(); child.parentNode = this; this.childNodes.push(child); return child; }
  append(...children) { for (const child of children) this.appendChild(typeof child === "string" ? this.ownerDocument.createTextNode(child) : child); }
  insertBefore(child, before) {
    child.remove(); child.parentNode = this;
    const index = this.childNodes.indexOf(before);
    this.childNodes.splice(index < 0 ? this.childNodes.length : index, 0, child);
    return child;
  }
  remove() {
    if (this.parentNode) this.parentNode.childNodes = this.parentNode.childNodes.filter((child) => child !== this);
    this.parentNode = null;
  }
  contains(target) { return this === target || this.childNodes.some((child) => child.contains(target)); }
}

class Element extends Node {
  constructor(doc, tag) {
    super(doc, 1);
    this.tagName = tag.toUpperCase(); this.nodeName = this.tagName;
    this.className = ""; this.attributes = {}; this.style = {}; this.dataset = {};
    this.listeners = new Map(); this.value = ""; this.hidden = false; this.disabled = false;
    this.scrollTop = 0; this.clientHeight = 500; this.tabIndex = 0;
    this.classList = {
      contains: (name) => this.className.split(/\s+/).includes(name),
      add: (...names) => { this.className = [...new Set([...this.className.split(/\s+/).filter(Boolean), ...names])].join(" "); },
      remove: (...names) => { this.className = this.className.split(/\s+/).filter((name) => !names.includes(name)).join(" "); },
      toggle: (name, force) => {
        const add = force === undefined ? !this.classList.contains(name) : force;
        this.classList[add ? "add" : "remove"](name); return add;
      },
    };
  }
  setAttribute(name, value) { this.attributes[name] = String(value); if (name === "class") this.className = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  hasAttribute(name) { return Object.hasOwn(this.attributes, name); }
  removeAttribute(name) { delete this.attributes[name]; }
  matches(selector) {
    return selector.split(",").some((part) => {
      const name = part.trim();
      if (name.startsWith(".")) return name.slice(1).split(".").every((cls) => this.classList.contains(cls));
      if (name === "[hidden]") return this.hidden || this.hasAttribute("hidden");
      if (name === '[aria-hidden="true"]') return this.getAttribute("aria-hidden") === "true";
      if (name === "[contenteditable]" || name === '[contenteditable="true"]') return this.hasAttribute("contenteditable");
      return this.tagName === name.toUpperCase();
    });
  }
  closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector) || null; }
  querySelectorAll(selector) {
    return this.children.flatMap((child) => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  addEventListener(type, listener) { if (!this.listeners.has(type)) this.listeners.set(type, []); this.listeners.get(type).push(listener); }
  removeEventListener(type, listener) { this.listeners.set(type, (this.listeners.get(type) || []).filter((item) => item !== listener)); }
  dispatch(type, options = {}) {
    const event = { target: this, currentTarget: this, key: "", preventDefault() { this.defaultPrevented = true; }, stopPropagation() {}, ...options };
    for (const listener of this.listeners.get(type) || []) listener(event);
    return event;
  }
  focus() { this.ownerDocument.activeElement = this; }
  select() { this.selectionStart = 0; this.selectionEnd = this.value.length; }
  getClientRects() { return this.closest("[hidden]") || this.style.display === "none" ? [] : [this.getBoundingClientRect()]; }
  getBoundingClientRect() { return { top: 0, bottom: 20, left: 0, right: 100, width: 100, height: 20 }; }
  scrollIntoView() { this.scrolled = true; }
  scrollTo(options) { this.scrollTop = options.top; }
  addClass(...names) { this.classList.add(...names); }
  removeClass(...names) { this.classList.remove(...names); }
  toggleClass(name, force) { return this.classList.toggle(name, force); }
  empty() { this.textContent = ""; }
  createEl(tag, options = {}) {
    const element = this.ownerDocument.createElement(tag);
    element.className = options.cls || ""; element.textContent = options.text || "";
    for (const [key, value] of Object.entries(options.attr || {})) element.setAttribute(key, value);
    return this.appendChild(element);
  }
  createDiv(options) { return this.createEl("div", options); }
  createSpan(options) { return this.createEl("span", options); }
}

class Text extends Node {
  constructor(doc, text) { super(doc, 3); this.data = String(text); this.nodeName = "#text"; }
  get nodeValue() { return this.data; }
  get length() { return this.data.length; }
}

class Range {
  constructor(doc) { this.doc = doc; }
  setStart(node, offset) { this.startContainer = node; this.startOffset = offset; }
  setEnd(node, offset) { this.endContainer = node; this.endOffset = offset; }
  get commonAncestorContainer() {
    let node = this.startContainer;
    while (node && !node.contains(this.endContainer)) node = node.parentNode;
    return node;
  }
  toString() {
    const nodes = textNodes(this.doc.body);
    const first = nodes.indexOf(this.startContainer); const last = nodes.indexOf(this.endContainer);
    if (first < 0 || last < first) return "";
    return nodes.slice(first, last + 1).map((node, index, selected) => (
      node.data.slice(index === 0 ? this.startOffset : 0, index === selected.length - 1 ? this.endOffset : undefined)
    )).join("");
  }
  getBoundingClientRect() { return this.startContainer.parentElement.getBoundingClientRect(); }
  getClientRects() { return [this.getBoundingClientRect()]; }
}

function textNodes(node) { return node.nodeType === 3 ? [node] : node.childNodes.flatMap(textNodes); }
class Highlight extends Set { constructor(...ranges) { super(ranges); } }
class MutationObserver { observe() {} disconnect() {} }
const NodeFilter = { SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2, FILTER_SKIP: 3 };

class Document {
  constructor() {
    this.defaultView = {
      CSS: { highlights: new Map() }, Highlight, MutationObserver, NodeFilter,
      getComputedStyle: (element) => ({
        display: element.hidden ? "none" : element.style.display || "block",
        visibility: element.style.visibility || "visible",
      }),
      getSelection: () => ({ toString: () => "" }),
    };
    this.body = new Element(this, "body"); this.head = new Element(this, "head");
  }
  createElement(tag) { return new Element(this, tag); }
  createTextNode(text) { return new Text(this, text); }
  createRange() { return new Range(this); }
  adoptNode(node) {
    node.remove();
    const adopt = (target) => {
      target.ownerDocument = this;
      for (const child of target.childNodes) adopt(child);
    };
    adopt(node);
    return node;
  }
  getSelection() { return this.defaultView.getSelection(); }
  createTreeWalker(root, whatToShow, filter) {
    const nodes = textNodes(root).filter((node) => !filter || (typeof filter === "function" ? filter(node) : filter.acceptNode(node)) === 1);
    let index = 0;
    return { nextNode: () => nodes[index++] || null };
  }
}

function append(parent, tag, text = "", cls = "") {
  const element = parent.appendChild(parent.ownerDocument.createElement(tag));
  element.className = cls; element.textContent = text; return element;
}

function setup(doc = new Document()) {
  const container = append(doc.body, "div"); const root = append(container, "div");
  const original = append(root, "div", "", "lacan-bilingual-content");
  const paragraph = append(original, "p");
  paragraph.append("Le "); append(paragraph, "em", "savoir"); paragraph.append(" analytique. SAVOIR.");
  const translation = append(root, "div", "", "lacan-bilingual-content");
  append(translation, "p", "分析知识：知识进入实在界。");
  append(translation, "blockquote", "注释：保留知识。");
  append(root, "button", "按钮上的知识");
  const view = { containerEl: container, contentRoot: () => root };
  const controller = new BilingualReadingSearch(view);
  return { controller, doc, container, root, original, translation };
}

function inputQuery(fixture, value) {
  const input = fixture.container.querySelector(".lacan-bilingual-search-input");
  assert.ok(input, "opening find must render a search input");
  input.value = value; input.dispatch("input"); return input;
}
function count(fixture) { return fixture.container.querySelector(".lacan-bilingual-search-count")?.textContent; }
function highlightedTexts(doc) { return [...doc.defaultView.CSS.highlights.values()].flatMap((highlight) => [...highlight].map((range) => range.toString())); }

function run() {
  const fixture = setup(); const { controller, doc, container, root } = fixture;
  const originalChildren = [...fixture.original.childNodes]; const originalText = fixture.original.textContent;
  controller.open();
  const input = container.querySelector(".lacan-bilingual-search-input");
  assert.strictEqual(doc.activeElement, input, "Command F's search action must focus the input");
  assert.ok(!input.closest("[hidden]"), "the search input must be visible");

  inputQuery(fixture, "知识");
  assert.strictEqual(count(fixture), "1 / 3", "Chinese body and annotations must both be searchable");
  assert.ok(highlightedTexts(doc).includes("知识"), "matches must be highlighted with text ranges");
  input.dispatch("keydown", { key: "Enter" }); assert.strictEqual(count(fixture), "2 / 3");
  input.dispatch("keydown", { key: "Enter", shiftKey: true }); assert.strictEqual(count(fixture), "1 / 3");
  controller.move(-1); assert.strictEqual(count(fixture), "3 / 3", "previous must wrap to the last match");
  controller.move(1); assert.strictEqual(count(fixture), "1 / 3", "next must wrap to the first match");

  inputQuery(fixture, "SAVOIR"); assert.strictEqual(count(fixture), "1 / 2", "French search must ignore case");
  inputQuery(fixture, "savoir analytique");
  assert.strictEqual(count(fixture), "1 / 1", "a visible phrase must match across emphasis boundaries");
  assert.ok(highlightedTexts(doc).includes("savoir analytique"));
  assert.deepStrictEqual(fixture.original.childNodes, originalChildren, "highlighting must preserve the original nodes and editing hooks");
  assert.strictEqual(fixture.original.textContent, originalText);
  inputQuery(fixture, "实在界。注释");
  assert.strictEqual(count(fixture), "0 / 0", "separate paragraphs must not be concatenated into a false phrase match");

  inputQuery(fixture, "[知识]"); assert.strictEqual(count(fixture), "0 / 0", "search text must be literal rather than a regular expression");
  inputQuery(fixture, ""); assert.strictEqual(count(fixture), "0 / 0");
  assert.strictEqual(doc.defaultView.CSS.highlights.size, 0, "clearing the input must remove painted matches");

  const hidden = append(fixture.translation, "div", "隐藏知识"); hidden.hidden = true;
  append(fixture.translation, "textarea", "编辑知识");
  append(fixture.translation, "button", "操作知识");
  append(fixture.translation, "script", "脚本知识");
  append(fixture.translation, "span", "重复知识", "katex-mathml");
  const concealed = append(fixture.translation, "p", "不可见知识"); concealed.style.display = "none";
  inputQuery(fixture, "知识"); assert.strictEqual(count(fixture), "1 / 3", "hidden text, controls, editors, and duplicate math markup must not count");

  root.textContent = "";
  const refreshed = append(root, "div", "保存后的知识。", "lacan-bilingual-content");
  controller.refresh();
  assert.strictEqual(count(fixture), "1 / 1", "rerendered lesson content must replace stale search ranges");
  assert.strictEqual(container.querySelector(".lacan-bilingual-search-input"), input, "content refresh must retain the search field");
  assert.ok(highlightedTexts(doc).every((text) => text === "知识"));
  assert.strictEqual(input.value, "知识");

  input.dispatch("keydown", { key: "Escape", isComposing: true });
  assert.ok(!input.closest("[hidden]"), "IME composition must not close find");
  input.dispatch("keydown", { key: "Escape" });
  assert.ok(input.closest("[hidden]") || !input.isConnected, "Escape must close find");
  assert.strictEqual(doc.defaultView.CSS.highlights.size, 0, "closing find must release its highlights");
  assert.ok(refreshed.isConnected, "closing find must leave the lesson intact");

  controller.open(); controller.open();
  assert.strictEqual(container.querySelectorAll(".lacan-bilingual-search-input").length, 1, "repeated find commands must reuse the existing field");
  inputQuery(fixture, "知识");
  const second = setup(doc); second.controller.open(); inputQuery(second, "savoir");
  controller.close();
  assert.ok(highlightedTexts(doc).some((text) => text.toLowerCase() === "savoir"), "closing one view must preserve another view's highlights");
  second.controller.destroy(); controller.destroy();
  assert.strictEqual(doc.defaultView.CSS.highlights.size, 0, "destroy must release every owned highlight");
  assert.strictEqual(second.container.querySelector(".lacan-bilingual-search-input"), null, "destroy must remove the search UI");

  const moving = setup(); moving.controller.open(); inputQuery(moving, "知识");
  assert.ok(moving.doc.defaultView.CSS.highlights.size > 0);
  const destination = new Document();
  destination.body.appendChild(destination.adoptNode(moving.container));
  moving.controller.refresh();
  assert.strictEqual(moving.doc.defaultView.CSS.highlights.size, 0, "moving a view to another window must release the old document's highlights");
  assert.strictEqual(count(moving), "1 / 3");
  assert.ok(highlightedTexts(destination).includes("知识"), "the adopted view must paint its matches in the destination document");
  moving.controller.destroy();
  assert.strictEqual(destination.defaultView.CSS.highlights.size, 0, "destroying the adopted view must release the destination document's highlights");
  console.log("bilingual reading search tests passed");
}

run();
