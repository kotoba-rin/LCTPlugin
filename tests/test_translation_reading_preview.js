const assert = require("assert");
const { bindTranslationPreview, locateTranslationPreviewTarget } = require("../src/translation-reading-preview");

class Element {
  constructor(tag = "div", className = "") {
    this.tagName = tag.toUpperCase();
    this.className = className;
    this.children = [];
    this.attributes = new Map();
    this.listeners = new Map();
    this.classList = {
      add: (value) => { if (!this.className.split(" ").includes(value)) this.className += ` ${value}`; },
      remove: (value) => { this.className = this.className.split(" ").filter((item) => item !== value).join(" "); },
    };
  }
  append(child) { child.parentElement = this; this.children.push(child); return child; }
  contains(element) { return element === this || this.children.some((child) => child.contains(element)); }
  matches(selector) {
    return selector.split(",").some((part) => {
      const value = part.trim();
      if (value === ".markdown-preview-section > div") return this.tagName === "DIV" && this.parentElement?.matches(".markdown-preview-section");
      if (value === "[contenteditable='true']") return this.getAttribute("contenteditable") === "true";
      return value.startsWith(".") ? this.className.split(" ").includes(value.slice(1)) : this.tagName.toLowerCase() === value;
    });
  }
  closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector) || null; }
  getAttribute(key) { return this.attributes.get(key) ?? null; }
  setAttribute(key, value) { this.attributes.set(key, value); }
  removeAttribute(key) { this.attributes.delete(key); }
  addEventListener(type, listener, capture) {
    const records = this.listeners.get(type) || [];
    records.push({ listener, capture });
    this.listeners.set(type, records);
  }
  removeEventListener(type, listener, capture) {
    this.listeners.set(type, (this.listeners.get(type) || []).filter((item) => item.listener !== listener || item.capture !== capture));
  }
}

const sourcePath = "texts/s8-le-transfert/translation/Leçon-01.md";
const source = [
  "# 第一课", "", "<!-- id: s8-01-0001 -->", "", "第一段。", "", "> [注1] 注释。", "",
  "<!-- id: s8-01-0002 -->", "<!-- ids: s8-01-0002 s8-01-0003 -->", "",
  "**合并**的第一行。  ", "第二行。", "", "第二个正文块。", "", "> [注2] 译注。", "",
  "[[notes/s8-01|阅读笔记]]", "", "<!-- id: s8-01-0004 -->", "", "尾段。", "", "[^1]: 独立脚注。",
].join("\n");
const section = new Element("div", "markdown-preview-section");
const infos = new Map();
const block = (tag, start, end = start, cls = `el-${tag}`) => {
  const wrapper = section.append(new Element("div", cls));
  const body = wrapper.append(new Element(tag));
  infos.set(wrapper, { text: source, lineStart: start, lineEnd: end });
  return { wrapper, body };
};
const heading = block("h1", 0);
const first = block("p", 4);
const firstNote = block("blockquote", 6);
const marker = block("p", 8, 9);
const groupedFirst = block("p", 11, 12);
const groupedSecond = block("p", 14);
const secondNote = block("blockquote", 16);
const helperLink = block("p", 18);
helperLink.body.append(new Element("a"));
const last = block("p", 22);
const footnotes = block("section", 24, 24, "footnotes");
const context = {
  getSectionInfo(element) {
    return infos.get(element?.closest(".markdown-preview-section > div")) || null;
  },
};
const eventFor = (target) => ({
  target,
  button: 0,
  preventDefault() { this.prevented = true; },
  stopPropagation() { this.stopped = true; },
  stopImmediatePropagation() { this.immediateStopped = true; },
});

const result = locateTranslationPreviewTarget(eventFor(groupedSecond.body), groupedSecond.wrapper, context, { sourcePath });
assert.strictEqual(result.segmentId, "s8-01-0002");
assert.deepStrictEqual(result.snapshot.ids, ["s8-01-0002", "s8-01-0003"]);
assert.deepStrictEqual(result.renderedElements, [groupedFirst.wrapper, groupedSecond.wrapper, secondNote.wrapper], "a grouped translation and its existing annotations must edit as one unit");
assert.ok(result.snapshot.markdown.includes("**合并**的第一行。"), "editing uses Markdown source rather than flattened DOM text");
assert.ok(result.snapshot.markdown.includes("第二个正文块。"));
assert.ok(result.snapshot.markdown.includes("> [注2] 译注。"), "existing annotations must be included in the editable source");

for (const [candidate, segmentId, renderedElements] of [
  [firstNote, "s8-01-0001", [first.wrapper, firstNote.wrapper]],
  [secondNote, "s8-01-0002", [groupedFirst.wrapper, groupedSecond.wrapper, secondNote.wrapper]],
]) {
  const annotation = locateTranslationPreviewTarget(eventFor(candidate.body), candidate.wrapper, context, { sourcePath });
  assert.strictEqual(annotation.segmentId, segmentId, "double-clicking an annotation must open its whole logical segment");
  assert.deepStrictEqual(annotation.renderedElements, renderedElements);
}

for (const candidate of [heading, marker, helperLink, footnotes]) {
  const event = eventFor(candidate.body);
  assert.strictEqual(locateTranslationPreviewTarget(event, candidate.wrapper, context, { sourcePath }), null, candidate.wrapper.className);
  assert.ok(!event.prevented);
}
assert.strictEqual(locateTranslationPreviewTarget(eventFor(first.body), first.wrapper, context, { sourcePath: sourcePath.replace("/translation/", "/original/") }), null);
assert.strictEqual(locateTranslationPreviewTarget({ ...eventFor(first.body), button: 2 }, first.wrapper, context, { sourcePath }), null);
assert.strictEqual(locateTranslationPreviewTarget(eventFor(first.body), first.wrapper, {}, { sourcePath }), null);
assert.strictEqual(locateTranslationPreviewTarget(eventFor(first.body), last.wrapper, context, { sourcePath }), null);

const sourceWithCommentary = source.replace("> [注2] 译注。", "> [注2] 译注。\n>\n> <!-- 建言 -->\n> 已有建言。");
const commentarySection = new Element("div", "markdown-preview-section");
const commentaryWrapper = commentarySection.append(new Element("div", "el-blockquote"));
const commentaryBody = commentaryWrapper.append(new Element("blockquote"));
const commentaryLine = sourceWithCommentary.split("\n").indexOf("> 已有建言。");
const commentaryContext = { getSectionInfo: () => ({ text: sourceWithCommentary, lineStart: commentaryLine, lineEnd: commentaryLine }) };
const commentary = locateTranslationPreviewTarget(eventFor(commentaryBody), commentaryWrapper, commentaryContext, { sourcePath });
assert.strictEqual(commentary.segmentId, "s8-01-0002");
assert.ok(commentary.snapshot.markdown.includes("> <!-- 建言 -->\n> 已有建言。"), "existing commentary and its marker must be editable with the grouped segment");
assert.deepStrictEqual(commentary.renderedElements, [commentaryWrapper]);

const noteWidget = groupedFirst.body.append(new Element("span", "lacan-segment-note-actions"));
assert.strictEqual(locateTranslationPreviewTarget(eventFor(noteWidget), groupedFirst.wrapper, context, { sourcePath }), null);
const nestedLink = groupedFirst.body.append(new Element("a"));
assert.strictEqual(locateTranslationPreviewTarget(eventFor(nestedLink), groupedFirst.wrapper, context, { sourcePath }), null);
const comparison = groupedFirst.body.append(new Element("div", "lacan-segment-compare-control"));
assert.strictEqual(locateTranslationPreviewTarget(eventFor(comparison), groupedFirst.wrapper, context, { sourcePath }), null);
const bilingual = groupedFirst.body.append(new Element("div", "lacan-bilingual-content"));
assert.strictEqual(locateTranslationPreviewTarget(eventFor(bilingual), groupedFirst.wrapper, context, { sourcePath }), null);

const wideContext = { getSectionInfo: () => ({ text: source, lineStart: 4, lineEnd: 14 }) };
assert.strictEqual(locateTranslationPreviewTarget(eventFor(first.body), first.wrapper, wideContext, { sourcePath }), null, "a section spanning multiple IDs must not guess which source paragraph was clicked");
assert.strictEqual(locateTranslationPreviewTarget(eventFor(first.body), first.wrapper, context, { sourcePath, readSegment() { throw new Error("duplicate ID"); } }), null);

for (const groupSource of [
  source.replace("<!-- id: s8-01-0002 -->\n", ""),
  source.replace("<!-- ids: s8-01-0002 s8-01-0003 -->", "<!-- id: s8-01-0002 s8-01-0003 -->"),
]) {
  const lineStart = groupSource.split("\n").indexOf("第二个正文块。");
  const groupContext = { getSectionInfo: () => ({ text: groupSource, lineStart, lineEnd: lineStart }) };
  assert.strictEqual(locateTranslationPreviewTarget(eventFor(groupedSecond.body), groupedSecond.wrapper, groupContext, { sourcePath }).segmentId, "s8-01-0002");
}

const opened = [];
groupedSecond.wrapper.setAttribute("title", "旧提示");
const cleanup = bindTranslationPreview(groupedSecond.wrapper, context, { sourcePath, openEditor: (target) => opened.push(target) });
assert.strictEqual(groupedSecond.wrapper.getAttribute("data-lacan-inline-segment-id"), "s8-01-0002");
assert.ok(groupedSecond.wrapper.matches(".lacan-translation-editable"));
assert.strictEqual(groupedSecond.wrapper.listeners.get("dblclick")[0].capture, true);
const event = eventFor(groupedSecond.body);
groupedSecond.wrapper.listeners.get("dblclick")[0].listener(event);
assert.strictEqual(opened.length, 1);
assert.ok(event.prevented && event.stopped && event.immediateStopped);
let updatedOpened = 0;
assert.strictEqual(bindTranslationPreview(groupedSecond.wrapper, context, { sourcePath, openEditor() { updatedOpened += 1; } }), cleanup);
assert.strictEqual(groupedSecond.wrapper.listeners.get("dblclick").length, 1, "repeated postprocessing must not register duplicate handlers");
groupedSecond.wrapper.listeners.get("dblclick")[0].listener(eventFor(groupedSecond.body));
assert.strictEqual(updatedOpened, 1, "rebinding must refresh the callback and source context");
assert.strictEqual(opened.length, 1);
cleanup();
cleanup();
assert.strictEqual(groupedSecond.wrapper.listeners.get("dblclick").length, 0);
assert.strictEqual(groupedSecond.wrapper.getAttribute("title"), "旧提示");
assert.strictEqual(groupedSecond.wrapper.getAttribute("data-lacan-inline-segment-id"), null);
assert.ok(!groupedSecond.wrapper.matches(".lacan-translation-editable"));

const openedFromAnnotation = [];
const cleanupAnnotation = bindTranslationPreview(secondNote.wrapper, context, { sourcePath, openEditor: (target) => openedFromAnnotation.push(target) });
assert.ok(secondNote.wrapper.matches(".lacan-translation-editable"));
assert.strictEqual(secondNote.wrapper.getAttribute("data-lacan-inline-segment-id"), "s8-01-0002");
secondNote.wrapper.listeners.get("dblclick")[0].listener(eventFor(secondNote.body));
assert.strictEqual(openedFromAnnotation.length, 1);
assert.deepStrictEqual(openedFromAnnotation[0].renderedElements, [groupedFirst.wrapper, groupedSecond.wrapper, secondNote.wrapper]);
cleanupAnnotation();

console.log("translation reading preview tests passed");
