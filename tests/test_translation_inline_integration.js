const assert = require("assert");
const Module = require("module");

const notices = [];
class TFile {
  constructor(path) { this.path = path; this.extension = "md"; }
}
const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === "obsidian") {
    return {
      BasesView: class {}, Component: class {}, Plugin: class {}, PluginSettingTab: class {},
      Setting: class {}, ItemView: class {}, FileView: class {}, MarkdownView: class {},
      MarkdownRenderer: { async render() {} }, TFile,
      Notice: class { constructor(message) { notices.push(message); } },
      normalizePath: (value) => String(value || "").replace(/\\/g, "/").replace(/\/+/g, "/"),
    };
  }
  if (request === "@codemirror/view") return { Decoration: {}, ViewPlugin: {}, WidgetType: class {} };
  return originalLoad(request, parent, isMain);
};
let PluginClass;
try { PluginClass = require("../src/main"); }
finally { Module._load = originalLoad; }

class Element {
  constructor(tag = "div", className = "") {
    this.nodeType = 1;
    this.tagName = tag.toUpperCase();
    this.className = className;
    this.children = [];
    this.listeners = new Map();
    this.attributes = {};
    this._textContent = "";
  }
  get textContent() { return this._textContent + this.children.map((child) => child.textContent).join(""); }
  set textContent(value) { this._textContent = String(value); this.children = []; }
  addClass(name) { this.className += ` ${name}`; }
  setAttribute(name, value) { this.attributes[name] = value; }
  appendChild(child) { child.parentElement = this; this.children.push(child); return child; }
  addEventListener(type, callback, options) { this.listeners.set(type, { callback, options }); }
  matches(selector) {
    return selector.split(",").some((candidate) => {
      const parts = candidate.trim().split(".");
      const [tag, ...classes] = parts;
      return (!tag || tag.toUpperCase() === this.tagName)
        && classes.every((name) => this.className.split(/\s+/).includes(name));
    });
  }
  closest(selector) {
    for (let element = this; element; element = element.parentElement) {
      if (element.matches(selector)) return element;
    }
    return null;
  }
  doubleClick(target = this) {
    const event = {
      target, button: 0, prevented: false, stopped: false,
      preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; },
    };
    this.listeners.get("dblclick")?.callback(event);
    return event;
  }
}

const translationPath = "texts/s8-le-transfert/translation/Leçon-01.md";
const originalPath = translationPath.replace("/translation/", "/original/");
const otherTranslationPath = "texts/s8-le-transfert/translation/Leçon-02.md";
const oldBody = "第一段**中文**[^1]。\n\n同一组里的下一自然段。\n\n> [注] 保留原注内容。\n\n> <!-- 建言 -->\n> 原有建言内容。";
const newBody = "修改后的**完整中文译文**[^1]。\n\n编辑覆盖整组 IDs 的全部正文。\n\n> [注] 修改后的注释。\n\n> <!-- 建言 -->\n> 修改后的建言。";
const source = [
  "---", "title: 保留课文元数据", "---", "", "# 译文标题", "",
  "<!-- id: s8-01-0001 -->", "<!-- ids: s8-01-0001 s8-01-0002 -->", "", oldBody, "",
  "[[notes/s8-01#s8-01-0001|阅读笔记]]", "", "---", "",
  "<!-- id: s8-01-0003 -->", "", "其他分段原有译文。", "", "[^1]: 保留脚注内容。", "",
].join("\n");

function setup() {
  const files = new Map([
    [translationPath, new TFile(translationPath)], [originalPath, new TFile(originalPath)],
    [otherTranslationPath, new TFile(otherTranslationPath)],
  ]);
  const texts = new Map([[translationPath, source], [originalPath, "法语原文必须保持原样。"]]);
  const calls = {
    reads: [], processed: [], mono: [], bilingual: [], cacheClears: 0,
    attachmentPaths: [], binaries: [], links: [],
  };
  const sameMono = { file: files.get(translationPath), getViewType: () => "markdown" };
  const unrelatedMono = { file: files.get(otherTranslationPath), getViewType: () => "markdown" };
  const sourceMono = { file: files.get(originalPath), getViewType: () => "markdown" };
  const sameBilingual = {
    sourcePath: originalPath, getViewType: () => "lacan-bilingual-reading",
    lessonPaths: () => ({ translationPath, originalPath }),
    render: async () => { calls.bilingual.push("same"); },
  };
  const unrelatedBilingual = {
    getViewType: () => "lacan-bilingual-reading", lessonPaths: () => ({ translationPath: otherTranslationPath }),
    render: async () => { calls.bilingual.push("other"); },
  };
  const leaves = [sameMono, unrelatedMono, sourceMono, sameBilingual, unrelatedBilingual].map((view) => ({ view }));
  const plugin = Object.create(PluginClass.prototype);
  plugin.app = {
    vault: {
      getAbstractFileByPath: (path) => files.get(path),
      read: async (file) => { calls.reads.push(file.path); return texts.get(file.path); },
      process: async (file, processor) => {
        calls.processed.push(file.path);
        const result = processor(texts.get(file.path));
        texts.set(file.path, result);
      },
      createBinary: async (path, data) => {
        calls.binaries.push({ path, data });
        const file = new TFile(path);
        files.set(path, file);
        return file;
      },
    },
    fileManager: {
      getAvailablePathForAttachment: async (name, sourcePath) => {
        calls.attachmentPaths.push({ name, sourcePath });
        return `attachments/${name}`;
      },
      generateMarkdownLink: (file, sourcePath) => {
        calls.links.push({ file, sourcePath });
        return `[[${file.path}]]`;
      },
    },
    workspace: {
      iterateAllLeaves: (visitor) => leaves.forEach(visitor),
      getLeavesOfType: (type) => leaves.filter((leaf) => leaf.view.getViewType() === type),
    },
  };
  plugin.segmentPreviewCache = { clear: () => { calls.cacheClears += 1; } };
  plugin.rerenderPreview = async (view) => { calls.mono.push(view.file.path); };
  plugin.initializeTranslationInlineEditing();
  return { plugin, editor: plugin.translationInlineEditor, texts, files, calls, sameBilingual, unrelatedBilingual };
}

async function run() {
  const imagePaste = setup();
  assert.strictEqual(typeof imagePaste.editor.saveImage, "function", "inline editing must accept clipboard images through the Obsidian attachment integration");
  const imageBytes = new Uint8Array([137, 80, 78, 71]).buffer;
  const imageFile = { name: "注释图 1.png", type: "image/png", arrayBuffer: async () => imageBytes };
  const imageLink = await imagePaste.editor.saveImage(imageFile, translationPath);
  assert.strictEqual(imageLink, "![[attachments/注释图 1.png]]", "the pasted image uses Obsidian's configured embedded-link format");
  assert.deepStrictEqual(imagePaste.calls.attachmentPaths, [{ name: imageFile.name, sourcePath: translationPath }], "resolve the attachment directory relative to the edited Chinese lesson, even when its bilingual view was opened from French");
  assert.deepStrictEqual(imagePaste.calls.binaries, [{ path: "attachments/注释图 1.png", data: imageBytes }]);
  assert.deepStrictEqual(imagePaste.calls.links, [{ file: imagePaste.files.get("attachments/注释图 1.png"), sourcePath: translationPath }]);
  assert.strictEqual(imagePaste.texts.get(translationPath), source, "saving the attachment alone leaves Markdown changes in the draft until Save");
  assert.strictEqual(imagePaste.calls.processed.length, 0);
  const imageSnapshot = await imagePaste.editor.readSegment(translationPath, "s8-01-0002");
  await imagePaste.editor.saveSegment(imageSnapshot, `${oldBody}\n\n${imageLink}`);
  assert.strictEqual(imagePaste.texts.get(translationPath), source.replace(oldBody, `${oldBody}\n\n${imageLink}`), "saving the draft writes the image reference with the complete editable segment");
  assert.strictEqual(imagePaste.texts.get(originalPath), "法语原文必须保持原样。");

  const configuredAttachment = setup();
  configuredAttachment.plugin.app.fileManager.getAvailablePathForAttachment = async (name, sourcePath) => {
    configuredAttachment.calls.attachmentPaths.push({ name, sourcePath });
    return "texts/s8-le-transfert/translation/assets/注释图 1 2.png";
  };
  configuredAttachment.plugin.app.fileManager.generateMarkdownLink = (file, sourcePath) => {
    configuredAttachment.calls.links.push({ file, sourcePath });
    return "[注释图 1 2](assets/%E6%B3%A8%E9%87%8A%E5%9B%BE%201%202.png)";
  };
  assert.strictEqual(
    await configuredAttachment.editor.saveImage(imageFile, translationPath),
    "![注释图 1 2](assets/%E6%B3%A8%E9%87%8A%E5%9B%BE%201%202.png)",
    "keep Obsidian's collision-safe attachment path and encoded Markdown link without rewriting either",
  );
  assert.strictEqual(configuredAttachment.calls.binaries[0].path, "texts/s8-le-transfert/translation/assets/注释图 1 2.png");

  const imageNames = setup();
  await imageNames.editor.saveImage({ ...imageFile, name: "image.png" }, translationPath);
  assert.match(imageNames.calls.attachmentPaths[0].name, /^Pasted image \d{14}\.png$/, "clipboard screenshots receive the native timestamp-style name");
  await imageNames.editor.saveImage({ ...imageFile, name: "diagram.data", type: "image/jpeg" }, translationPath);
  assert.strictEqual(imageNames.calls.attachmentPaths[1].name, "diagram.data.jpg", "derive a usable JPEG extension from the MIME type when the filename has no known image extension");
  await imageNames.editor.saveImage({ ...imageFile, name: "C:\\temp\\bad:name?.PNG" }, translationPath);
  assert.strictEqual(imageNames.calls.attachmentPaths[2].name, "badname.PNG", "clipboard filenames cannot supply directories or unsupported filename characters");
  await assert.rejects(imageNames.editor.saveImage({ ...imageFile, type: "image/unknown" }, translationPath), /不支持.*图片格式/);
  assert.strictEqual(imageNames.calls.binaries.length, 3, "unknown image formats fail before writing an attachment");

  const invalidImageTarget = setup();
  await assert.rejects(invalidImageTarget.editor.saveImage(imageFile, originalPath), /只能编辑中文/);
  invalidImageTarget.files.delete(translationPath);
  await assert.rejects(invalidImageTarget.editor.saveImage(imageFile, translationPath), /移动或删除|找不到/);
  assert.strictEqual(invalidImageTarget.calls.binaries.length, 0, "invalid or removed source files must not leave orphan attachments");

  const attachmentFailure = setup();
  attachmentFailure.plugin.app.vault.createBinary = async () => { throw new Error("附件目录不可写"); };
  await assert.rejects(attachmentFailure.editor.saveImage(imageFile, translationPath), /附件目录不可写/);
  assert.strictEqual(attachmentFailure.calls.links.length, 0, "a failed attachment write must never produce a broken image reference");
  assert.strictEqual(attachmentFailure.texts.get(translationPath), source);
  assert.strictEqual(attachmentFailure.calls.processed.length, 0);

  const basic = setup();
  const snapshot = await basic.editor.readSegment(translationPath, "s8-01-0002");
  assert.strictEqual(snapshot.markdown, oldBody);
  assert.deepStrictEqual(snapshot.ids, ["s8-01-0001", "s8-01-0002"]);
  assert.strictEqual(snapshot.primaryId, "s8-01-0001");
  assert.strictEqual(snapshot.sourcePath, translationPath);
  assert.deepStrictEqual(basic.calls.reads, [translationPath], "editing a translation must read its actual Markdown source");
  await basic.editor.saveSegment(snapshot, newBody);
  assert.strictEqual(basic.texts.get(translationPath), source.replace(oldBody, newBody), "atomic write replaces the complete grouped text and preserves all surrounding Markdown byte-for-byte");
  assert.deepStrictEqual(basic.calls.processed, [translationPath], "writes must use vault.process on the Chinese file");
  assert.strictEqual(basic.texts.get(originalPath), "法语原文必须保持原样。");
  const savedSnapshot = await basic.editor.readSegment(translationPath, "s8-01-0002");
  assert.strictEqual(savedSnapshot.markdown, newBody, "body, annotation and commentary all belong to the same editable group");
  assert.strictEqual((basic.texts.get(translationPath).match(/修改后的注释。/g) || []).length, 1);
  assert.strictEqual((basic.texts.get(translationPath).match(/修改后的建言。/g) || []).length, 1, "saving commentary must not duplicate its protected original");
  const bodyWithoutNotes = "删除注释和建言后保留的整组正文[^1]。";
  await basic.editor.saveSegment(savedSnapshot, bodyWithoutNotes);
  assert.strictEqual(basic.texts.get(translationPath), source.replace(oldBody, bodyWithoutNotes), "deleting annotations and commentary removes them from the file once");
  const addToPlain = setup();
  const plainSnapshot = await addToPlain.editor.readSegment(translationPath, "s8-01-0003");
  const addedNotes = "其他分段原有译文。\n\n> [注] 新增注释。\n\n> <!-- 建言 -->\n> 新增建言。";
  await addToPlain.editor.saveSegment(plainSnapshot, addedNotes);
  assert.strictEqual(addToPlain.texts.get(translationPath), source.replace("其他分段原有译文。", addedNotes), "a plain segment accepts new annotations and commentary without touching the grouped neighbor or footnotes");
  const addedSnapshot = await addToPlain.editor.readSegment(translationPath, "s8-01-0003");
  assert.strictEqual(addedSnapshot.markdown, addedNotes);
  await addToPlain.editor.saveSegment(addedSnapshot, addedNotes);
  assert.strictEqual(addToPlain.texts.get(translationPath), source.replace("其他分段原有译文。", addedNotes), "saving the full content twice must not duplicate new notes");
  assert.strictEqual(addToPlain.texts.get(originalPath), "法语原文必须保持原样。");
  await assert.rejects(basic.editor.readSegment(originalPath, "s8-01-0001"), /只能编辑中文/);
  await assert.rejects(basic.editor.saveSegment({ ...snapshot, sourcePath: originalPath }, newBody), /只能编辑中文/);

  const concurrentOther = setup();
  const otherSnapshot = await concurrentOther.editor.readSegment(translationPath, "s8-01-0001");
  concurrentOther.texts.set(translationPath, source.replace("其他分段原有译文。", "另一个窗口刚修改的其他分段。"));
  await concurrentOther.editor.saveSegment(otherSnapshot, newBody);
  assert.strictEqual(concurrentOther.texts.get(translationPath), source.replace("其他分段原有译文。", "另一个窗口刚修改的其他分段。").replace(oldBody, newBody), "concurrent edits outside the target group must survive");

  const concurrentSame = setup();
  const staleSnapshot = await concurrentSame.editor.readSegment(translationPath, "s8-01-0002");
  const editedByOther = source.replace(oldBody, "另一个窗口已修改这个分段。");
  concurrentSame.texts.set(translationPath, editedByOther);
  await assert.rejects(concurrentSame.editor.saveSegment(staleSnapshot, newBody), /修改|变化|更改/);
  assert.strictEqual(concurrentSame.texts.get(translationPath), editedByOther, "a stale edit must never overwrite a changed target paragraph");
  const concurrentNote = setup();
  const noteSnapshot = await concurrentNote.editor.readSegment(translationPath, "s8-01-0002");
  const noteEditedByOther = source.replace("保留原注内容。", "另一个窗口修改了注释。");
  concurrentNote.texts.set(translationPath, noteEditedByOther);
  await assert.rejects(concurrentNote.editor.saveSegment(noteSnapshot, newBody), /修改|变化|更改/);
  assert.strictEqual(concurrentNote.texts.get(translationPath), noteEditedByOther, "a concurrent annotation edit now conflicts because notes are part of the same editable block");
  concurrentSame.files.delete(translationPath);
  await assert.rejects(concurrentSame.editor.saveSegment(staleSnapshot, newBody), /移动或删除/);

  await basic.editor.onSaved({ sourcePath: translationPath, segmentId: "s8-01-0002" });
  assert.deepStrictEqual(basic.calls.mono, [translationPath]);
  assert.deepStrictEqual(basic.calls.bilingual, ["same"], "refresh the matching bilingual view even when opened from its French source");
  assert.strictEqual(basic.calls.cacheClears, 1);
  assert.ok(notices.some((message) => message.includes("已保存到 Markdown")));
  basic.sameBilingual.pendingInlineRefresh = true;
  basic.editor.onClosed({ sourcePath: translationPath, segmentId: "s8-01-0002" });
  assert.deepStrictEqual(basic.calls.bilingual, ["same", "same"], "cancelling an editor refreshes a view whose external update was deferred");

  const bound = setup();
  const opened = [];
  let lookupClosed = 0;
  bound.plugin.frenchLookupPopup = { close: () => { lookupClosed += 1; } };
  bound.editor.open = async (target) => { opened.push(target); return true; };
  const body = new Element("div", "lacan-bilingual-content");
  const paragraph = body.appendChild(new Element("p"));
  const emphasis = paragraph.appendChild(new Element("strong"));
  const secondParagraph = body.appendChild(new Element("p"));
  const quote = body.appendChild(new Element("blockquote"));
  const quoted = quote.appendChild(new Element("p"));
  const footnotes = body.appendChild(new Element("section", "footnotes"));
  const note = body.appendChild(new Element("p"));
  const noteLink = note.appendChild(new Element("a", "internal-link"));
  noteLink.textContent = "阅读笔记";
  const link = paragraph.appendChild(new Element("a"));
  const footnoteRef = paragraph.appendChild(new Element("sup", "footnote-ref"));
  const ownEditor = paragraph.appendChild(new Element("div", "lacan-translation-inline-editor"));
  const input = ownEditor.appendChild(new Element("textarea"));
  bound.plugin.bindTranslationBlockEditing(body, translationPath, "s8-01-0002");
  assert.ok(body.className.includes("lacan-translation-editable"));
  assert.strictEqual(body.listeners.get("dblclick").options.capture, true, "handle the edit before native reading-view double-click switches mode");
  for (const excluded of [link, noteLink, footnotes, footnoteRef, input, ownEditor]) {
    const event = body.doubleClick(excluded);
    assert.strictEqual(event.prevented, false, "links, global footnotes and editor controls retain their own actions");
  }
  assert.strictEqual(opened.length, 0);
  const event = body.doubleClick({ nodeType: 3, parentElement: emphasis });
  assert.strictEqual(event.prevented, true);
  assert.strictEqual(event.stopped, true);
  assert.strictEqual(opened.length, 1);
  assert.strictEqual(lookupClosed, 1);
  assert.deepStrictEqual(opened[0], { sourcePath: translationPath, segmentId: "s8-01-0002", hostEl: body, renderedEls: [paragraph, secondParagraph, quote] });
  const noteEvent = body.doubleClick(quoted);
  assert.strictEqual(noteEvent.prevented, true, "double-clicking an annotation opens the whole segment for editing");
  assert.strictEqual(opened.length, 2);
  assert.deepStrictEqual(opened[1], opened[0]);
  const frenchBody = new Element();
  bound.plugin.bindTranslationBlockEditing(frenchBody, originalPath, "s8-01-0002");
  assert.strictEqual(frenchBody.listeners.size, 0, "French source blocks cannot enter Chinese editing");
  const genericBody = new Element();
  bound.plugin.bindTranslationBlockEditing(genericBody, "知识库/卡片.md", "s8-01-0002");
  assert.strictEqual(genericBody.listeners.size, 0);

  const idNoteBody = new Element();
  const text = idNoteBody.appendChild(new Element("p"));
  const idNote = idNoteBody.appendChild(new Element("p"));
  const idNoteLink = idNote.appendChild(new Element("a", "internal-link"));
  idNoteLink.textContent = "s8-01";
  bound.plugin.bindTranslationBlockEditing(idNoteBody, translationPath, "s8-01-0002");
  idNoteBody.doubleClick(text);
  assert.deepStrictEqual(opened.at(-1).renderedEls, [text], "reading-note links labeled with a chapter ID stay outside the editable text");
  console.log("Translation inline integration tests passed");
}
run().catch((error) => { console.error(error); process.exitCode = 1; });
