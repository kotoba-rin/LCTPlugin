const assert = require("assert");
const Module = require("module");

class Element {
  constructor(tag = "div", options = {}) {
    this.tag = tag;
    this.textContent = options.text || "";
    this.className = typeof options === "string" ? options : options.cls || "";
    this.children = [];
    this.listeners = {};
    this.attributes = options.attr || {};
    this.value = "";
    this.disabled = false;
    this.classList = { add: (value) => { this.className += ` ${value}`; } };
  }
  empty() { this.children = []; }
  setText(value) { this.textContent = value; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  createEl(tag, options = {}) { const el = new Element(tag, options); this.children.push(el); return el; }
  createDiv(options = {}) { return this.createEl("div", options); }
  addEventListener(name, callback) { this.listeners[name] = callback; }
  focus() { this.focused = true; }
  find(predicate) { if (predicate(this)) return this; for (const child of this.children) { const found = child.find(predicate); if (found) return found; } return null; }
  all(predicate) { return [...(predicate(this) ? [this] : []), ...this.children.flatMap((child) => child.all(predicate))]; }
  async fire(name) { if (this.disabled) return; await this.listeners[name]?.({ target: this }); await new Promise((resolve) => setImmediate(resolve)); }
}

const notices = [];
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "obsidian") return {
    Modal: class {
      constructor(app) { this.app = app; this.contentEl = new Element(); this.titleEl = new Element(); this.modalEl = new Element(); }
      open() { this.onOpen(); }
    },
    Notice: class { constructor(message) { notices.push(message); } },
  };
  return originalLoad(request, parent, isMain);
};
let ProjectSyncReportModal;
try { ({ ProjectSyncReportModal } = require("../src/project-sync-report")); }
finally { Module._load = originalLoad; }

const button = (modal, label) => modal.contentEl.find((el) => el.tag === "button" && el.textContent === label);
const area = (modal, label) => modal.contentEl.find((el) => el.tag === "textarea" && el.attributes["aria-label"] === label);
const fixture = () => ({
  path: "texts/s14/translation/test.md", kind: "text_conflict", baseText: "开头\n原句\n旧尾\n",
  localText: "开头\n本地句\n旧尾\n", upstreamText: "开头\n上游句\n新尾\n",
  localHash: "local-snapshot", upstreamHash: "upstream-snapshot", baseHash: "base",
  mergeable: true, canResolveText: true, eol: "\n", missingBase: false,
  blocks: [{ ok: ["开头\n"] }, { conflict: { a: ["本地句\n"], o: ["原句\n"], b: ["上游句\n"], oIndex: 1 } }, { ok: ["新尾\n"] }],
});

async function run() {
  let comparison = fixture();
  let shouldFail = true;
  const saves = [];
  let refreshed = 0;
  const engine = {
    getConflictComparison: async () => comparison,
    resolveConflict: async (path, resolution) => {
      saves.push({ path, ...resolution });
      if (shouldFail) throw new Error("本地文件已改变，请重新比较后解决。");
      return { version: "test-v2", conflicts: [] };
    },
  };
  const app = { vault: { getAbstractFileByPath: () => ({}) }, workspace: { openLinkText: async () => {} } };
  const report = { version: "test-v2", conflicts: [{ path: comparison.path, kind: comparison.kind }] };
  const modal = new ProjectSyncReportModal(app, { read: async () => null }, report, { engine, onResolved: async () => { refreshed += 1; } });
  modal.open();
  const compare = button(modal, "比较与解决冲突");
  assert.ok(compare, "a report must offer the actual conflict comparison workflow");
  await compare.fire("click");
  assert.strictEqual(area(modal, "本地完整内容（只读）").value, comparison.localText);
  assert.strictEqual(area(modal, "上游完整内容（只读）").value, comparison.upstreamText);
  assert.strictEqual(area(modal, "基线完整内容（只读）").value, comparison.baseText);
  assert.strictEqual(button(modal, "确认保存合并结果").disabled, false, "conflicts default to local and are ready for explicit confirmation");
  assert.strictEqual(button(modal, "保留本地这一处").attributes["aria-pressed"], "true");
  assert.strictEqual(area(modal, "合并结果").value, "开头\n本地句\n新尾\n", "default local choices still include clean upstream edits");
  assert.strictEqual(saves.length, 0, "opening a comparison never changes a working file");
  await button(modal, "保留本地这一处").fire("click");
  assert.strictEqual(area(modal, "合并结果").value, "开头\n本地句\n新尾\n", "clean upstream changes remain when a conflicting hunk keeps local text");
  const result = area(modal, "合并结果");
  result.value = "开头\n人工整合 <img src=x onerror=alert(1)>\n新尾\n";
  await result.fire("input");
  assert.strictEqual(button(modal, "采用上游这一处").disabled, true, "hunk choices cannot replace a manually edited full result");
  await button(modal, "确认保存合并结果").fire("click");
  assert.deepStrictEqual(saves[0], {
    path: comparison.path, expectedLocalHash: "local-snapshot", expectedUpstreamHash: "upstream-snapshot", content: result.value,
  }, "saving uses the exact comparison snapshot and full edited result");
  assert.strictEqual(area(modal, "合并结果").value, result.value, "a stale-file failure retains the user's draft");
  assert.ok(modal.contentEl.find((el) => el.textContent.includes("本地文件已改变")));
  assert.strictEqual(refreshed, 0);
  assert.strictEqual(modal.contentEl.find((el) => el.tag === "img"), null, "content is rendered as plain text, never HTML");
  shouldFail = false;
  await button(modal, "确认保存合并结果").fire("click");
  assert.strictEqual(refreshed, 1);
  assert.strictEqual(report.conflicts.length, 0);
  assert.ok(modal.contentEl.find((el) => el.textContent === "本次没有冲突。"));

  comparison = { ...fixture(), blocks: [
    { conflict: { a: ["第一处本地\n"], o: ["第一处基线\n"], b: ["第一处上游\n"], segmentIds: ["s14-12-0019", "s14-12-0020"] } },
    { ok: ["中间无冲突\n"] },
    { conflict: { a: ["第二处本地\n"], o: ["第二处基线\n"], b: ["第二处上游\n"], segmentIds: ["s14-12-0021"] } },
  ] };
  const paged = new ProjectSyncReportModal(app, {}, { version: "v2", conflicts: [{ path: comparison.path }] }, { engine });
  paged.open();
  await button(paged, "比较与解决冲突").fire("click");
  assert.strictEqual(paged.contentEl.all((el) => el.className.includes("lacan-sync-hunk")).filter((el) => el.className === "lacan-sync-hunk").length, 1, "only one minimal conflict unit is presented at a time");
  assert.strictEqual(area(paged, "冲突 1 本地（只读）").value, "第一处本地\n");
  assert.strictEqual(area(paged, "冲突 2 本地（只读）"), null);
  assert.ok(paged.contentEl.find((el) => el.textContent.includes("s14-12-0019") && el.textContent.includes("s14-12-0020")), "merged ids label the indivisible conflict unit");
  await button(paged, "采用上游这一处").fire("click");
  await button(paged, "下一处冲突").fire("click");
  assert.strictEqual(area(paged, "冲突 2 本地（只读）").value, "第二处本地\n");
  assert.strictEqual(button(paged, "保留本地这一处").attributes["aria-pressed"], "true");
  assert.strictEqual(area(paged, "合并结果").value, "第一处上游\n中间无冲突\n第二处本地\n", "navigation preserves each choice and defaults the other conflicts to local");
  await button(paged, "上一处冲突").fire("click");
  assert.strictEqual(button(paged, "采用上游这一处").attributes["aria-pressed"], "true");

  comparison = { ...fixture(), clean: true, blocks: [{ ok: ["自动合并结果\n"] }] };
  const clean = new ProjectSyncReportModal(app, {}, { version: "v2", conflicts: [{ path: comparison.path }] }, { engine });
  clean.open();
  await button(clean, "比较与解决冲突").fire("click");
  assert.strictEqual(button(clean, "保留本地这一处"), null, "a clean comparison must not invent a whole-file conflict");
  assert.strictEqual(area(clean, "合并结果").value, "自动合并结果\n");

  comparison = { ...fixture(), baseText: null, localText: null, localHash: null, missingBase: true,
    blocks: [{ conflict: { a: [], o: [], b: ["新版\n"] } }] };
  const deletion = new ProjectSyncReportModal(app, {}, { version: "v3", conflicts: [{ path: comparison.path }] }, { engine });
  deletion.open();
  await button(deletion, "比较与解决冲突").fire("click");
  assert.ok(deletion.contentEl.find((el) => el.textContent.includes("缺少可信基线")));
  assert.strictEqual(button(deletion, "保留本地删除").attributes["aria-pressed"], "true", "the default also preserves a local deletion");
  await button(deletion, "确认保留删除").fire("click");
  assert.strictEqual(saves.at(-1).content, null, "a deleted file is distinct from an empty text file");

  comparison = { ...fixture(), upstreamText: null, upstreamHash: null, blocks: [
    { conflict: { a: ["第一段\n"], o: ["第一段\n"], b: [], segmentIds: ["s14-12-0001"] } },
    { conflict: { a: ["第二段\n"], o: ["第二段\n"], b: [], segmentIds: ["s14-12-0002"] } },
  ] };
  const segmentedDeletion = new ProjectSyncReportModal(app, {}, { version: "v3", conflicts: [{ path: comparison.path }] }, { engine });
  segmentedDeletion.open();
  await button(segmentedDeletion, "比较与解决冲突").fire("click");
  assert.strictEqual(area(segmentedDeletion, "合并结果").value, comparison.localText, "file-level local choice preserves the complete local file while paging segments");
  await button(segmentedDeletion, "下一处冲突").fire("click");
  await button(segmentedDeletion, "采用上游删除").fire("click");
  await button(segmentedDeletion, "上一处冲突").fire("click");
  assert.strictEqual(button(segmentedDeletion, "采用上游删除").attributes["aria-pressed"], "true", "the file deletion choice is consistent across all preview segments");
  await button(segmentedDeletion, "确认保留删除").fire("click");
  assert.strictEqual(saves.at(-1).content, null);

  comparison = { ...fixture(), baseText: null, localText: null, localHash: null, upstreamText: "", missingBase: true,
    blocks: [{ conflict: { a: [], o: [], b: [], label: "文件删除" } }] };
  const emptyDeletion = new ProjectSyncReportModal(app, {}, { version: "v3", conflicts: [{ path: comparison.path }] }, { engine });
  emptyDeletion.open();
  await button(emptyDeletion, "比较与解决冲突").fire("click");
  await button(emptyDeletion, "采用上游文件").fire("click");
  await button(emptyDeletion, "确认保存合并结果").fire("click");
  assert.strictEqual(saves.at(-1).content, "", "choosing an empty file must not preserve a deletion");

  comparison = { ...fixture(), path: "assets/example.pdf", canResolveText: false, mergeable: false, baseText: null, localText: null, upstreamText: null, blocks: [] };
  const binary = new ProjectSyncReportModal(app, {}, { version: "v4", conflicts: [{ path: comparison.path }] }, { engine });
  binary.open();
  await button(binary, "比较与解决冲突").fire("click");
  assert.ok(binary.contentEl.find((el) => el.textContent.includes("无法进行文本合并")));
  assert.strictEqual(button(binary, "确认保存合并结果"), null, "binary data must never be saved as decoded text");

  let finishRead;
  const closing = new ProjectSyncReportModal(app, {}, { version: "v5", conflicts: [{ path: fixture().path }] }, {
    engine: { getConflictComparison: () => new Promise((resolve) => { finishRead = resolve; }) },
  });
  closing.open();
  await button(closing, "比较与解决冲突").fire("click");
  closing.onClose();
  closing.contentEl.empty();
  finishRead(fixture());
  await new Promise((resolve) => setImmediate(resolve));
  assert.strictEqual(closing.contentEl.children.length, 0, "late comparison reads do not write into a closed modal");
  const readonly = new ProjectSyncReportModal(app, { read: () => assert.fail("history rendering must not read or apply upstream copies") }, {
    version: "v6", conflicts: [{ path: fixture().path, kind: "local_deleted" }],
  }, {
    readOnly: true,
    skippedFiles: [{ path: fixture().path, reason: "local_modified" }],
    engine: { getConflictComparison: () => assert.fail("read-only history cannot start a comparison"), resolveConflict: () => assert.fail("read-only history cannot save") },
  });
  readonly.open();
  assert.ok(readonly.contentEl.find((el) => el.textContent === "本次跳过的文件"));
  assert.ok(readonly.contentEl.find((el) => el.textContent === "旧版冲突记录（1）"));
  assert.strictEqual(button(readonly, "比较与解决冲突"), null);
  assert.strictEqual(button(readonly, "确认保存合并结果"), null);
  assert.strictEqual(readonly.contentEl.all((el) => el.tag === "textarea").length, 0);
  console.log("Project sync conflict comparison UI tests passed");
}
run().catch((error) => { console.error(error); process.exitCode = 1; });
