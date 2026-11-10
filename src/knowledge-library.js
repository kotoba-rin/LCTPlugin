const nodePath = require("path");
const Obsidian = require("obsidian");
const { isAssetPath } = require("./project-sync/catalog");

const isKnowledgePath = (path) => typeof path === "string" && /^知识库\/.+\.md$/i.test(path) && !/(?:^|\/)README\.md$/i.test(path);

const knowledgeLinkParts = (raw) => {
  if (typeof raw !== "string" || /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(raw)) return null;
  let target;
  try { target = decodeURIComponent(raw).split("|", 1)[0]; } catch { return null; }
  const anchor = target.indexOf("#");
  const path = (anchor < 0 ? target : target.slice(0, anchor)).replace(/^\//, "");
  if (!path || path.includes("\\")) return null;
  return { path, subpath: anchor < 0 ? "" : target.slice(anchor) };
};

const resolveKnowledgeTargets = (raw, sourcePath, entries) => {
  const parts = knowledgeLinkParts(raw);
  if (!parts) return [];
  const withExtension = (path) => /\.md$/i.test(path) ? path : `${path}.md`;
  const paths = new Set([withExtension(parts.path), withExtension(nodePath.posix.normalize(nodePath.posix.join(nodePath.posix.dirname(sourcePath || ""), parts.path)))]);
  const exact = entries.filter((entry) => paths.has(entry.path));
  if (exact.length) return exact.map((entry) => ({ ...entry, subpath: parts.subpath }));
  if (parts.path.includes("/")) return [];
  const name = parts.path.replace(/\.md$/i, "");
  return entries.filter((entry) => nodePath.posix.basename(entry.path, ".md") === name || entry.title === name || entry.aliases?.includes(name))
    .map((entry) => ({ ...entry, subpath: parts.subpath }));
};

class KnowledgeLinkModal extends (Obsidian.Modal || class {}) {
  constructor(library, targets, newLeaf) {
    super(library.plugin.app);
    this.library = library;
    this.targets = targets;
    this.newLeaf = newLeaf;
  }

  onOpen() {
    this.titleEl.setText(this.targets.length > 1 ? "选择知识卡" : "同步知识卡");
    this.contentEl.createEl("p", { text: this.targets.length > 1 ? "这个名称对应多个词条，请选择要打开的知识卡。" : "此词条尚未下载，同步后即可阅读。" });
    for (const target of this.targets) {
      const row = this.contentEl.createDiv("lacan-knowledge-link-choice");
      row.createEl("p", { text: target.title });
      if (this.targets.length > 1) row.createEl("small", { text: target.path });
      const local = this.library.plugin.app.vault.getAbstractFileByPath(target.path);
      const button = row.createEl("button", { text: local ? "打开" : "同步并打开", cls: "mod-cta" });
      button.addEventListener("click", async () => {
        button.disabled = true;
        try {
          if (local) await this.library.open(target.path, target.subpath, { newLeaf: this.newLeaf });
          else await this.library.sync(target.path, { open: true, subpath: target.subpath, newLeaf: this.newLeaf });
          this.close();
        } catch (error) {
          new Obsidian.Notice(error.message || "知识卡同步失败，请重试。");
        } finally { button.disabled = false; }
      });
    }
  }

  onClose() { this.contentEl.empty(); }
}

class KnowledgeLibrary {
  constructor(plugin) {
    this.plugin = plugin;
    this.statuses = {};
    this.failures = {};
    this.refreshGeneration = 0;
    this.refreshRevision = 0;
    this.changeRevision = 0;
    plugin.projectKnowledgeViews ||= new Set();
    plugin.knowledgeSyncProgress ||= new Map();
  }

  getEntries() {
    const plugin = this.plugin;
    const entries = new Map((plugin.projectCatalog?.knowledgeEntries || []).map((entry) => [entry.path, { ...entry }]));
    for (const file of plugin.app.vault.getMarkdownFiles?.() || []) {
      if (!isKnowledgePath(file.path)) continue;
      const frontmatter = plugin.app.metadataCache?.getFileCache?.(file)?.frontmatter;
      if (frontmatter?.type !== "knowledge-card") continue;
      const published = entries.get(file.path);
      if (published) {
        if (!plugin.projectCatalog.knowledgeMetadataAvailable) entries.set(file.path, { ...published,
          title: frontmatter.title || published.title, tags: Array.isArray(frontmatter.tags) ? frontmatter.tags : published.tags,
          aliases: Array.isArray(frontmatter.aliases) ? frontmatter.aliases : published.aliases });
        continue;
      }
      entries.set(file.path, { path: file.path, title: frontmatter.title || file.basename, tags: Array.isArray(frontmatter.tags) ? frontmatter.tags : [],
        aliases: Array.isArray(frontmatter.aliases) ? frontmatter.aliases : [], excerpt: "", localOnly: true });
    }
    return [...entries.values()].map((entry) => {
      const local = Boolean(plugin.app.vault.getAbstractFileByPath(entry.path));
      const known = this.failures[entry.path] || this.statuses[entry.path];
      const status = known || (entry.localOnly ? { status: "local_only", label: "仅本地" }
        : local ? { status: "checking", label: "检查中" } : { status: "not_synced", label: "未同步" });
      return { ...entry, ...status, local, removed: status.status === "removed" };
    }).sort((a, b) => String(a.title).localeCompare(String(b.title), "zh-CN"));
  }

  render() {
    for (const view of this.plugin.projectKnowledgeViews || []) view.onDataUpdated();
  }

  async refresh({ engine, signal } = {}) {
    clearTimeout(this.refreshTimer);
    this.refreshController?.abort();
    const controller = new AbortController();
    this.refreshController = controller;
    const generation = ++this.refreshGeneration;
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) controller.abort();
    const run = async () => {
      try {
        if (signal?.aborted) throw Object.assign(new Error("知识库状态检查已取消。"), { name: "AbortError" });
        if (generation !== this.refreshGeneration || this.disposed) return;
        const catalog = this.plugin.projectCatalog;
        const changeRevision = this.changeRevision;
        if (!catalog) { this.render(); return; }
        engine ||= this.plugin.createProjectSyncEngine();
        if (typeof engine.getKnowledgeEntryStatuses !== "function") { this.render(); return; }
        const statuses = await engine.getKnowledgeEntryStatuses(catalog, { signal: controller.signal });
        if (signal?.aborted) throw Object.assign(new Error("知识库状态检查已取消。"), { name: "AbortError" });
        if (generation !== this.refreshGeneration || catalog !== this.plugin.projectCatalog || this.disposed) return;
        this.statuses = statuses;
        this.refreshedCatalog = catalog;
        this.refreshedChangeRevision = changeRevision;
        this.refreshRevision += 1;
        this.render();
      } catch (error) {
        if (controller.signal.aborted && !signal?.aborted && generation !== this.refreshGeneration) return;
        throw error;
      } finally {
        signal?.removeEventListener("abort", onAbort);
        if (this.refreshController === controller) this.refreshController = null;
      }
    };
    this.refreshWork = (this.refreshWork || Promise.resolve()).catch(() => {}).then(run);
    return this.refreshWork;
  }

  scheduleRefresh() {
    clearTimeout(this.refreshTimer);
    if (this.disposed || this.plugin.syncInProgress || !this.plugin.projectCatalog) return;
    this.pauseRefresh();
    this.refreshTimer = setTimeout(() => {
      if (this.plugin.syncInProgress) return;
      void this.refresh().catch((error) => console.warn("Knowledge library status refresh failed", error));
    }, 200);
  }

  pauseRefresh() {
    clearTimeout(this.refreshTimer);
    this.refreshGeneration += 1;
    this.refreshController?.abort();
  }

  hasRefreshedSince(revision, catalog = this.plugin.projectCatalog) {
    return this.refreshRevision > revision && this.refreshedCatalog === catalog
      && this.refreshedChangeRevision === this.changeRevision;
  }

  affectsStatus(file, oldPath) {
    const paths = [typeof file === "string" ? file : file?.path, oldPath].filter((path) => typeof path === "string" && path);
    if (!paths.length) return true;
    const folder = Array.isArray(file?.children) || paths.some((path) => !nodePath.posix.extname(path));
    if (paths.some((path) => isKnowledgePath(path) || (folder && (path === "知识库" || path.startsWith("知识库/"))))) return true;
    if (!folder && !paths.some(isAssetPath)) return false;
    return (this.plugin.projectCatalog?.files || []).some(({ path }) => isAssetPath(path)
      && paths.some((changed) => changed === path || (folder && path.startsWith(`${changed}/`))));
  }

  scheduleRefreshForChange(file, oldPath) {
    if (this.affectsStatus(file, oldPath)) {
      this.changeRevision += 1;
      this.scheduleRefresh();
    }
  }

  setProgress(path, percent) {
    this.plugin.knowledgeSyncProgress.set(path, Math.max(0, Math.min(100, percent)));
    for (const view of this.plugin.projectKnowledgeViews || []) view.updateSyncProgress(path);
  }

  async sync(path, { open = false, subpath = "", newLeaf = false } = {}) {
    const plugin = this.plugin;
    if (plugin.syncInProgress) throw new Error("已有文库同步正在进行，请等待完成或取消后再试。");
    delete this.failures[path];
    this.setProgress(path, 0);
    try {
      const result = await plugin.runProjectLibraryTask(async (engine, signal) => {
        const result = await engine.syncKnowledgeEntry(path, { signal });
        if (result.catalog) plugin.projectCatalog = result.catalog;
        if (result.removed) {
          this.statuses[path] = { status: "removed", label: "上游已移除" };
          new Obsidian.Notice("该词条已不在发布目录中，本地内容已保留。");
          return result;
        }
        plugin.recordProjectSyncResult(result);
        await plugin.saveSettings();
        // Compare against the exact release used by this download.
        if (!result.catalog) plugin.projectCatalog = await engine.getCatalog({ signal });
        await this.refresh({ engine, signal });
        const skipped = result.skippedFiles || [];
        this.setProgress(path, skipped.length ? 0 : 100);
        if (skipped.length) new Obsidian.Notice(`知识卡或引用附件已有本地修改，已跳过同步。\n${skipped.map((item) => item.path).join("\n")}`, 12000);
        else new Obsidian.Notice("知识卡及引用附件已同步。");
        return result;
      }, { label: "正在同步知识卡…", knowledgePath: path });
      if (open && !result.removed && !result.skippedFiles?.length) await this.open(path, subpath, { newLeaf });
      return result;
    } catch (error) {
      this.setProgress(path, 0);
      this.statuses[path] = { status: "error", label: error.name === "AbortError" ? "已取消，可重试" : "同步失败，可重试" };
      this.failures[path] = this.statuses[path];
      this.render();
      throw error;
    }
  }

  async syncAll() {
    const plugin = this.plugin;
    if (plugin.syncInProgress) throw new Error("已有文库同步正在进行，请等待完成或取消后再试。");
    plugin.knowledgeBulkSync = { completed: 0, total: 0, title: "正在读取目录…" };
    try {
      const result = await plugin.runProjectLibraryTask(async (engine, signal) => {
        let activePath;
        let recorded = false;
        const updateProgress = () => {
          for (const view of plugin.projectKnowledgeViews || []) view.updateBulkSyncProgress?.();
        };
        try {
          const result = await engine.syncAllKnowledgeEntries({ signal,
            getOrderedPaths: (catalog) => {
              plugin.projectCatalog = catalog;
              plugin.projectCatalogError = null;
              return this.getEntries().filter((entry) => !entry.localOnly).map((entry) => entry.path);
            },
            onEntry: ({ entry, index, total, catalog, result, summary }) => {
              plugin.projectCatalog = catalog;
              plugin.projectCatalogError = null;
              if (!result) {
                activePath = entry.path;
                plugin.activeKnowledgeSync = entry.path;
                delete this.failures[entry.path];
                plugin.knowledgeBulkSync = { completed: index, total, title: entry.title };
                this.setProgress(entry.path, 0);
                if (index === 0) this.render();
              } else {
                activePath = null;
                plugin.activeKnowledgeSync = null;
                this.statuses[entry.path] = result.skippedFiles.length
                  ? { status: "modified", label: "本地已修改" } : { status: "synced", label: "已同步" };
                plugin.knowledgeBulkSync = { completed: index + 1, total, title: "" };
                this.setProgress(entry.path, result.skippedFiles.length ? 0 : 100);
                plugin.recordProjectSyncResult(summary);
                recorded = true;
              }
              updateProgress();
            },
          });
          plugin.projectCatalog = result.catalog;
          plugin.recordProjectSyncResult(result);
          recorded = true;
          return result;
        } catch (error) {
          if (activePath) {
            this.statuses[activePath] = { status: "error", label: error.name === "AbortError" ? "已取消，可重试" : "同步失败，可重试" };
            this.failures[activePath] = this.statuses[activePath];
            this.setProgress(activePath, 0);
          }
          throw error;
        } finally {
          if (recorded) await plugin.saveSettings();
          await this.refresh({ engine });
        }
      }, { label: "正在依次同步全部知识库…" });
      new Obsidian.Notice(`知识库同步完成：已处理 ${result.completedEntries} 个词条${result.skippedEntries ? `，其中 ${result.skippedEntries} 个因本地修改跳过` : ""}。`, 10000);
      return result;
    } finally {
      plugin.knowledgeBulkSync = null;
      this.render();
    }
  }

  async open(path, subpath = "", { newLeaf = false } = {}) {
    if (!isKnowledgePath(path) || !this.plugin.app.vault.getAbstractFileByPath(path)) throw new Error("该知识卡尚未下载，请先同步。");
    if (this.plugin.app.workspace.openLinkText) await this.plugin.app.workspace.openLinkText(`${path}${subpath}`, "", newLeaf);
    else await this.plugin.openFile(this.plugin.app.vault.getAbstractFileByPath(path), subpath ? { eState: { subpath } } : undefined);
  }

  decorateLinks(element, sourcePath) {
    for (const link of element.querySelectorAll?.("a.internal-link") || []) link.dataset.lacanKnowledgeSource = sourcePath;
  }

  handleLinkClick(event) {
    if (event.button > 0 || event.defaultPrevented) return false;
    const link = event.target?.closest?.("a.internal-link");
    if (!link) return false;
    const sourcePath = link.dataset?.lacanKnowledgeSource || this.plugin.app.workspace.getActiveFile?.()?.path || "";
    const raw = link.getAttribute("data-href") || link.getAttribute("href");
    const parts = knowledgeLinkParts(raw);
    if (!parts) return false;
    const resolved = this.plugin.app.metadataCache?.getFirstLinkpathDest?.(parts.path, sourcePath);
    if (resolved && !isKnowledgePath(resolved.path)) return false;
    const targets = resolveKnowledgeTargets(raw, sourcePath, this.getEntries());
    if (!targets.length) return false;
    if (resolved && targets.some((target) => target.path === resolved.path)) return true;
    event.preventDefault();
    event.stopImmediatePropagation?.();
    event.stopPropagation();
    if (targets.length === 1 && this.plugin.app.vault.getAbstractFileByPath(targets[0].path)) {
      void this.open(targets[0].path, targets[0].subpath, { newLeaf: Boolean(event.ctrlKey || event.metaKey || event.shiftKey) })
        .catch((error) => new Obsidian.Notice(error.message || "打开知识卡失败。"));
      return true;
    }
    new KnowledgeLinkModal(this, targets, Boolean(event.ctrlKey || event.metaKey || event.shiftKey)).open();
    return true;
  }

  dispose() {
    this.disposed = true;
    this.pauseRefresh();
    this.plugin.projectKnowledgeViews?.clear();
  }
}

module.exports = { KnowledgeLibrary, knowledgeLinkParts, resolveKnowledgeTargets, isKnowledgePath };
