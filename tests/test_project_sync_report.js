const assert = require("assert");
const Module = require("module");

class Element {
  constructor(tag = "div", options = {}) {
    this.tag = tag;
    this.textContent = options.text || "";
    this.className = typeof options === "string" ? options : options.cls || "";
    this.children = [];
    this.listeners = {};
    this.classList = { add: (value) => { this.className += ` ${value}`; } };
  }
  empty() { this.children = []; }
  setText(value) { this.textContent = value; }
  createEl(tag, options = {}) { const el = new Element(tag, options); this.children.push(el); return el; }
  createDiv(options = {}) { return this.createEl("div", options); }
  addEventListener(name, callback) { this.listeners[name] = callback; }
  find(predicate) { if (predicate(this)) return this; for (const child of this.children) { const found = child.find(predicate); if (found) return found; } return null; }
  all(predicate) { return [...(predicate(this) ? [this] : []), ...this.children.flatMap((child) => child.all(predicate))]; }

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

async function run() {
  const path = "texts/s14/translation/test.md";
  const opened = [];
  const app = {
    vault: { getAbstractFileByPath: (name) => name === path ? { path } : null },
    workspace: { openLinkText: async (...args) => { opened.push(args); } },
  };
  const modal = new ProjectSyncReportModal(app, {
    version: "v1", conflicts: [{ path, kind: "local_deleted", incomingPath: "private-copy" }],
  }, {
    checkedVersion: "v2",
    skippedFiles: [{ path: "texts/s14/original/test.md", reason: "paired_file_modified", triggerPath: path }],
  });
  modal.open();
  const hasText = (text) => Boolean(modal.contentEl.find((el) => el.textContent === text));
  assert.ok(hasText("最近检查版本：v2"));
  assert.ok(hasText("本次跳过的文件"));
  assert.ok(hasText(`触发跳过的文件：${path}`));
  assert.ok(hasText("旧版冲突记录（1）"));
  assert.ok(hasText("原记录类型：local_deleted"));
  assert.strictEqual(modal.contentEl.all((el) => el.tag === "textarea").length, 0);
  const buttons = modal.contentEl.all((el) => el.tag === "button");
  assert.deepStrictEqual(buttons.map((el) => el.textContent), ["打开本地文件"]);
  buttons[0].listeners.click();
  assert.deepStrictEqual(opened, [[path, "", true]]);

  const empty = new ProjectSyncReportModal(app, { version: "v1", conflicts: [] });
  empty.open();
  assert.ok(empty.contentEl.find((el) => el.textContent === "本次没有跳过文件。"));
  assert.strictEqual(empty.contentEl.all((el) => el.tag === "button").length, 0);
  console.log("Project sync read-only report tests passed");
}
run().catch((error) => { console.error(error); process.exitCode = 1; });
