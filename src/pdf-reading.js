const { FuzzySuggestModal, Notice, TFile } = require("obsidian");

function isPdfFile(file) {
  return file instanceof TFile && file.extension?.toLowerCase() === "pdf";
}

async function openPdfReading(plugin, file, { newLeaf = false } = {}) {
  if (!isPdfFile(file)) {
    throw new Error("请选择当前仓库中的 PDF 文件。");
  }
  const workspace = plugin.app.workspace;
  const existingLeaf = !newLeaf && workspace.getLeavesOfType("pdf")
    .find((leaf) => (leaf.view?.file?.path || leaf.getViewState?.().state?.file) === file.path);
  if (existingLeaf) {
    // Revealing alone preserves the reader's current page, zoom and selection.
    await workspace.revealLeaf(existingLeaf);
    return existingLeaf;
  }
  const leaf = workspace.getLeaf("tab");
  await leaf.openFile(file, { active: true });
  await workspace.revealLeaf(leaf);
  return leaf;
}

class PdfReadingModal extends (FuzzySuggestModal || class {}) {
  constructor(plugin, files) {
    super(plugin.app);
    this.plugin = plugin;
    this.files = files;
    this.setPlaceholder("搜索 PDF 文件名或路径…");
  }

  getItems() {
    return this.files;
  }

  getItemText(file) {
    return file.path;
  }

  renderSuggestion(match, element) {
    element.createDiv({ cls: "suggestion-title", text: match.item.name });
    element.createDiv({ cls: "suggestion-note", text: match.item.path });
  }

  async onChooseItem(file) {
    return this.plugin.runWithNotice(
      () => openPdfReading(this.plugin, file),
      "PDF 打开失败"
    );
  }
}

function registerPdfReading(plugin) {
  const openPicker = () => {
    const files = plugin.app.vault.getFiles().filter(isPdfFile)
      .sort((left, right) => left.path.localeCompare(right.path, "zh-CN", { numeric: true }));
    if (!files.length) {
      new Notice("当前仓库没有 PDF 文件。请先将 PDF 拖入 Obsidian 文件列表，再打开 PDF 阅读。");
      return;
    }
    const modal = new PdfReadingModal(plugin, files);
    modal.open();
    return modal;
  };
  plugin.addCommand({ id: "open-pdf-reading", name: "打开 PDF 阅读", callback: openPicker });
  plugin.addRibbonIcon?.("book-open-text", "打开 PDF 阅读", openPicker);
}

function addPdfFileMenuItems(plugin, menu, file) {
  if (!isPdfFile(file)) return false;
  menu.addItem((item) => item
    .setTitle("PDF 阅读（新标签页）")
    .setIcon("book-open-text")
    .onClick(() => plugin.runWithNotice(
      () => openPdfReading(plugin, file, { newLeaf: true }),
      "PDF 打开失败"
    )));
  return true;
}

module.exports = { registerPdfReading, addPdfFileMenuItems, openPdfReading };
