const assert = require("assert");
const Module = require("module");

const notices = [];
const modals = [];
class MockTFile {
  constructor(path) {
    this.path = path;
    this.name = path.split("/").pop();
    this.extension = this.name.split(".").pop();
  }
}
class MockFuzzySuggestModal {
  constructor(app) { this.app = app; modals.push(this); }
  setPlaceholder(text) { this.placeholder = text; return this; }
  open() { this.opened = true; }
}
const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === "obsidian") {
    return {
      TFile: MockTFile,
      FuzzySuggestModal: MockFuzzySuggestModal,
      Notice: class { constructor(text) { notices.push(text); } },
    };
  }
  return originalLoad(request, parent, isMain);
};
let registerPdfReading;
let addPdfFileMenuItems;
let openPdfReading;
try {
  ({ registerPdfReading, addPdfFileMenuItems, openPdfReading } = require("../src/pdf-reading"));
} finally {
  Module._load = originalLoad;
}

function setup(files = []) {
  const commands = new Map();
  const ribbon = [];
  const reveals = [];
  const opened = [];
  const leaves = [];
  const leafRequests = [];
  const newLeaf = {
    async openFile(file, options) { opened.push({ file, options }); },
  };
  const plugin = {
    app: {
      vault: { getFiles: () => files },
      workspace: {
        getLeavesOfType(type) { assert.strictEqual(type, "pdf"); return leaves; },
        getLeaf(type) { leafRequests.push(type); return newLeaf; },
        async revealLeaf(leaf) { reveals.push(leaf); },
      },
    },
    addCommand(command) { commands.set(command.id, command); },
    addRibbonIcon(...args) { ribbon.push(args); },
    async runWithNotice(action) { return action(); },
  };
  return { plugin, commands, ribbon, reveals, opened, leaves, leafRequests, newLeaf };
}

async function run() {
  const primary = new MockTFile("sources/书籍.pdf");
  const duplicate = new MockTFile("archive/书籍.pdf");
  const upperCase = new MockTFile("sources/French.PDF");
  const markdown = new MockTFile("sources/reading.md");
  const state = setup([primary, duplicate, upperCase, markdown]);
  registerPdfReading(state.plugin);
  assert.ok(state.commands.has("open-pdf-reading"));
  assert.strictEqual(state.ribbon.length, 1);
  assert.strictEqual(state.ribbon[0][1], "打开 PDF 阅读");
  state.ribbon[0][2]();
  assert.ok(modals.at(-1).opened, "the ribbon opens the same searchable PDF picker");
  state.commands.get("open-pdf-reading").callback();
  const modal = modals.at(-1);
  assert.ok(modal.opened, "the command opens the PDF picker");
  assert.match(modal.placeholder, /PDF/);
  assert.deepStrictEqual(new Set(modal.getItems()), new Set([primary, duplicate, upperCase]), "only PDFs, including uppercase extensions, enter the picker");
  assert.ok(modal.getItemText(primary).includes("sources/书籍.pdf"), "fuzzy matching includes directory and file name");
  const rendered = [];
  modal.renderSuggestion({ item: primary }, { createDiv(options) { rendered.push(options.text); } });
  assert.deepStrictEqual(rendered, [primary.name, primary.path], "same-name files can be distinguished by their paths");
  await modal.onChooseItem(primary);
  assert.deepStrictEqual(state.leafRequests, ["tab"], "choosing a new PDF preserves the current Markdown pane");
  assert.strictEqual(state.opened[0].file, primary);
  assert.strictEqual(state.reveals[0], state.newLeaf);

  state.opened.length = 0;
  state.leafRequests.length = 0;
  const existing = {
    view: { file: primary, page: 17, zoom: 1.5 },
    openFile() { assert.fail("reopening the existing reader would reset page and zoom"); },
  };
  state.leaves.push(existing);
  assert.strictEqual(await openPdfReading(state.plugin, primary), existing);
  assert.strictEqual(state.reveals.at(-1), existing);
  assert.deepStrictEqual(state.leafRequests, []);
  assert.deepStrictEqual(state.opened, []);
  assert.strictEqual(existing.view.page, 17);
  assert.strictEqual(existing.view.zoom, 1.5);

  const deferred = { view: {}, getViewState: () => ({ type: "pdf", state: { file: duplicate.path } }) };
  state.leaves.push(deferred);
  assert.strictEqual(await openPdfReading(state.plugin, duplicate), deferred, "a deferred native PDF tab is reused through its saved file state");
  assert.strictEqual(state.reveals.at(-1), deferred);
  assert.deepStrictEqual(state.leafRequests, []);

  assert.strictEqual(await openPdfReading(state.plugin, primary, { newLeaf: true }), state.newLeaf);
  assert.deepStrictEqual(state.leafRequests, ["tab"], "an explicit new-tab action does not reuse an existing reader");
  assert.strictEqual(state.opened.at(-1).file, primary);
  await openPdfReading(state.plugin, upperCase);
  assert.strictEqual(state.opened.at(-1).file, upperCase);
  await assert.rejects(() => openPdfReading(state.plugin, markdown), /PDF/);
  await assert.rejects(() => openPdfReading(state.plugin, { path: "fake.pdf", extension: "pdf" }), /PDF/);
  await assert.rejects(() => openPdfReading(state.plugin, null), /PDF/);

  const items = [];
  const menu = { addItem(callback) {
    const item = {
      setTitle(title) { this.title = title; return this; },
      setIcon(icon) { this.icon = icon; return this; },
      onClick(callback) { this.click = callback; return this; },
    };
    callback(item); items.push(item);
  } };
  assert.strictEqual(addPdfFileMenuItems(state.plugin, menu, markdown), false);
  assert.strictEqual(addPdfFileMenuItems(state.plugin, menu, { path: "folder.pdf" }), false);
  assert.strictEqual(items.length, 0);
  assert.strictEqual(addPdfFileMenuItems(state.plugin, menu, primary), true);
  assert.strictEqual(items.length, 1);
  assert.match(items[0].title, /PDF.*新标签页|新标签页.*PDF/);
  const requestsBeforeMenuClick = state.leafRequests.length;
  await items[0].click();
  assert.strictEqual(state.leafRequests.length, requestsBeforeMenuClick + 1);

  const empty = setup([markdown]);
  registerPdfReading(empty.plugin);
  const previousModalCount = modals.length;
  empty.commands.get("open-pdf-reading").callback();
  assert.strictEqual(modals.length, previousModalCount, "an empty vault does not show a blank chooser");
  assert.match(notices.at(-1), /PDF/);
  assert.match(notices.at(-1), /拖|加入|导入/);

  const failed = setup([primary]);
  failed.newLeaf.openFile = async () => { throw new Error("reader unavailable"); };
  await assert.rejects(() => openPdfReading(failed.plugin, primary), /reader unavailable/);
  assert.strictEqual(failed.reveals.length, 0, "a failed open does not reveal an empty tab as a successful reader");
  console.log("PDF reading command, picker, menu, and tab reuse tests passed");
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
