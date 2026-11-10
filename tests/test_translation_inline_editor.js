const assert = require("assert");
const { TranslationInlineEditor } = require("../src/translation-inline-editor");

class Element {
  constructor(doc, tag = "div") {
    this.ownerDocument = doc;
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.style = { display: "" };
    this.attributes = {};
    this.listeners = new Map();
    this.className = "";
    this.textContent = "";
    this.value = "";
    this.disabled = false;
    this.readOnly = false;
    this.selectionStart = 0;
    this.selectionEnd = 0;
    this.scrollHeight = 120;
  }
  get parentNode() { return this.parentElement; }
  get isConnected() { return this === this.ownerDocument.body || Boolean(this.parentElement?.isConnected); }
  appendChild(child) { child.remove(); child.parentElement = this; this.children.push(child); return child; }
  insertBefore(child, reference) { child.remove(); child.parentElement = this; this.children.splice(this.children.indexOf(reference), 0, child); return child; }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter((item) => item !== this); this.parentElement = null; }
  contains(target) { return target === this || this.children.some((child) => child.contains(target)); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  addEventListener(type, listener) { if (!this.listeners.has(type)) this.listeners.set(type, []); this.listeners.get(type).push(listener); }
  dispatch(type, event = {}) { for (const listener of this.listeners.get(type) || []) listener({ target: this, preventDefault() {}, stopPropagation() {}, ...event }); }
  focus() { this.ownerDocument.activeElement = this; }
  setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; }
  setRangeText(text, start, end) {
    this.value = this.value.slice(0, start) + text + this.value.slice(end);
    this.setSelectionRange(start + text.length, start + text.length);
  }
  find(className) { if (this.className.split(/\s+/).includes(className)) return this; return this.children.map((child) => child.find(className)).find(Boolean); }
}
class Document {
  constructor() { this.body = new Element(this, "body"); }
  createElement(tag) { return new Element(this, tag); }
}
const flush = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
function setup(overrides = {}) {
  const doc = new Document();
  const hostEl = doc.body.appendChild(doc.createElement("section"));
  const original = hostEl.appendChild(doc.createElement("p"));
  original.textContent = "**整段**中文[^1]。";
  original.style.display = "block";
  const note = hostEl.appendChild(doc.createElement("aside"));
  note.textContent = "阅读笔记导航";
  const reads = [];
  const writes = [];
  const saved = [];
  const notices = [];
  const snapshot = { markdown: "**整段**中文[^1]。", ids: ["s8-01-0001", "s8-01-0002"] };
  const controller = new TranslationInlineEditor({
    readSegment: async (path, id) => { reads.push({ path, id }); return snapshot; },
    saveSegment: async (currentSnapshot, markdown) => { writes.push({ snapshot: currentSnapshot, markdown }); },
    onSaved: async (target) => { saved.push(target); assert.strictEqual(controller.active, null, "the editor closes before refreshing rendered content"); },
    notify: (message) => notices.push(message),
    ...overrides,
  });
  const target = { sourcePath: "texts/s8/translation/Leçon-01.md", segmentId: "s8-01-0002", hostEl, renderedEls: [original] };
  return { controller, doc, hostEl, original, note, reads, writes, saved, notices, snapshot, target };
}

async function run() {
  const basic = setup();
  assert.strictEqual(await basic.controller.open(basic.target), true);
  assert.deepStrictEqual(basic.reads, [{ path: basic.target.sourcePath, id: basic.target.segmentId }]);
  const textarea = basic.hostEl.find("lacan-translation-inline-input");
  assert.strictEqual(textarea.value, basic.snapshot.markdown, "editing starts from Markdown, including emphasis and footnote syntax");
  assert.strictEqual(basic.original.style.display, "none");
  assert.strictEqual(basic.note.style.display, "", "navigation outside the editable block stays visible");
  assert.ok(basic.controller.isActiveWithin(basic.hostEl));
  assert.strictEqual(basic.doc.activeElement, textarea);
  textarea.value = "新的**完整译文**。\n\n第二段。";
  textarea.dispatch("blur");
  assert.strictEqual(basic.writes.length, 0, "blur must not save or discard text");
  textarea.dispatch("keydown", { key: "Enter", ctrlKey: true, isComposing: true });
  await flush();
  assert.strictEqual(basic.writes.length, 0, "IME confirmation must not save");
  textarea.dispatch("keydown", { key: "Enter", metaKey: true });
  await flush();
  assert.strictEqual(basic.writes.length, 0, "Command+Enter must not save; the save shortcut is Ctrl+Enter on every platform");
  assert.ok(basic.hostEl.find("lacan-translation-inline-hint").textContent.startsWith("Ctrl + Enter 保存"));
  textarea.dispatch("keydown", { key: "Enter", ctrlKey: true });
  await flush();
  assert.deepStrictEqual(basic.writes, [{ snapshot: basic.snapshot, markdown: "新的**完整译文**。\n\n第二段。" }]);
  assert.deepStrictEqual(basic.saved, [{ sourcePath: basic.target.sourcePath, segmentId: basic.target.segmentId }]);
  assert.strictEqual(basic.original.style.display, "block");
  assert.ok(!basic.controller.isActiveWithin(basic.hostEl));
  assert.ok(!basic.hostEl.find("lacan-translation-inline-editor"));

  const cancel = setup();
  await cancel.controller.open(cancel.target);
  cancel.hostEl.find("lacan-translation-inline-input").value = "放弃修改";
  cancel.hostEl.find("lacan-translation-inline-input").dispatch("keydown", { key: "Escape" });
  assert.strictEqual(cancel.controller.active, null);
  assert.strictEqual(cancel.writes.length, 0);
  assert.strictEqual(cancel.original.style.display, "block");

  const fullContent = setup();
  const existingAnnotation = fullContent.hostEl.appendChild(fullContent.doc.createElement("blockquote"));
  existingAnnotation.textContent = "[注] 原有注释";
  const existingCommentary = fullContent.hostEl.appendChild(fullContent.doc.createElement("blockquote"));
  existingCommentary.textContent = "原有建言";
  fullContent.snapshot.markdown += "\n\n> [注] 原有注释\n\n> <!-- 建言 -->\n> 原有建言";
  await fullContent.controller.open({ ...fullContent.target, renderedEls: [fullContent.original, existingAnnotation, existingCommentary] });
  const fullInput = fullContent.hostEl.find("lacan-translation-inline-input");
  assert.strictEqual(fullInput.value, fullContent.snapshot.markdown, "the editor loads the complete body, annotation and commentary Markdown unchanged");
  assert.strictEqual(existingAnnotation.style.display, "none");
  assert.strictEqual(existingCommentary.style.display, "none", "rendered notes are replaced by the same inline editor as the prose");
  const replacementContent = "修改正文。\n\n> [注] 新的注释\n\n> <!-- 建言 -->\n> 新的建言";
  fullInput.value = replacementContent;
  fullContent.hostEl.find("lacan-translation-inline-save").dispatch("click");
  await flush();
  assert.deepStrictEqual(fullContent.writes, [{ snapshot: fullContent.snapshot, markdown: replacementContent }]);
  assert.strictEqual(existingAnnotation.style.display, "");
  assert.strictEqual(existingCommentary.style.display, "");

  const closedTargets = [];
  const onClose = setup({ onClosed: async (target) => { closedTargets.push(target); throw new Error("延迟刷新失败"); } });
  await onClose.controller.open(onClose.target);
  assert.strictEqual(onClose.controller.close(), true);
  await flush();
  assert.deepStrictEqual(closedTargets, [{ sourcePath: onClose.target.sourcePath, segmentId: onClose.target.segmentId }]);
  assert.strictEqual(onClose.controller.active, null);
  assert.strictEqual(onClose.original.style.display, "block");
  assert.ok(onClose.notices.some((message) => message.includes("延迟刷新失败")), "close callback failures are handled without losing restored content");

  const readFailure = setup({ readSegment: async () => { throw new Error("段落不存在"); } });
  assert.strictEqual(await readFailure.controller.open(readFailure.target), false);
  assert.strictEqual(readFailure.controller.active, null);
  assert.ok(readFailure.notices.some((message) => message.includes("段落不存在")));

  const conflict = setup({ saveSegment: async () => { throw new Error("译文已被其他窗口修改"); } });
  await conflict.controller.open(conflict.target);
  const conflictInput = conflict.hostEl.find("lacan-translation-inline-input");
  conflictInput.value = "保留未保存的修改";
  conflict.hostEl.find("lacan-translation-inline-save").dispatch("click");
  await flush();
  assert.strictEqual(conflictInput.value, "保留未保存的修改");
  assert.ok(conflict.controller.active);
  assert.ok(conflict.hostEl.find("lacan-translation-inline-error").textContent.includes("其他窗口"));
  assert.strictEqual(conflictInput.disabled, false);

  const secondHost = conflict.doc.body.appendChild(conflict.doc.createElement("section"));
  const secondParagraph = secondHost.appendChild(conflict.doc.createElement("p"));
  assert.strictEqual(await conflict.controller.open({ ...conflict.target, segmentId: "s8-01-0003", hostEl: secondHost, renderedEls: [secondParagraph] }), false);
  assert.strictEqual(conflict.reads.length, 1, "opening another paragraph must preserve a dirty editor");
  assert.strictEqual(conflict.doc.activeElement, conflictInput);
  assert.ok(conflict.notices.some((message) => message.includes("保存")));
  conflict.controller.destroy();
  assert.strictEqual(conflict.controller.active, null);
  assert.strictEqual(await conflict.controller.open(conflict.target), false, "destroyed controllers cannot reopen");

  const gate = deferred();
  let writes = 0;
  const saving = setup({ saveSegment: async () => { writes += 1; await gate.promise; } });
  await saving.controller.open(saving.target);
  const saveButton = saving.hostEl.find("lacan-translation-inline-save");
  saveButton.dispatch("click");
  saveButton.dispatch("click");
  saving.hostEl.find("lacan-translation-inline-cancel").dispatch("click");
  assert.strictEqual(writes, 1, "repeated saves must not race");
  assert.ok(saving.controller.active, "a pending save cannot be cancelled");
  gate.resolve();
  await flush();
  assert.strictEqual(saving.controller.active, null);

  const readGate = deferred();
  const detached = setup({ readSegment: async () => readGate.promise });
  const pending = detached.controller.open(detached.target);
  detached.hostEl.remove();
  readGate.resolve(detached.snapshot);
  assert.strictEqual(await pending, false, "a slow read must not mount an editor after its page is gone");
  assert.strictEqual(detached.controller.active, null);

  const afterSaveFailure = setup({ onSaved: async () => { throw new Error("预览刷新失败"); } });
  await afterSaveFailure.controller.open(afterSaveFailure.target);
  afterSaveFailure.hostEl.find("lacan-translation-inline-save").dispatch("click");
  await flush();
  assert.strictEqual(afterSaveFailure.writes.length, 1);
  assert.strictEqual(afterSaveFailure.controller.active, null);
  assert.ok(afterSaveFailure.notices.some((message) => message.includes("已保存")));

  const remount = setup();
  await remount.controller.open(remount.target);
  const remountInput = remount.hostEl.find("lacan-translation-inline-input");
  remountInput.value = "原生预览重新渲染后仍保留的草稿";
  remount.hostEl.remove();
  const replacementHost = remount.doc.body.appendChild(remount.doc.createElement("section"));
  const replacementParagraph = replacementHost.appendChild(remount.doc.createElement("p"));
  assert.strictEqual(await remount.controller.open({ ...remount.target, segmentId: "s8-01-0001", hostEl: replacementHost, renderedEls: [replacementParagraph] }), true);
  assert.strictEqual(remount.reads.length, 1, "a covered ID reattaches the same grouped paragraph without replacing its snapshot");
  assert.strictEqual(replacementHost.find("lacan-translation-inline-input"), remountInput);
  assert.strictEqual(remountInput.value, "原生预览重新渲染后仍保留的草稿");
  assert.strictEqual(replacementParagraph.style.display, "none");
  assert.strictEqual(remount.original.style.display, "block");
  remount.controller.close();
  assert.strictEqual(replacementParagraph.style.display, "");

  const imageWrites = [];
  const pasteGate = deferred();
  const pasted = setup({ saveImage: async (file, sourcePath) => {
    imageWrites.push({ file, sourcePath });
    await pasteGate.promise;
    return `![[${file.name}]]`;
  } });
  await pasted.controller.open(pasted.target);
  const pasteInput = pasted.controller.active.input;
  pasteInput.value = "前文待替换后文";
  pasteInput.setSelectionRange(2, 5);
  const image = { name: "截图.png", type: "image/png" };
  let pastePrevented = false;
  let pasteStopped = false;
  pasteInput.dispatch("paste", {
    clipboardData: { items: [{ kind: "file", type: image.type, getAsFile: () => image }] },
    preventDefault() { pastePrevented = true; }, stopPropagation() { pasteStopped = true; },
  });
  assert.strictEqual(pastePrevented, true, "clipboard images must be handled instead of silently ignored by the textarea");
  assert.strictEqual(pasteStopped, true, "the reading view must not handle the same image paste again");
  assert.strictEqual(pasteInput.readOnly, true, "keep the insertion selection stable during attachment writes");
  assert.strictEqual(await pasted.controller.save(), false, "saving must not omit an in-flight attachment");
  assert.strictEqual(pasted.controller.close(), false, "pending image writes keep their target editor");
  assert.strictEqual(await pasted.controller.open({ ...pasted.target, segmentId: "s8-01-0003" }), false);
  assert.strictEqual(pasted.writes.length, 0);
  pasteGate.resolve();
  await flush();
  assert.deepStrictEqual(imageWrites, [{ file: image, sourcePath: pasted.target.sourcePath }]);
  assert.strictEqual(pasteInput.value, "前文![[截图.png]]后文", "the embed replaces only the original selection");
  assert.strictEqual(pasteInput.selectionStart, "前文![[截图.png]]".length);
  assert.strictEqual(pasteInput.readOnly, false);
  assert.strictEqual(pasted.controller.active.saveButton.disabled, false);
  assert.ok(pasted.hostEl.find("lacan-translation-inline-hint").textContent.includes("粘贴图片"));
  await pasted.controller.save();
  assert.strictEqual(pasted.writes[0].markdown, "前文![[截图.png]]后文");

  const textPaste = setup({ saveImage: async () => { throw new Error("text is not an image"); } });
  await textPaste.controller.open(textPaste.target);
  textPaste.controller.active.input.dispatch("paste", {
    clipboardData: { items: [{ kind: "string", type: "text/plain" }] },
    preventDefault() { assert.fail("plain text paste retains native textarea behavior"); },
  });
  assert.strictEqual(textPaste.controller.active.input.readOnly, false);

  const pastedFiles = [];
  const multi = setup({ saveImage: async (file) => { pastedFiles.push(file.name); return `![[${file.name}]]`; } });
  await multi.controller.open(multi.target);
  multi.controller.active.input.value = "";
  multi.controller.active.input.dispatch("paste", {
    clipboardData: { files: [image, { name: "two.jpg", type: "image/jpeg" }, { name: "data.txt", type: "text/plain" }] },
  });
  await flush();
  assert.deepStrictEqual(pastedFiles, ["截图.png", "two.jpg"]);
  assert.strictEqual(multi.controller.active.input.value, "![[截图.png]]\n![[two.jpg]]");

  const pasteFailure = setup({ saveImage: async () => { throw new Error("附件目录不可写"); } });
  await pasteFailure.controller.open(pasteFailure.target);
  const failureInput = pasteFailure.controller.active.input;
  failureInput.value = "保留草稿";
  failureInput.dispatch("paste", { clipboardData: { files: [image] } });
  await flush();
  assert.strictEqual(failureInput.value, "保留草稿");
  assert.ok(pasteFailure.controller.active.errorEl.textContent.includes("附件目录不可写"));
  assert.strictEqual(failureInput.readOnly, false);
  assert.strictEqual(pasteFailure.controller.active.cancelButton.disabled, false);

  let attempts = 0;
  const partial = setup({ saveImage: async () => {
    if (++attempts === 2) throw new Error("第二张失败");
    return "![[first.png]]";
  } });
  await partial.controller.open(partial.target);
  partial.controller.active.input.value = "原文";
  partial.controller.active.input.setSelectionRange(2, 2);
  partial.controller.active.input.dispatch("paste", { clipboardData: { files: [image, image] } });
  await flush();
  assert.strictEqual(partial.controller.active.input.value, "原文![[first.png]]", "successful embeds survive a later image failure");
  assert.ok(partial.controller.active.errorEl.textContent.includes("第二张失败"));

  const destroyGate = deferred();
  const destroyedPaste = setup({ saveImage: async () => { await destroyGate.promise; return "![[late.png]]"; } });
  await destroyedPaste.controller.open(destroyedPaste.target);
  const oldInput = destroyedPaste.controller.active.input;
  oldInput.dispatch("paste", { clipboardData: { files: [image] } });
  destroyedPaste.controller.destroy();
  destroyGate.resolve();
  await flush();
  assert.strictEqual(destroyedPaste.controller.active, null);
  assert.strictEqual(oldInput.value, destroyedPaste.snapshot.markdown, "a late attachment cannot update a destroyed editor");

  console.log("Translation inline editor tests passed");
}
run().catch((error) => { console.error(error); process.exitCode = 1; });
