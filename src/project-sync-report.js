const Obsidian = require("obsidian");
const Modal = Obsidian.Modal || class {};
const { skipReasonText } = require("./project-sync-status");

class ProjectSyncReportModal extends Modal {
  constructor(app, report, { skippedFiles = [], checkedVersion } = {}) {
    super(app);
    this.report = report;
    this.skippedFiles = skippedFiles;
    this.checkedVersion = checkedVersion;
  }

  onOpen() {
    this.modalEl?.classList.add("lacan-sync-report-modal");
    this.titleEl.setText("文库同步记录");
    const root = this.contentEl;
    root.empty();
    root.createEl("p", { text: `最近检查版本：${this.checkedVersion || this.report.version || "未知"}`, cls: "lacan-sync-muted" });
    root.createEl("p", { text: "检测到本地修改时整课跳过，不自动合并或覆盖。删除本地文件后再次同步，会重新下载。", cls: "lacan-sync-help" });
    if (this.skippedFiles.length) {
      root.createEl("h3", { text: "本次跳过的文件" });
      const list = root.createDiv("lacan-sync-conflict-list");
      for (const entry of this.skippedFiles) {
        const row = list.createDiv("lacan-sync-conflict");
        row.createEl("code", { text: entry.path });
        row.createEl("p", { text: skipReasonText(entry) });
        if (entry.triggerPath && entry.triggerPath !== entry.path) row.createEl("p", { text: `触发跳过的文件：${entry.triggerPath}`, cls: "lacan-sync-muted" });
        this.addLocalButton(row.createDiv("lacan-sync-actions"), entry.path);
      }
      root.createEl("p", { text: "如需重新同步，请先保留修改副本，再删除有改动的本地文件后同步。" });
    } else root.createEl("p", { text: "本次没有跳过文件。" });
    const conflicts = this.report.conflicts || [];
    if (conflicts.length) {
      const history = root.createEl("details");
      history.createEl("summary", { text: `旧版冲突记录（${conflicts.length}）` });
      history.createEl("p", { text: "以下记录来自旧同步策略，继续保留供核对。本页只读，不执行合并、删除或覆盖。" });
      for (const conflict of conflicts) {
        const row = history.createDiv("lacan-sync-conflict");
        row.createEl("code", { text: conflict.path });
        row.createEl("p", { text: `原记录类型：${conflict.kind}`, cls: "lacan-sync-muted" });
        this.addLocalButton(row.createDiv("lacan-sync-actions"), conflict.path);
      }
    }
  }

  addLocalButton(root, path) {
    if (!this.app.vault.getAbstractFileByPath(path)) return;
    const local = root.createEl("button", { text: "打开本地文件" });
    local.addEventListener("click", () => {
      void this.app.workspace.openLinkText(path, "", true).catch((error) => new Obsidian.Notice(error.message));
    });
  }
}

module.exports = { ProjectSyncReportModal };
