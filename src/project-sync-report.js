const Obsidian = require("obsidian");
const Modal = Obsidian.Modal || class {};
const { skipReasonText } = require("./project-sync-status");

class ProjectSyncReportModal extends Modal {
  constructor(app, storage, report, { engine, onResolved, readOnly = false, skippedFiles = [], checkedVersion } = {}) {
    super(app);
    this.storage = storage;
    this.report = report;
    this.engine = engine;
    this.onResolved = onResolved;
    this.readOnly = readOnly;
    this.skippedFiles = skippedFiles;
    this.checkedVersion = checkedVersion;
    this.sessions = new Map();
    this.requestId = 0;
  }

  onOpen() {
    this.isClosed = false;
    this.modalEl?.classList.add("lacan-sync-report-modal");
    this.renderReport();
  }

  onClose() {
    this.isClosed = true;
    this.requestId += 1;
  }

  renderReport() {
    if (this.readOnly) return this.renderReadOnlyReport();
    this.titleEl.setText("文库同步与冲突比较");
    const root = this.contentEl;
    root.empty();
    root.createEl("p", { text: `版本：${this.report.version || "未知"}`, cls: "lacan-sync-muted" });
    root.createEl("p", { text: "冲突默认保留本地修改。可逐段比较并调整选择，确认保存后写入合并结果。", cls: "lacan-sync-help" });
    const conflicts = this.report.conflicts || [];
    if (!conflicts.length) root.createEl("p", { text: "本次没有冲突。" });
    const list = root.createDiv("lacan-sync-conflict-list");
    for (const conflict of conflicts) {
      const row = list.createDiv("lacan-sync-conflict");
      row.createEl("code", { text: conflict.path });
      const actions = row.createDiv("lacan-sync-actions");
      if (this.engine?.getConflictComparison) {
        const compare = actions.createEl("button", { text: "比较与解决冲突" });
        compare.addEventListener("click", () => { void this.selectConflict(conflict); });
      }
      this.addLocalButton(actions, conflict.path);
      if (conflict.incomingPath) {
        const incoming = actions.createEl("button", { text: "查看上游版本" });
        incoming.addEventListener("click", () => {
          void this.showIncoming(conflict).catch((error) => new Obsidian.Notice(error.message));
        });
      }
    }
    this.detailEl = root.createDiv("lacan-sync-comparison");
  }

  renderReadOnlyReport() {
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

  async selectConflict(conflict, reload = false) {
    const requestId = ++this.requestId;
    this.detailEl.empty();
    this.detailEl.createEl("p", { text: "正在读取比较内容…" });
    try {
      let session = this.sessions.get(conflict.path);
      if (!session || reload) {
        const comparison = await this.engine.getConflictComparison(conflict.path);
        session = { conflict, comparison, choices: {}, manualValues: {}, activeHunk: 0, resultEdited: false, saving: false, error: "" };
        this.sessions.set(conflict.path, session);
      }
      if (requestId === this.requestId) {
        this.renderComparison(session);
        this.detailEl.scrollIntoView?.({ block: "start" });
      }
    } catch (error) {
      if (requestId !== this.requestId) return;
      this.detailEl.empty();
      this.detailEl.createEl("p", { text: error.message, cls: "lacan-sync-error" });
    }
  }

  textPane(root, title, content, label, cls = "") {
    const pane = root.createDiv(`lacan-sync-text-pane ${cls}`);
    pane.createEl("h5", { text: title });
    if (content === null) pane.createEl("p", { text: label.includes("基线") ? "没有可用的可信基线。" : "此版本没有该文件。", cls: "lacan-sync-muted" });
    const area = pane.createEl("textarea", { cls: "lacan-sync-compare-text" });
    area.readOnly = true;
    area.value = content ?? "";
    area.setAttribute("aria-label", label);
    area.spellcheck = false;
    area.rows = Math.max(5, Math.min(16, String(content ?? "").split("\n").length + 1));
    area.wrap = "soft";
    return area;
  }

  renderComparison(session) {
    const root = this.detailEl;
    root.empty();
    const comparison = session.comparison;
    root.createEl("h3", { text: comparison.path.split("/").at(-1) });
    root.createEl("code", { text: comparison.path, cls: "lacan-sync-file-path" });
    if (comparison.missingBase) root.createEl("p", { text: "缺少可信基线，无法判断哪一方改过。以下按段比较差异，默认保留本地内容。", cls: "lacan-sync-warning" });
    const toolbar = root.createDiv("lacan-sync-actions");
    const reload = toolbar.createEl("button", { text: "重新比较（放弃当前草稿）" });
    session.reloadButton = reload;
    reload.disabled = session.saving;
    reload.addEventListener("click", () => { void this.selectConflict(session.conflict, true); });
    this.addLocalButton(toolbar, comparison.path);
    if (!comparison.canResolveText) {
      root.createEl("p", { text: "此文件无法进行文本合并（附件或非 UTF-8 文本）。本地文件已保留，请另行比较附件；上游副本仍在同步缓存中。" });
      if (session.conflict.incomingPath) root.createEl("code", { text: session.conflict.incomingPath });
      return;
    }
    const full = root.createEl("details", { cls: "lacan-sync-full-comparison" });
    full.createEl("summary", { text: "完整文件比较（基线／本地／上游）" });
    const panes = full.createDiv("lacan-sync-compare-grid lacan-sync-full-grid");
    this.textPane(panes, "基线：上次收到的上游原文", comparison.baseText, "基线完整内容（只读）");
    this.textPane(panes, "本地：你的当前修改", comparison.localText, "本地完整内容（只读）");
    this.textPane(panes, "上游：这次收到的新版", comparison.upstreamText, "上游完整内容（只读）");

    session.fileDeletion = comparison.localText === null || comparison.upstreamText === null;
    session.blocks = comparison.blocks || [];
    const conflictEntries = session.blocks.map((block, index) => ({ block, index })).filter(({ block }) => block.conflict);
    for (const { index } of conflictEntries) session.choices[index] ??= "local";
    // Deleting a file is one explicit file-level decision; its preview may
    // still be paged by segment, without reconstructing a partial file.
    if (session.fileDeletion) session.fileChoice ??= "local";
    session.choiceControls = [];
    const conflicts = root.createDiv("lacan-sync-hunks");
    session.activeHunk = Math.max(0, Math.min(session.activeHunk || 0, conflictEntries.length - 1));
    if (conflictEntries.length) {
      const navigation = conflicts.createDiv("lacan-sync-hunk-navigation");
      navigation.createEl("span", { text: `冲突 ${session.activeHunk + 1} / ${conflictEntries.length}`, cls: "lacan-sync-hunk-count", attr: { "aria-live": "polite" } });
      const pageActions = navigation.createDiv("lacan-sync-actions");
      for (const [step, label] of [[-1, "上一处冲突"], [1, "下一处冲突"]]) {
        const page = pageActions.createEl("button", { text: label });
        page.disabled = session.saving || session.activeHunk + step < 0 || session.activeHunk + step >= conflictEntries.length;
        page.addEventListener("click", () => { session.activeHunk += step; this.renderComparison(session); });
      }
      const { block, index } = conflictEntries[session.activeHunk];
      const number = session.activeHunk + 1;
      const hunk = conflicts.createDiv("lacan-sync-hunk");
      const ids = block.conflict.segmentIds || [];
      const position = ids.length ? ids.join("、") : block.conflict.label || (Number.isInteger(block.conflict.oIndex) ? `基线第 ${block.conflict.oIndex + 1} 行附近` : `冲突 ${number}`);
      hunk.createEl("h4", { text: position });
      const grid = hunk.createDiv("lacan-sync-compare-grid");
      this.textPane(grid, "本地 · 默认保留", block.conflict.a.join(""), `冲突 ${number} 本地（只读）`, "is-local");
      this.textPane(grid, "上游", block.conflict.b.join(""), `冲突 ${number} 上游（只读）`);
      const base = hunk.createEl("details", { cls: "lacan-sync-base-comparison" });
      base.createEl("summary", { text: "查看此段基线" });
      this.textPane(base, "基线", comparison.missingBase ? null : block.conflict.o.join(""), `冲突 ${number} 基线（只读）`);
      if (session.fileDeletion) hunk.createEl("p", { text: "一方已删除文件。以下选择应用于整个文件，可翻页检查各段。", cls: "lacan-sync-warning" });
      const actions = hunk.createDiv("lacan-sync-actions");
      const labels = session.fileDeletion
        ? [["local", comparison.localText === null ? "保留本地删除" : "保留本地文件"], ["upstream", comparison.upstreamText === null ? "采用上游删除" : "采用上游文件"], ["manual", "手动填写完整文件"]]
        : [["local", "保留本地这一处"], ["upstream", "采用上游这一处"], ["manual", "手动填写这一处"]];
      for (const [choice, label] of labels) {
        const button = actions.createEl("button", { text: label });
        button.disabled = session.saving || session.resultEdited;
        button.setAttribute("aria-pressed", (session.fileDeletion ? session.fileChoice : session.choices[index]) === choice ? "true" : "false");
        session.choiceControls.push(button);
        button.addEventListener("click", () => {
          if (session.fileDeletion) session.fileChoice = choice;
          else session.choices[index] = choice;
          session.error = "";
          const key = session.fileDeletion ? "file" : index;
          if (choice === "manual" && !Object.hasOwn(session.manualValues, key)) session.manualValues[key] = session.fileDeletion ? comparison.localText ?? "" : block.conflict.a.join("");
          this.renderComparison(session);
        });
      }
      if ((session.fileDeletion ? session.fileChoice : session.choices[index]) === "manual") {
        const key = session.fileDeletion ? "file" : index;
        const manual = hunk.createEl("textarea", { cls: "lacan-sync-manual-text" });
        manual.value = session.manualValues[key] || "";
        manual.setAttribute("aria-label", session.fileDeletion ? "完整文件手工结果" : `冲突 ${number} 手工结果`);
        manual.spellcheck = false;
        manual.disabled = session.saving || session.resultEdited;
        session.choiceControls.push(manual);
        manual.addEventListener("input", () => { session.manualValues[key] = manual.value; this.updateResult(session); });
      }
    }

    const result = root.createEl("details", { cls: "lacan-sync-result" });
    result.open = session.resultEdited;
    result.createEl("summary", { text: "完整合并结果（检查或编辑）" });
    result.createEl("p", { text: "无冲突的改动已自动纳入。直接修改完整结果后，逐处选择会锁定；重新比较可恢复默认选择。", cls: "lacan-sync-muted" });
    session.resultEl = result.createEl("textarea", { cls: "lacan-sync-result-text" });
    session.resultEl.setAttribute("aria-label", "合并结果");
    session.resultEl.spellcheck = false;
    session.resultEl.addEventListener("input", () => {
      session.result = session.resultEl.value;
      session.resultEdited = true;
      for (const control of session.choiceControls) control.disabled = true;
      session.statusEl.setText("完整结果已有手工修改。确认保存会采用下方内容；逐处选择已锁定，避免覆盖你的修改。");
    });
    const footer = root.createDiv("lacan-sync-resolution-footer");
    session.statusEl = footer.createEl("p", { cls: "lacan-sync-selection-status", attr: { "aria-live": "polite" } });
    const actions = footer.createDiv("lacan-sync-actions");
    session.saveButton = actions.createEl("button", { text: "确认保存合并结果", cls: "mod-cta" });
    session.saveButton.addEventListener("click", () => { void this.saveResolution(session); });
    session.errorEl = footer.createEl("p", { cls: "lacan-sync-error", attr: { role: "alert" } });
    session.errorEl.setText(session.error);
    this.updateResult(session);
  }

  updateResult(session) {
    const comparison = session.comparison;
    let unresolved = 0;
    const parts = [];
    for (let index = 0; index < session.blocks.length; index += 1) {
      const block = session.blocks[index];
      if (block.ok) { parts.push(block.ok.join("")); continue; }
      const choice = session.choices[index];
      if (!choice) unresolved += 1;
      parts.push(choice === "manual" ? session.manualValues[index] ?? "" : (choice === "upstream" ? block.conflict.b : block.conflict.a).join(""));
    }
    let content = parts.join("");
    if (session.fileDeletion) content = session.fileChoice === "manual" ? session.manualValues.file ?? ""
      : session.fileChoice === "upstream" ? comparison.upstreamText : comparison.localText;
    if (!session.resultEdited) session.result = content;
    session.unresolved = unresolved;
    session.resultEl.value = session.result === null ? "（确认后保留该文件的删除状态）" : session.result.replace(/\r\n/g, "\n");
    session.resultEl.readOnly = session.saving || unresolved > 0 || session.result === null;
    session.saveButton.disabled = session.saving || unresolved > 0;
    session.reloadButton.disabled = session.saving;
    session.saveButton.setText(session.saving ? "正在安全保存…" : session.result === null ? "确认保留删除" : "确认保存合并结果");
    session.statusEl.setText(unresolved ? `还有 ${unresolved} 处冲突待选择；预览暂用这些位置的本地内容。` : session.resultEdited
      ? "完整结果已有手工修改，确认保存会采用编辑后的内容。" : session.result === null ? "当前选择保留文件删除状态，确认后生效。"
        : session.fileDeletion ? "已选择保留完整文件，确认保存后生效。"
          : `保留本地 ${Object.values(session.choices).filter((choice) => choice === "local").length} 处，采用上游 ${Object.values(session.choices).filter((choice) => choice === "upstream").length} 处，手工填写 ${Object.values(session.choices).filter((choice) => choice === "manual").length} 处。无冲突改动已纳入，确认保存后生效。`);
  }

  async saveResolution(session) {
    if (session.saving || session.unresolved) return;
    session.saving = true;
    session.error = "";
    session.errorEl.setText("");
    for (const control of session.choiceControls) control.disabled = true;
    this.updateResult(session);
    let result;
    try {
      result = await this.engine.resolveConflict(session.comparison.path, {
        expectedLocalHash: session.comparison.localHash,
        expectedUpstreamHash: session.comparison.upstreamHash,
        content: session.result,
      });
    } catch (error) {
      session.saving = false;
      session.error = `${error.message} 当前合并草稿已保留；可复制结果后重新比较。`;
      if (!this.isClosed) this.renderComparison(session);
      return;
    }
    this.report.version = result.version || this.report.version;
    this.report.conflicts = result.conflicts;
    this.sessions.delete(session.comparison.path);
    this.requestId += 1;
    if (!this.isClosed) this.renderReport();
    new Obsidian.Notice("合并结果已保存，本地修改已纳入后续增量同步。");
    try { await this.onResolved?.(result); }
    catch (error) { new Obsidian.Notice(`合并已保存，刷新视图失败：${error.message}`); }
  }

  async showIncoming(conflict) {
    const bytes = await this.storage.read(conflict.incomingPath);
    if (!bytes) throw new Error("找不到上游副本，请重新同步。 ");
    const modal = new Modal(this.app);
    modal.onOpen = () => {
      modal.modalEl?.classList.add("lacan-sync-report-modal");
      modal.titleEl.setText(`上游版本：${conflict.path}`);
      if (/\.(md|txt|csv|json)$/i.test(conflict.path)) {
        const area = modal.contentEl.createEl("textarea", { cls: "lacan-sync-upstream-text" });
        area.readOnly = true;
        area.value = new TextDecoder().decode(bytes);
        area.setAttribute("aria-label", "上游原始内容，只读，可选择复制");
      } else {
        modal.contentEl.createEl("p", { text: `上游附件已保存在本地同步缓存中，大小 ${bytes.byteLength} 字节。` });
        modal.contentEl.createEl("code", { text: conflict.incomingPath });
      }
    };
    modal.open();
  }
}

module.exports = { ProjectSyncReportModal };
