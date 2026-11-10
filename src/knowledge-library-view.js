const STATUS_LABELS = {
  not_synced: "未同步", synced: "已同步", update: "有更新", missing_assets: "附件待补齐",
  modified: "本地已修改", local_only: "仅本地", removed: "上游已移除", error: "同步失败",
  unknown: "目录待刷新", checking: "检查中",
};
const strings = (values) => Array.isArray(values) ? values.filter((value) => typeof value === "string") : [];
const tagsOf = (entry) => strings(entry.tags);
const fieldValues = (entry, field) => {
  const tags = tagsOf(entry);
  if (field === "category") return tags.filter((tag) => tag.startsWith("领域/")).map((tag) => tag.split("/")[1]);
  if (field === "topic") return tags.filter((tag) => tag.startsWith("领域/") && tag.split("/").length > 2).map((tag) => tag.split("/").slice(2).join("/"));
  if (field === "seminar") return tags.filter((tag) => /^研讨班/.test(tag));
  return [];
};
const entryStatus = (entry) => entry.removed ? "removed" : entry.localOnly ? "local_only" : entry.status || "not_synced";

const searchText = (entry) => [entry.title, entry.path, entry.excerpt, ...tagsOf(entry), ...strings(entry.aliases)].join(" ").normalize("NFKC").toLocaleLowerCase();
const searchWords = (value) => String(value || "").normalize("NFKC").trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);

const matchesKnowledgeFilters = (entry, filters, words = searchWords(filters.search), haystack = searchText(entry)) => {
  return words.every((word) => haystack.includes(word))
    && ["category", "topic", "seminar"].every((field) => !filters[field] || fieldValues(entry, field).includes(filters[field]))
    && (!filters.status || entryStatus(entry) === filters.status);
};

function createKnowledgeBasesViewClass(BasesView) {
  return class KnowledgeLibraryBasesView extends BasesView {
    constructor(controller, parentEl, plugin) {
      super(controller);
      this.plugin = plugin;
      this.containerEl = parentEl.createDiv("lacan-bases-list lacan-knowledge-list");
      this.catalogContainer = parentEl.closest?.(".view-content");
      this.catalogContainer?.addClass("lacan-catalog-base");
      this.filters = Object.fromEntries(["search", "category", "topic", "seminar", "status"].map((field) => [field,
        typeof plugin.settings?.projectKnowledgeFilters?.[field] === "string" ? plugin.settings.projectKnowledgeFilters[field] : ""]));
      this.progressElements = new Map();
      this.statusElements = new Map();
      plugin.projectKnowledgeViews ||= new Set();
      plugin.projectKnowledgeViews.add(this);
      this.onDataUpdated();
    }

    onunload() {
      clearTimeout(this.searchRenderTimer);
      void this.persistFilters();
      this.plugin.projectKnowledgeViews?.delete(this);
      this.catalogContainer?.removeClass("lacan-catalog-base");
      this.progressElements.clear();
      this.statusElements.clear();
    }

    onDataUpdated() {
      clearTimeout(this.searchRenderTimer);
      this.containerEl.empty();
      this.entries = this.plugin.getKnowledgeEntries();
      this.searchTexts = new Map(this.entries.map((entry) => [entry.path, searchText(entry)]));
      this.containerEl.createEl("p", {
        cls: "lacan-bases-catalog-status",
        text: `${this.entries.length} 个知识词条 · 目录可搜索，正文按需同步`,
      });
      if (!this.plugin.projectCatalog) this.containerEl.createEl("p", {
        cls: "lacan-bases-catalog-status",
        text: this.plugin.projectCatalogError || "尚无发布目录，更新目录后可查看未下载的词条。",
      });
      if (this.plugin.projectCatalog?.knowledgeMetadataAvailable === false) this.containerEl.createEl("p", {
        cls: "lacan-bases-catalog-status",
        text: "未下载词条的目录目前仅提供标题；已下载词条可按本地标签查询。",
      });
      const toolbar = this.containerEl.createDiv("lacan-knowledge-toolbar");
      this.createActionLink(toolbar, "更新目录", () => this.plugin.refreshProjectCatalog({ notify: true }), true);
      this.createActionLink(toolbar, "同步全部知识库", () => this.plugin.syncAllProjectKnowledge(), true);
      this.bulkSyncProgressEl = toolbar.createSpan({ cls: "lacan-bases-catalog-status", attr: { role: "status", "aria-live": "polite" } });
      this.bulkSyncCancelLink = this.createActionLink(toolbar, "取消同步", () => {
        if (this.plugin.knowledgeBulkSync) this.plugin.cancelProjectSync();
      });
      this.updateBulkSyncProgress();
      const search = this.containerEl.createEl("input", {
        cls: "lacan-bases-catalog-search", type: "search", placeholder: "搜索词条、标签或正文摘录",
        attr: { "aria-label": "搜索完整知识库目录" },
      });
      search.value = this.filters.search;
      search.addEventListener("input", () => this.changeFilter("search", search.value, { debounce: true }));
      const controls = this.containerEl.createDiv("lacan-knowledge-filters");
      for (const [field, label] of [["category", "分类"], ["topic", "主题"], ["seminar", "关联研讨班"], ["status", "同步状态"]]) {
        const values = field === "status" ? Object.keys(STATUS_LABELS)
          : [...new Set(this.entries.flatMap((entry) => fieldValues(entry, field)))].sort((a, b) => a.localeCompare(b, "zh-CN"));
        const wrapper = controls.createEl("label", { cls: "lacan-knowledge-filter" });
        wrapper.createSpan({ text: label });
        const select = wrapper.createEl("select", { attr: { "aria-label": label } });
        select.createEl("option", { value: "", text: "全部" });
        for (const value of values) select.createEl("option", { value, text: field === "status" ? STATUS_LABELS[value] : value });
        if (this.filters[field] && !values.includes(this.filters[field])) select.createEl("option", { value: this.filters[field], text: this.filters[field] });
        select.value = this.filters[field];
        select.addEventListener("change", () => this.changeFilter(field, select.value));
      }
      this.resultsEl = this.containerEl.createDiv("lacan-knowledge-results");
      this.renderEntries();
    }

    changeFilter(field, value, { debounce = false } = {}) {
      this.filters[field] = value;
      this.plugin.settings.projectKnowledgeFilters = { ...this.filters };
      this.filtersDirty = true;
      clearTimeout(this.filterSaveTimer);
      this.filterSaveTimer = setTimeout(() => { void this.persistFilters(); }, 300);
      clearTimeout(this.searchRenderTimer);
      if (debounce) this.searchRenderTimer = setTimeout(() => this.renderEntries(), 100);
      else this.renderEntries();
    }

    persistFilters() {
      clearTimeout(this.filterSaveTimer);
      if (!this.filtersDirty) return Promise.resolve();
      this.filtersDirty = false;
      return Promise.resolve().then(() => this.plugin.saveSettings?.())
        .catch((error) => console.error("无法保存知识库筛选条件。", error));
    }

    renderEntries() {
      this.resultsEl.empty();
      this.progressElements.clear();
      this.statusElements.clear();
      const words = searchWords(this.filters.search);
      const matching = this.entries.filter((entry) => matchesKnowledgeFilters(entry, this.filters, words, this.searchTexts.get(entry.path)));
      this.resultsEl.createEl("p", { cls: "lacan-bases-catalog-status", text: `${matching.length} / ${this.entries.length} 个词条` });
      if (!matching.length) {
        this.resultsEl.createEl("p", { cls: "lacan-bases-catalog-status", text: "没有符合条件的词条。" });
        return;
      }
      const scroll = this.resultsEl.createDiv("lacan-knowledge-table-scroll");
      const table = scroll.createEl("table", { cls: "lacan-knowledge-table" });
      const header = table.createEl("thead").createEl("tr");
      for (const label of ["词条名称", "分类／主题", "关联研讨班", "同步状态", "操作"]) header.createEl("th", { text: label, attr: { scope: "col" } });
      const body = table.createEl("tbody");
      for (const entry of matching) this.renderEntry(body, entry);
    }

    renderEntry(body, entry) {
      const row = body.createEl("tr", { attr: { "data-path": entry.path } });
      const title = row.createEl("td");
      title.createSpan({ cls: "lacan-knowledge-title", text: entry.title || entry.path });
      if (entry.excerpt) title.createEl("p", { cls: "lacan-knowledge-excerpt", text: entry.excerpt });
      title.createEl("div", { cls: "lacan-knowledge-path", text: entry.path });
      row.createEl("td", { text: [...new Set([...fieldValues(entry, "category"), ...fieldValues(entry, "topic")])].join(" · ") || "—" });
      row.createEl("td", { text: fieldValues(entry, "seminar").join(" · ") || "—" });
      const status = entryStatus(entry);
      const state = row.createEl("td");
      this.statusElements.set(entry.path, { element: state.createSpan(), entry });
      const progress = state.createSpan({ cls: "lacan-bases-progress lacan-knowledge-progress" });
      progress.setAttribute("role", "progressbar");
      progress.setAttribute("aria-label", `${entry.title || entry.path} 同步进度`);
      progress.setAttribute("aria-valuemin", "0");
      progress.setAttribute("aria-valuemax", "100");
      this.progressElements.set(entry.path, progress);
      this.updateSyncProgress(entry.path);
      const actions = row.createEl("td", { cls: "lacan-knowledge-actions" });
      const local = typeof entry.local === "boolean" ? entry.local : status !== "not_synced";
      if (local) this.createActionLink(actions, "打开", () => this.plugin.openKnowledgeEntry(entry.path));
      if (entry.localOnly || entry.removed) return;
      const syncLabel = status === "error" ? "重试" : !local ? "同步" : status === "missing_assets" ? "补齐附件" : status === "update" ? "更新" : "检查更新";
      this.createActionLink(actions, syncLabel, () => this.plugin.syncProjectKnowledgeEntry(entry.path, { open: false }), true);
      if (!local) this.createActionLink(actions, "同步并打开", () => this.plugin.syncProjectKnowledgeEntry(entry.path, { open: true }), true);
    }

    updateSyncProgress(path) {
      const element = this.progressElements.get(path);
      if (!element) return;
      const value = this.plugin.knowledgeSyncProgress?.get(path);
      const active = this.plugin.activeKnowledgeSync === path;
      const state = this.statusElements.get(path);
      if (state) {
        const library = this.plugin.getKnowledgeLibrary?.();
        const current = library?.failures?.[path] || library?.statuses?.[path];
        const entry = current ? { ...state.entry, ...current } : state.entry;
        const status = entryStatus(entry);
        state.element.textContent = active ? "同步中…" : entry.label || STATUS_LABELS[status] || status;
      }
      element.hidden = !active && !Number.isFinite(value);
      const percent = Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0;
      element.textContent = element.hidden ? "" : ` ${percent}%`;
      element.setAttribute("aria-valuenow", `${percent}`);
    }

    updateBulkSyncProgress() {
      const bulk = this.plugin.knowledgeBulkSync;
      if (this.bulkSyncProgressEl) {
        this.bulkSyncProgressEl.hidden = !bulk;
        this.bulkSyncProgressEl.textContent = !bulk ? "" : bulk.total > 0
          ? `已处理 ${bulk.completed} / ${bulk.total} 个词条${bulk.title ? ` · 正在同步：${bulk.title}` : ""}`
          : bulk.title || "正在读取目录…";
      }
      if (this.bulkSyncCancelLink) this.bulkSyncCancelLink.hidden = !bulk;
    }

    createActionLink(parentEl, text, action, syncAction = false) {
      const link = parentEl.createEl("a", { cls: "lacan-bases-link", href: "#", text });
      const disabled = syncAction && Boolean(this.plugin.syncInProgress);
      link.setAttribute("aria-disabled", `${disabled}`);
      if (disabled) link.addClass("is-disabled");
      link.addEventListener("click", async (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (syncAction && this.plugin.syncInProgress) return;
        await this.plugin.runWithNotice(action, "知识库操作失败");
      });
      return link;
    }
  };
}

module.exports = { createKnowledgeBasesViewClass, matchesKnowledgeFilters, STATUS_LABELS };
