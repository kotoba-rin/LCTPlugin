const Obsidian = require("obsidian");
const { SegmentParser } = require("../segment-ai/segment-parser");
const {
  LACAN_BILINGUAL_VIEW_TYPE,
  LacanBilingualReadingView,
} = require("./bilingual-reading-view");
const { captureMarkdownReadingPosition } = require("./reading-position");
const { FrenchDictionaryService } = require("./french-dictionary-service");
const { FrenchLookupPopup } = require("./french-lookup-popup");
const { FrenchSelectionTranslator } = require("./french-selection-translator");
const { buildFrenchLookup } = require("./french-lookup-text");
const { EUDIC_AUTHORIZATION_URL, openEudicTokenModal } = require("./eudic-token-modal");
const { TranslationInlineEditor } = require("./translation-inline-editor");
const { readTranslationSegment, replaceTranslationSegment } = require("./translation-inline-source");
const { bindTranslationPreview } = require("./translation-reading-preview");
const { registerPdfReading, addPdfFileMenuItems } = require("./pdf-reading");
const { createProjectTransport, createVaultSyncStorage } = require("./project-sync-obsidian");
const { createPluginRequest } = require("./plugin-http-request");
const { PROJECT_BASE_PATH, PROJECT_BASE_CONTENT, migrateProjectBaseContent } = require("./project-library-base");
const { KnowledgeLibrary } = require("./knowledge-library");
const { createKnowledgeBasesViewClass } = require("./knowledge-library-view");
const { formatSkipNotice } = require("./project-sync-status");
const { ProjectSyncReportModal } = require("./project-sync-report");
const {
  Component,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  normalizePath,
} = Obsidian;
const {
  DEFAULT_INTERPRETATION_PROMPT,
  InterpretationPromptBuilder,
  resolveConfiguredInterpretationPrompt,
} = require("../segment-ai/domain");
const {
  CodexAppServerRuntime,
  coerceCodexReasoningEffort,
  normalizeCodexModelCatalog,
  resolveCodexReasoningProfile,
} = require("../segment-ai/codex-app-server-runtime");
const { CliAgentRuntime } = require("../segment-ai/cli-agent-runtime");
const { discoverCli } = require("../segment-ai/cli-discovery");
const {
  PROVIDER_DEFINITIONS,
  normalizeProvider,
  normalizeProviderSettings,
  switchProviderSettings,
} = require("../segment-ai/provider-settings");
const {
  getMachineCliPath,
  setMachineCliPath,
  migrateMachineCliPaths,
} = require("../segment-ai/machine-cli-settings");
const {
  InterpretationWorkspaceController,
} = require("../segment-ai/workspace-controller");
const {
  InterpretationWorkspaceStore,
  normalizeMaxOpenSessions,
} = require("../segment-ai/workspace-store");
const {
  CodexSkillCatalog,
  normalizeSkillMetadata,
} = require("../segment-ai/skill-catalog");
const {
  LACAN_INTERPRETATION_VIEW_TYPE,
  LacanInterpretationView,
  createObsidianContextResolver,
} = require("../segment-ai/obsidian-integration");
let Decoration = null;
let ViewPlugin = null;
let WidgetTypeBase = class {};
try {
  const CodeMirrorView = require("@codemirror/view");
  Decoration = CodeMirrorView.Decoration;
  ViewPlugin = CodeMirrorView.ViewPlugin;
  WidgetTypeBase = CodeMirrorView.WidgetType || WidgetTypeBase;
} catch (error) {
  console.warn("Lacan Translation Helper: CodeMirror editor widgets are unavailable.", error);
}
const ObsidianBasesView = Obsidian.BasesView || class {};
const MarkdownRenderComponent = Component || class {
  load() {}
  unload() {}
};

const LESSON_FILE_RE = /^(?:Leçon|Lecon|lesson)-(\d+)\.md$/i;
const ORIGINAL_PATH_RE = /^texts\/([^/]+)\/original\/((?:Leçon|Lecon|lesson)-\d+\.md)$/i;
const TRANSLATION_PATH_RE = /^texts\/([^/]+)\/translation\/((?:Leçon|Lecon|lesson)-\d+\.md)$/i;
const READING_NOTE_PATH_RE = /^texts\/([^/]+)\/notes\/(.+\.md)$/i;
const SEGMENT_ID_ANCHOR_LINE_RE = /<!--\s*id\s*:?\s*(s\d+[a-z]?-\d+-\d+)\s*-->/i;
const SEGMENT_ID_COMMENT_RE = /<!--\s*ids?\b\s*:?\s*([\s\S]*?)-->/gi;
const SEGMENT_ID_TOKEN_RE = /\bs\d+b?-\d+-\d+\b/gi;
const SEGMENT_ID_LINK_RE = /^s(\d+[a-z]?)-(\d+)-\d+$/i;
const SEGMENT_ID_RE = /\bs\d+b?-\d+-(\d+)\b/gi;
const SEMINAR_RE = /<!--\s*seminar:\s*([^>\s]+)\s*-->/i;
const LESSON_RE = /<!--\s*lesson:\s*([^>\s]+)\s*-->/i;
const UNTRANSLATED_RE = /<!--\s*untranslated\s*-->/gi;
const MARKDOWN_RENDER_COMPONENT_KEY = "__lacanMarkdownRenderComponent";
const LACAN_LESSON_LIST_VIEW_TYPE = "lacan-lesson-list";
const LACAN_KNOWLEDGE_LIST_VIEW_TYPE = "lacan-knowledge-list";
const DEFAULT_PROJECT_ENDPOINT = "https://kotoba-rin.com/wp-json/lctp/v1/project";
const PROJECT_GRAPH_CARD_QUERY = String.raw`path:/^知识库\/[^\/]+\.md$/`;
const PROJECT_GRAPH_TRANSLATION_QUERY = String.raw`path:/^texts\/[^\/]+\/translation\/[^\/]+\.md$/`;
const PROJECT_GRAPH_QUERY = `(${PROJECT_GRAPH_CARD_QUERY} OR ${PROJECT_GRAPH_TRANSLATION_QUERY}) -file:/^(README|index|SUMMARY)(\\.md)?$/`;
const REASONING_EFFORT_LABELS = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "xHigh",
  max: "Max",
  ultra: "Ultra",
};

const DEFAULT_SETTINGS = {
  projectGraphEnabled: true,
  projectEndpointUrl: DEFAULT_PROJECT_ENDPOINT,
  projectSyncLastResult: null,
  projectLessonSync: {},
  projectKnowledgeFilters: {},
  autoSyncOnStartup: false,
  pluginHttpProxyEnabled: false,
  pluginHttpProxyUrl: "",
  segmentAiEnabled: false,
  segmentAiProvider: "codex",
  segmentAiCodexPath: "",
  segmentAiClaudePath: "",
  segmentAiDeepseekPath: "",
  segmentAiModel: "",
  segmentAiReasoningEffort: "",
  segmentAiPrompt: DEFAULT_INTERPRETATION_PROMPT,
  segmentAiModelCatalog: [],
  segmentAiModelCatalogUpdatedAt: 0,
  segmentAiSessions: [],
  segmentAiSchemaVersion: 2,
  segmentAiMaxOpenSessions: 3,
  segmentAiConversations: [],
  segmentAiWorkspace: {
    openConversationIds: [],
    activeConversationId: null,
  },
  segmentAiSkillCatalog: [],
  segmentAiSkillCatalogUpdatedAt: 0,
  frenchLookupEnabled: true,
  frenchLookupTrigger: "selection",
  frenchLookupAutoTranslate: true,
  frenchLookupSecretName: "lacan-eudic-api-token",
  frenchLookupWordbookId: "0",
  frenchLookupWordbooks: [],
};

class ReadingNoteButtonWidget extends WidgetTypeBase {
  constructor(plugin, sourcePath, segmentId) {
    super();
    this.plugin = plugin;
    this.sourcePath = sourcePath;
    this.segmentId = segmentId;
    this.aiEnabled = Boolean(plugin.settings?.segmentAiEnabled);
  }

  eq(other) {
    return (
      other.sourcePath === this.sourcePath
      && other.segmentId === this.segmentId
      && other.aiEnabled === this.aiEnabled
    );
  }

  toDOM() {
    const actions = document.createElement("span");
    actions.className = "lacan-segment-actions";

    if (this.plugin.isTranslationLessonPath(this.sourcePath)) {
      const noteButton = document.createElement("button");
      noteButton.className = "lacan-segment-note-button";
      noteButton.type = "button";
      noteButton.textContent = "记笔记";
      noteButton.title = `将 ${this.segmentId} 加入章节笔记`;
      noteButton.setAttribute("aria-label", `将 ${this.segmentId} 加入章节笔记`);
      // Keep CodeMirror's selection and focus when the pointer presses this widget.
      for (const eventName of ["pointerdown", "mousedown"]) {
        noteButton.addEventListener(eventName, (event) => {
          event.preventDefault();
          event.stopPropagation();
        });
      }
      noteButton.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.plugin.runWithNotice(
          () => this.plugin.createReadingNoteForSegment(this.sourcePath, this.segmentId),
          "记笔记失败"
        );
      });
      actions.appendChild(noteButton);
    }

    if (this.aiEnabled) {
      actions.appendChild(
        this.plugin.createSegmentAiButton(this.sourcePath, this.segmentId)
      );
    }
    return actions;
  }

  ignoreEvent() {
    return false;
  }
}

module.exports = class LacanTranslationHelper extends Plugin {
  async onload() {
    const loadedSettings = await this.loadData() || {};
    const legacySkillProfiles = Array.isArray(
      loadedSettings.segmentAiSkillProfiles
    )
      ? loadedSettings.segmentAiSkillProfiles
      : [];
    this.settings = Object.assign({}, DEFAULT_SETTINGS, loadedSettings);
    this.settings.frenchLookupEnabled = this.settings.frenchLookupEnabled !== false;
    this.settings.frenchLookupTrigger = this.settings.frenchLookupTrigger === "double-click" ? "double-click" : "selection";
    this.settings.frenchLookupAutoTranslate = this.settings.frenchLookupAutoTranslate !== false;
    this.settings.frenchLookupWordbooks = Array.isArray(this.settings.frenchLookupWordbooks)
      ? this.settings.frenchLookupWordbooks.filter((book) => book && typeof book.id === "string" && typeof book.name === "string")
      : [];
    this.settings.segmentAiPrompt = resolveConfiguredInterpretationPrompt({
      storedPrompt: loadedSettings.segmentAiPrompt,
      legacyProfiles: legacySkillProfiles,
      defaultProfileId: loadedSettings.segmentAiDefaultSkillProfileId,
    });
    this.settings.pluginHttpProxyEnabled = Object.hasOwn(loadedSettings, "pluginHttpProxyEnabled")
      ? loadedSettings.pluginHttpProxyEnabled === true
      : loadedSettings.githubProxyEnabled === true;
    this.settings.pluginHttpProxyUrl = String(loadedSettings.pluginHttpProxyUrl ?? loadedSettings.githubProxyUrl ?? "").trim();
    for (const key of ["forks", "mode", "repositoryUrl", "repositoryBranch", "upstreamLocalBranch", "githubProxyEnabled", "githubProxyUrl"]) delete this.settings[key];
    this.settings.projectEndpointUrl = String(this.settings.projectEndpointUrl || DEFAULT_PROJECT_ENDPOINT).trim();
    this.settings.projectLessonSync = this.settings.projectLessonSync && typeof this.settings.projectLessonSync === "object" && !Array.isArray(this.settings.projectLessonSync)
      ? this.settings.projectLessonSync : {};
    this.projectCatalog = null;
    this.projectCatalogViews = new Set();
    this.projectLessonSyncProgress = new Map();
    this.knowledgeLibrary = new KnowledgeLibrary(this);
    this.settings.segmentAiSessions = Array.isArray(this.settings.segmentAiSessions)
      ? this.settings.segmentAiSessions
      : [];
    this.settings.segmentAiMaxOpenSessions = normalizeMaxOpenSessions(
      this.settings.segmentAiMaxOpenSessions
    );
    this.settings.segmentAiConversations = Array.isArray(
      this.settings.segmentAiConversations
    )
      ? this.settings.segmentAiConversations
      : [];
    this.settings.segmentAiWorkspace = (
      this.settings.segmentAiWorkspace
      && typeof this.settings.segmentAiWorkspace === "object"
    )
      ? this.settings.segmentAiWorkspace
      : { openConversationIds: [], activeConversationId: null };
    delete this.settings.segmentAiSkillProfiles;
    delete this.settings.segmentAiDefaultSkillProfileId;
    delete this.settings.segmentAiCustomSkillRoot;
    this.settings.segmentAiSkillCatalog = (
      Array.isArray(this.settings.segmentAiSkillCatalog)
        ? this.settings.segmentAiSkillCatalog
        : []
    ).map(normalizeSkillMetadata).filter(Boolean);
    this.settings.segmentAiSkillCatalogUpdatedAt = Number.isFinite(
      this.settings.segmentAiSkillCatalogUpdatedAt
    )
      ? this.settings.segmentAiSkillCatalogUpdatedAt
      : 0;
    if (
      this.settings.segmentAiConversations.length === 0
      && this.settings.segmentAiSessions.length > 0
    ) {
      const migrated = InterpretationWorkspaceStore.migrateLegacy({
        legacySessions: this.settings.segmentAiSessions,
      });
      this.settings.segmentAiConversations = migrated.conversations;
      this.settings.segmentAiWorkspace = migrated.workspace;
      this.settings.segmentAiSchemaVersion = 2;
      this.settings.segmentAiSessions = [];
    }
    this.settings.segmentAiModelCatalog = normalizeCodexModelCatalog(
      this.settings.segmentAiModelCatalog
    );
    this.settings.segmentAiModel = String(
      this.settings.segmentAiModel || ""
    ).trim();
    this.settings.segmentAiReasoningEffort = normalizeProvider(this.settings.segmentAiProvider) === "codex" ? coerceCodexReasoningEffort(
      this.settings.segmentAiModelCatalog,
      this.settings.segmentAiModel,
      this.settings.segmentAiReasoningEffort
    ) : String(this.settings.segmentAiReasoningEffort || "").trim();
    this.settings.segmentAiModelCatalogUpdatedAt = Number.isFinite(
      this.settings.segmentAiModelCatalogUpdatedAt
    )
      ? this.settings.segmentAiModelCatalogUpdatedAt
      : 0;
    normalizeProviderSettings(this.settings);
    migrateMachineCliPaths(this.settings);
    this.progressTimers = new Map();
    this.readingToolbarRenderTimer = null;
    this.syncInProgress = false;
    this.projectSyncController = null;
    this.startupSyncTimer = null;
    this.createdFileTimers = new Set();
    this.projectGraphViews = new WeakSet();
    this.progressWritePaths = new Set();
    this.progressDirtyPaths = new Set();
    this.progressWriteSuppressTimers = new Map();
    this.segmentPreviewCache = new Map();
    this.segmentPreviewEl = null;
    this.segmentPreviewHideTimer = null;
    this.segmentPreviewRenderToken = 0;
    this.segmentAiState = {
      maxOpenSessions: this.settings.segmentAiMaxOpenSessions,
      openConversationIds: [],
      activeConversationId: null,
      conversations: [],
      runningCount: 0,
    };
    this.segmentAiRuntime = null;
    this.segmentAiController = null;
    this.segmentAiWorkspaceStore = null;
    this.segmentAiSkillCatalog = null;
    this.segmentAiSkillChangeUnsubscribe = null;
    this.segmentAiModelDiscoveryPromise = null;
    this.segmentAiSkillDiscoveryPromise = null;
    this.segmentAiEphemeralPersistTimer = null;

    this.registerView?.(
      LACAN_INTERPRETATION_VIEW_TYPE,
      (leaf) => new LacanInterpretationView(leaf, this)
    );
    this.registerView?.(
      LACAN_BILINGUAL_VIEW_TYPE,
      (leaf) => new LacanBilingualReadingView(leaf, this)
    );
    this.initializeSegmentAi();
    this.initializeFrenchLookup();
    this.initializeTranslationInlineEditing();
    registerPdfReading(this);
    await this.saveSettings();

    this.addSettingTab(new LacanTranslationHelperSettingTab(this.app, this));

    for (const [id, name, mode] of [
      ["lookup-french-selection", "法语取词：查询选区或光标处单词", "dictionary"],
      ["translate-french-selection", "法语取词：翻译选区并解释语法", "translation"],
    ]) {
      this.addCommand({ id, name, callback: () => this.frenchLookupPopup?.lookupCurrentSelection(mode) });
    }
    this.registerEvent(this.app.workspace.on("editor-menu", (menu, editor) => {
      if (!this.settings.frenchLookupEnabled || !editor.getSelection()?.trim()) { return; }
      menu.addItem((item) => item.setTitle("法语词典查词").setIcon("book-open")
        .onClick(() => this.frenchLookupPopup?.lookupCurrentSelection("dictionary")));
      menu.addItem((item) => item.setTitle("翻译选区并解释法语语法").setIcon("languages")
        .onClick(() => this.frenchLookupPopup?.lookupCurrentSelection("translation")));
    }));

    this.registerDomEvent(document, "click", (event) => {
      if (this.handleKnowledgeInternalLinkClick(event)) return;
      this.handleSegmentInternalLinkClick(event);
    }, { capture: true });
    this.registerDomEvent(document, "mouseover", (event) => {
      this.handleSegmentLinkPreviewEnter(event);
    }, { capture: true });
    this.registerDomEvent(document, "mouseout", (event) => {
      this.handleSegmentLinkPreviewLeave(event);
    }, { capture: true });
    this.registerDomEvent(document, "focusin", (event) => {
      this.handleSegmentLinkPreviewEnter(event);
    }, { capture: true });
    this.registerDomEvent(document, "focusout", (event) => {
      this.handleSegmentLinkPreviewLeave(event);
    }, { capture: true });

    this.registerReadingNoteEditorExtension();

    this.registerMarkdownPostProcessor((element, context) => {
      this.getKnowledgeLibrary().decorateLinks(element, context.sourcePath || "");
    });

    this.registerMarkdownPostProcessor((element, context) => {
      const sourcePath = normalizePath(context.sourcePath || "");
      if (!this.isTranslationLessonPath(sourcePath)
        || element.closest?.(".cm-editor, .markdown-source-view, .lacan-bilingual-content, .lacan-segment-preview")) return;
      const cleanup = bindTranslationPreview(element, context, {
        sourcePath,
        openEditor: ({ segmentId, renderedElements, element: anchorEl }) => this.openTranslationInlineEditor({
          sourcePath, segmentId,
          hostEl: renderedElements?.[0]?.parentElement || anchorEl?.parentElement || element,
          renderedEls: renderedElements,
        }),
      });
      if (!cleanup) return;
      this.translationPreviewCleanups.add(cleanup);
      if (Obsidian.MarkdownRenderChild && context.addChild) {
        const child = new Obsidian.MarkdownRenderChild(element);
        child.onunload = () => {
          cleanup();
          this.translationPreviewCleanups.delete(cleanup);
        };
        context.addChild(child);
      }
    });

    this.registerMarkdownPostProcessor((element, context) => {
      const path = normalizePath(context.sourcePath || "");
      if (!this.isReadingNotePath(path) || element.closest?.(".cm-editor, .markdown-source-view")) {
        return;
      }
      this.decorateRenderedSegmentLinks(element);
    });

    this.registerMarkdownPostProcessor((element, context) => {
      const path = normalizePath(context.sourcePath || "");
      if (!this.isTranslationLessonPath(path) || element.closest?.(".cm-editor, .markdown-source-view")) {
        return;
      }
      this.decorateRenderedReadingNoteLinks(element, path);
    });

    this.registerMarkdownPostProcessor((element, context) => {
      const path = normalizePath(context.sourcePath || "");
      if (
        !this.settings.segmentAiEnabled
        || !this.isSegmentAiLessonPath(path)
        || element.closest?.(".cm-editor, .markdown-source-view")
        || element.closest?.(".lacan-bilingual-content")
      ) {
        return;
      }
      this.renderSegmentAiPreviewActions(
        element,
        path,
        context.getSectionInfo?.(element)
      );
    });

    this.registerEvent(
      this.app.vault.on("create", (file) => {
        this.handleCreatedFile(file);
      })
    );

    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        this.handleModifiedFile(file);
      })
    );

    for (const eventName of ["create", "modify", "delete", "rename"]) {
      this.registerEvent(this.app.vault.on(eventName, (file, oldPath) => this.getKnowledgeLibrary().scheduleRefreshForChange(file, oldPath)));
    }
    this.registerEvent(this.app.workspace.on("editor-change", (_editor, info) =>
      this.getKnowledgeLibrary().scheduleRefreshForChange(info?.file || this.app.workspace.getActiveFile?.())));
    if (this.app.metadataCache?.on) this.registerEvent(this.app.metadataCache.on("changed", (file) => this.getKnowledgeLibrary().scheduleRefreshForChange(file)));

    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        this.addFileMenuItems(menu, file);
      })
    );

    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => {
        this.scheduleReadingToolbarRender();
      })
    );

    this.registerEvent(
      this.app.workspace.on("layout-change", () => {
        this.scheduleReadingToolbarRender();
        if (this.settings.projectGraphEnabled) {
          this.applyProjectGraphToViews();
        }
      })
    );

    this.registerEvent(
      this.app.workspace.on("file-open", () => {
        this.scheduleReadingToolbarRender();
      })
    );

    this.registerProjectBasesView();

    this.app.workspace.onLayoutReady(() => {
      if (this.settings.projectGraphEnabled) {
        this.runWithNotice(() => this.configureProjectGraph(), "项目关系图设置失败");
      }
    });

    this.addCommand({
      id: "open-project-graph",
      name: "打开知识卡片与翻译关系图",
      callback: () => this.runWithNotice(
        () => this.openProjectGraph(),
        "项目关系图打开失败"
      ),
    });

    this.addCommand({
      id: "create-translation-skeleton-from-active-file",
      name: "Create translation skeleton from active lesson",
      callback: () =>
        this.runWithNotice(
          () => this.createSkeletonFromActiveFile(),
          "译文骨架生成失败"
        ),
    });

    this.addCommand({
      id: "create-missing-translation-skeletons",
      name: "Batch create missing translation skeletons",
      callback: () =>
        this.runWithNotice(
          () => this.createMissingTranslationSkeletons(),
          "批量新建译文骨架失败"
        ),
    });

    this.addCommand({
      id: "update-all-translation-progress",
      name: "Update translation progress for all lessons",
      callback: () =>
        this.runWithNotice(
          () => this.updateAllTranslationProgress(),
          "翻译进度更新失败"
        ),
    });

    this.addCommand({
      id: "sync-configured-github-repositories",
      name: "更新文库目录（正文按需同步）",
      callback: () =>
        this.runWithNotice(
          () => this.syncConfiguredRepositories({ notify: true }),
          "文库同步失败"
        ),
    });

    this.addCommand({
      id: "open-project-library",
      name: "打开文库 Base（课文与知识库）",
      callback: () => this.runWithNotice(() => this.openProjectLibrary(), "打开文本清单失败"),
    });

    this.addCommand({
      id: "show-project-sync-conflicts",
      name: "查看文库同步与跳过记录",
      callback: () => this.runWithNotice(() => this.showProjectSyncReport(), "打开同步报告失败"),
    });

    this.scheduleReadingToolbarRender();
    this.refreshSegmentAiEntrances();

    this.app.workspace.onLayoutReady(() => {
      void this.runWithNotice(() => this.initializeProjectLibrary(), "文库清单初始化失败");
    });
  }

  onunload() {
    this.translationInlineEditor?.destroy();
    this.translationInlineEditor = null;
    for (const cleanup of this.translationPreviewCleanups || []) cleanup();
    this.translationPreviewCleanups?.clear();
    this.frenchLookupPopup?.destroy();
    this.frenchLookupTranslator?.destroy();
    if (this.startupSyncTimer) {
      window.clearTimeout(this.startupSyncTimer);
      this.startupSyncTimer = null;
    }
    for (const timer of this.createdFileTimers) {
      window.clearTimeout(timer);
    }
    this.createdFileTimers.clear();
    for (const timer of this.progressTimers.values()) {
      window.clearTimeout(timer);
    }
    this.progressTimers.clear();
    for (const timer of this.progressWriteSuppressTimers.values()) {
      window.clearTimeout(timer);
    }
    this.progressWriteSuppressTimers.clear();
    this.progressWritePaths.clear();
    this.progressDirtyPaths.clear();
    this.removeSegmentAiPreviewControls();
    this.hideSegmentPreview();
    if (this.segmentPreviewHideTimer) {
      window.clearTimeout(this.segmentPreviewHideTimer);
      this.segmentPreviewHideTimer = null;
    }
    this.segmentPreviewCache.clear();

    if (this.readingToolbarRenderTimer) {
      window.clearTimeout(this.readingToolbarRenderTimer);
      this.readingToolbarRenderTimer = null;
    }
    this.removeReadingToolbars();
    this.segmentAiSkillChangeUnsubscribe?.();
    this.segmentAiSkillChangeUnsubscribe = null;
    if (this.segmentAiEphemeralPersistTimer) {
      clearTimeout(this.segmentAiEphemeralPersistTimer);
      this.segmentAiEphemeralPersistTimer = null;
      void this.persistSegmentAiWorkspaceSnapshot();
    }
    if (this.segmentAiRuntime) {
      void this.segmentAiRuntime.shutdown();
      this.segmentAiRuntime = null;
      this.segmentAiController = null;
    }
    this.projectSyncController?.abort();
    this.projectSyncController = null;
    this.projectCatalogViews?.clear();
    this.knowledgeLibrary?.dispose();
    this.pluginRequest?.dispose();
    this.pluginRequest = null;
  }

  getProjectGraphOptions(options = {}) {
    return {
      ...options,
      search: PROJECT_GRAPH_QUERY,
      showTags: false,
      showAttachments: false,
      hideUnresolved: true,
      showOrphans: false,
      colorGroups: [
        { query: PROJECT_GRAPH_CARD_QUERY, color: { a: 1, rgb: 0x57c785 } },
        { query: PROJECT_GRAPH_TRANSLATION_QUERY, color: { a: 1, rgb: 0x6aa9e9 } },
      ],
    };
  }

  applyProjectGraphToViews({ force = false } = {}) {
    for (const leaf of this.app.workspace.getLeavesOfType("graph")) {
      const view = leaf.view;
      // The core graph API is internal: guard it for unsupported Obsidian versions.
      const engine = view?.dataEngine;
      if (!engine?.setOptions || !engine?.getOptions) continue;
      if (!force && this.projectGraphViews.has(view)) continue;
      // Mark before updating: rendering can trigger another layout-change event.
      this.projectGraphViews.add(view);
      engine.setOptions(this.getProjectGraphOptions(engine.getOptions()));
    }
  }

  async configureProjectGraph({ force = false } = {}) {
    const graph = this.app.internalPlugins?.getPluginById?.("graph");
    if (!graph?.enabled || !graph.instance?.saveOptions) return false;
    graph.instance.options = this.getProjectGraphOptions(graph.instance.options);
    graph.instance.saveOptions();
    this.applyProjectGraphToViews({ force });
    return true;
  }

  async openProjectGraph() {
    if (!await this.configureProjectGraph({ force: true })) {
      throw new Error("请先在 Obsidian 核心插件中启用关系图谱。");
    }
    const leaf = this.app.workspace.getLeavesOfType("graph")[0]
      || this.app.workspace.getLeaf("tab");
    if (leaf.view?.getViewType?.() !== "graph") {
      await leaf.setViewState({ type: "graph", active: true });
    }
    await this.app.workspace.revealLeaf(leaf);
    this.applyProjectGraphToViews({ force: true });
    if (typeof leaf.view?.dataEngine?.setOptions !== "function") {
      throw new Error("当前 Obsidian 版本不支持自动设置图谱，请在图谱筛选中手动设置范围。");
    }
  }

  registerProjectBasesView() {
    if (typeof this.registerBasesView !== "function" || !Obsidian.BasesView) {
      console.warn("Lacan Translation Helper: Obsidian Bases view API is unavailable.");
      return;
    }

    const KnowledgeBasesView = createKnowledgeBasesViewClass(ObsidianBasesView);
    this.registerBasesView(LACAN_KNOWLEDGE_LIST_VIEW_TYPE, {
      name: "知识库",
      icon: "library",
      factory: (controller, containerEl) => new KnowledgeBasesView(controller, containerEl, this),
    });
    this.registerBasesView(LACAN_LESSON_LIST_VIEW_TYPE, {
      name: "Lacan Lesson List",
      icon: "list-tree",
      factory: (controller, containerEl) => new LacanLessonListBasesView(controller, containerEl, this),
    });
  }

  initializeSegmentAi() {
    try {
      this.segmentAiWorkspaceStore = new InterpretationWorkspaceStore({
        conversations: this.settings.segmentAiConversations,
        workspace: this.settings.segmentAiWorkspace,
        maxOpenSessions: this.settings.segmentAiMaxOpenSessions,
      });
      this.segmentAiRuntime = this.createSegmentAiRuntime();
      const provider = normalizeProvider(this.settings.segmentAiProvider);
      const runtime = this.segmentAiRuntime;
      this.segmentAiSkillCatalog = new CodexSkillCatalog({
        vaultRoot: this.getVaultBasePath(),
        runtime: this.segmentAiRuntime,
        initialSkills: this.settings.segmentAiSkillCatalog,
      });
      this.segmentAiSkillChangeUnsubscribe?.();
      this.segmentAiSkillChangeUnsubscribe =
        this.segmentAiRuntime.onSkillsChanged?.(() => {
          this.segmentAiSkillCatalog?.invalidate?.();
        }) || null;
      this.segmentAiController = new InterpretationWorkspaceController({
        resolver: createObsidianContextResolver(this.app),
        promptBuilder: new InterpretationPromptBuilder({
          interpretationPrompt: this.settings.segmentAiPrompt,
        }),
        store: this.segmentAiWorkspaceStore,
        runtime: this.segmentAiRuntime,
        skillCatalog: this.segmentAiSkillCatalog,
        onState: (state) => {
          if (this.segmentAiRuntime === runtime) this.updateSegmentAiState(state);
        },
        persistWorkspace: async ({ conversations, workspace }) => {
          if (this.segmentAiRuntime !== runtime
            || normalizeProvider(this.settings.segmentAiProvider) !== provider) return;
          this.settings.segmentAiConversations = conversations;
          this.settings.segmentAiWorkspace = workspace;
          this.settings.segmentAiSchemaVersion = 2;
          await this.saveSettings();
        },
      });
      this.updateSegmentAiState(this.segmentAiWorkspaceStore.snapshot());
    } catch (error) {
      this.segmentAiRuntime = null;
      this.segmentAiController = null;
      this.updateSegmentAiState({
        maxOpenSessions: this.settings.segmentAiMaxOpenSessions,
        openConversationIds: [],
        activeConversationId: null,
        conversations: [],
        runningCount: 0,
        workspaceError: {
          code: error?.code || "AppServerIncompatible",
          message: error?.message || "当前 Vault 无法初始化本地 Agent。",
        },
      });
    }
  }

  initializeFrenchLookup() {
    this.frenchLookupPopup?.destroy();
    this.frenchLookupTranslator?.destroy();
    this.frenchDictionaryService = new FrenchDictionaryService({
      requestUrl: this.getPluginRequest(),
      getToken: () => this.getEudicToken(),
    });
    this.frenchLookupTranslator = new FrenchSelectionTranslator({
      getReasoningEffort: () => normalizeProvider(this.settings.segmentAiProvider) === "deepseek" ? "" : "low",
      createRuntime: () => this.createSegmentAiRuntime({
        defaultReasoningEffort: "low",
        ephemeralThreads: true,
        requestTimeoutMs: 15000,
        turnTimeoutMs: 60000,
      }),
    });
    this.frenchLookupPopup = new FrenchLookupPopup(this, {
      service: this.frenchDictionaryService,
      translate: (lookup, options) => this.frenchLookupTranslator.translate(lookup, options),
      createMenu: () => new Obsidian.Menu(),
    });
    this.frenchLookupPopup.start();
  }

  getEudicToken() {
    const name = String(this.settings.frenchLookupSecretName || "lacan-eudic-api-token");
    return this.app.secretStorage?.getSecret(name) || this.eudicSessionToken || "";
  }

  async setSegmentAiCodexPath(value) {
    return this.setSegmentAiCliPath("codex", value);
  }

  getSegmentAiCliPath(provider = this.settings.segmentAiProvider) {
    return getMachineCliPath(this.settings, normalizeProvider(provider));
  }

  createSegmentAiRuntime(overrides = {}) {
    const provider = normalizeProvider(this.settings.segmentAiProvider);
    const Runtime = provider === "codex" ? CodexAppServerRuntime : CliAgentRuntime;
    return new Runtime({
      provider,
      vaultRoot: this.getVaultBasePath(),
      pluginVersion: this.manifest?.version || "0.0.0",
      cliPath: this.getSegmentAiCliPath(provider),
      defaultModel: provider === "deepseek" ? "" : this.settings.segmentAiModel || "",
      defaultReasoningEffort: this.settings.segmentAiReasoningEffort || "",
      ...overrides,
      ...(provider === "deepseek" ? { defaultModel: "", defaultReasoningEffort: "" } : {}),
    });
  }

  setSegmentAiProvider(value) {
    const task = (this.segmentAiProviderSwitchPromise || Promise.resolve())
      .catch(() => {})
      .then(() => this.performSegmentAiProviderSwitch(value));
    this.segmentAiProviderSwitchPromise = task;
    const clear = () => {
      if (this.segmentAiProviderSwitchPromise === task) this.segmentAiProviderSwitchPromise = null;
    };
    task.then(clear, clear);
    return task;
  }

  async performSegmentAiProviderSwitch(value) {
    const provider = normalizeProvider(value);
    if (provider === normalizeProvider(this.settings.segmentAiProvider)) return;
    // Finish the old controller's last persistence before changing active profiles.
    if (this.segmentAiEphemeralPersistTimer) {
      clearTimeout(this.segmentAiEphemeralPersistTimer);
      this.segmentAiEphemeralPersistTimer = null;
    }
    await this.segmentAiRuntime?.shutdown();
    await this.persistSegmentAiWorkspaceSnapshot();
    this.segmentAiRuntime = null;
    switchProviderSettings(this.settings, provider);
    await this.saveSettings();
    this.frenchLookupTranslator?.destroy();
    await this.resetSegmentAiRuntime();
  }

  setSegmentAiCliPath(provider, value) {
    const task = (this.segmentAiProviderSwitchPromise || Promise.resolve())
      .catch(() => {})
      .then(() => this.performSetSegmentAiCliPath(provider, value));
    this.segmentAiProviderSwitchPromise = task;
    const clear = () => {
      if (this.segmentAiProviderSwitchPromise === task) this.segmentAiProviderSwitchPromise = null;
    };
    task.then(clear, clear);
    return task;
  }

  async performSetSegmentAiCliPath(provider, value) {
    provider = normalizeProvider(provider);
    const cliPath = String(value || "").trim();
    if (cliPath === this.getSegmentAiCliPath(provider)) return;
    setMachineCliPath(this.settings, provider, cliPath);
    if (this.segmentAiCliDetections) delete this.segmentAiCliDetections[provider];
    if (provider !== normalizeProvider(this.settings.segmentAiProvider)) {
      const profile = this.settings.segmentAiProviderProfiles?.[provider];
      if (profile) {
        profile.segmentAiModelCatalog = [];
        profile.segmentAiModelCatalogUpdatedAt = 0;
        profile.segmentAiSkillCatalog = [];
        profile.segmentAiSkillCatalogUpdatedAt = 0;
      }
      await this.saveSettings();
      return;
    }
    this.segmentAiModelDiscoveryPromise = null;
    this.settings.segmentAiModelCatalog = [];
    this.settings.segmentAiModelCatalogUpdatedAt = 0;
    this.settings.segmentAiSkillCatalog = [];
    this.settings.segmentAiSkillCatalogUpdatedAt = 0;
    await this.saveSettings();
    this.frenchLookupTranslator?.destroy();
    await this.resetSegmentAiRuntime();
  }

  async discoverSegmentAiCli(provider) {
    provider = normalizeProvider(provider);
    this.segmentAiCliDetections ||= {};
    const configuredPath = this.getSegmentAiCliPath(provider);
    const state = { status: "checking", configuredPath };
    this.segmentAiCliDetections[provider] = state;
    try {
      const result = await discoverCli(provider, { configuredPath });
      Object.assign(state, { status: "ready", path: result.path, version: result.version, source: result.source, versionError: result.versionError });
    } catch (error) {
      Object.assign(state, { status: "failed", message: error.message });
    }
    return state;
  }

  async resetSegmentAiRuntime() {
    this.segmentAiModelDiscoveryPromise = null;
    if (this.segmentAiRuntime) {
      await this.segmentAiRuntime.shutdown();
    }
    this.segmentAiSkillChangeUnsubscribe?.();
    this.segmentAiSkillChangeUnsubscribe = null;
    this.segmentAiRuntime = null;
    this.segmentAiController = null;
    this.segmentAiWorkspaceStore = null;
    this.segmentAiSkillCatalog = null;
    this.segmentAiSkillDiscoveryPromise = null;
    this.initializeSegmentAi();
    this.refreshSegmentAiEntrances();
  }

  getSegmentAiModelCatalog() {
    return normalizeCodexModelCatalog(this.settings.segmentAiModelCatalog);
  }

  async discoverSegmentAiModels() {
    if (this.segmentAiModelDiscoveryPromise) {
      return this.segmentAiModelDiscoveryPromise;
    }
    const discovery = (async () => {
      if (!this.segmentAiRuntime) {
        this.initializeSegmentAi();
      }
      if (!this.segmentAiRuntime) {
        throw new Error("本地 Agent 运行时尚未初始化。");
      }
      const runtime = this.segmentAiRuntime;
      const models = await runtime.listModels();
      if (
        this.segmentAiRuntime !== runtime
        || this.segmentAiModelDiscoveryPromise !== discovery
      ) {
        throw new Error("Agent 配置已变化，请刷新当前 Agent 的模型与推理强度。");
      }
      this.settings.segmentAiModelCatalog = models;
      this.settings.segmentAiReasoningEffort = coerceCodexReasoningEffort(
        models,
        this.settings.segmentAiModel,
        this.settings.segmentAiReasoningEffort
      );
      runtime.defaultReasoningEffort =
        this.settings.segmentAiReasoningEffort;
      this.settings.segmentAiModelCatalogUpdatedAt = Date.now();
      await this.saveSettings();
      return models;
    })();
    this.segmentAiModelDiscoveryPromise = discovery;
    try {
      return await discovery;
    } finally {
      if (this.segmentAiModelDiscoveryPromise === discovery) {
        this.segmentAiModelDiscoveryPromise = null;
      }
    }
  }

  async discoverSegmentAiSkills({ forceReload = true } = {}) {
    if (this.segmentAiSkillDiscoveryPromise) {
      return this.segmentAiSkillDiscoveryPromise;
    }
    const discovery = (async () => {
      if (!this.segmentAiRuntime || !this.segmentAiSkillCatalog) {
        this.initializeSegmentAi();
      }
      const catalog = this.segmentAiSkillCatalog;
      if (!catalog) {
        throw new Error("本地 Agent 的 Skill 清单尚未初始化。");
      }
      const skills = await catalog.refresh({ forceReload });
      if (this.segmentAiSkillCatalog !== catalog) {
        throw new Error("Agent 配置已变化，请刷新当前 Agent 的 Skills。");
      }
      this.settings.segmentAiSkillCatalog = skills;
      this.settings.segmentAiSkillCatalogUpdatedAt = Date.now();
      await this.saveSettings();
      return skills;
    })();
    this.segmentAiSkillDiscoveryPromise = discovery;
    try {
      return await discovery;
    } finally {
      if (this.segmentAiSkillDiscoveryPromise === discovery) {
        this.segmentAiSkillDiscoveryPromise = null;
      }
    }
  }

  updateSegmentAiState(state) {
    this.segmentAiState = state || { status: "empty" };
    const leaves = this.app.workspace?.getLeavesOfType?.(LACAN_INTERPRETATION_VIEW_TYPE) || [];
    for (const leaf of leaves) {
      leaf.view?.setState?.(this.segmentAiState);
    }
  }

  async openSegmentInterpretationView() {
    let leaf = this.app.workspace.getLeavesOfType?.(LACAN_INTERPRETATION_VIEW_TYPE)?.[0];
    if (!leaf) {
      leaf = this.app.workspace.getRightLeaf?.(false)
        || this.app.workspace.getLeaf?.("split", "vertical");
      if (!leaf) {
        throw new Error("无法打开右侧 Lacan AI 栏。");
      }
      await leaf.setViewState({
        type: LACAN_INTERPRETATION_VIEW_TYPE,
        active: true,
      });
    }
    leaf.view?.setState?.(this.segmentAiState);
    await this.app.workspace.revealLeaf?.(leaf);
    return leaf;
  }

  async interpretSegment(sourcePath, segmentId, {
    forceNew = false,
  } = {}) {
    if (!this.settings.segmentAiEnabled) {
      new Notice("AI 功能尚未启用，可在 Lacan Translation Helper 的“AI 功能”设置中打开。");
      return { state: "disabled" };
    }
    try {
      await this.openSegmentInterpretationView();
      if (!this.segmentAiController) {
        this.initializeSegmentAi();
      }
      if (!this.segmentAiController) {
        return {
          state: "failed",
          error: this.segmentAiState.error || {
            code: "AppServerIncompatible",
            message: "本地 Agent 初始化失败。",
          },
        };
      }
      const result = await this.segmentAiController.interpret(
        normalizePath(sourcePath || ""),
        String(segmentId || "").trim().toLowerCase(),
        {
          model: this.settings.segmentAiModel || "",
          effort: this.settings.segmentAiReasoningEffort || "",
          forceNew,
        }
      );
      if (result?.state === "failed" && !result.conversationId) {
        new Notice(`AI 功能未启动：${result.error?.message || "未知错误"}`);
      }
      return result;
    } catch (error) {
      const normalizedError = {
        code: error?.code || "Unknown",
        message: error?.message || "无法运行分段 AI 功能。",
      };
      this.updateSegmentAiState({
        ...(this.segmentAiState || {}),
        workspaceError: normalizedError,
      });
      new Notice(`AI 功能失败：${normalizedError.message}`);
      return { state: "failed", error: normalizedError };
    }
  }

  activeSegmentAiConversationId() {
    return this.segmentAiState?.activeConversationId || null;
  }

  async retrySegmentInterpretation(conversationId = this.activeSegmentAiConversationId()) {
    if (!this.segmentAiController) {
      return { state: "failed" };
    }
    return this.segmentAiController.retry(conversationId);
  }

  async followUpSegmentInterpretation(conversationId, question) {
    if (!this.segmentAiController) {
      return { state: "failed" };
    }
    if (question === undefined) {
      question = conversationId;
      conversationId = this.activeSegmentAiConversationId();
    }
    const result = await this.segmentAiController.followUp(
      conversationId,
      question
    );
    if (["busy", "empty"].includes(result?.state)) {
      new Notice(result.error?.message || "当前问题尚未发送。");
    }
    return result;
  }

  async stopSegmentInterpretation(
    conversationId = this.activeSegmentAiConversationId()
  ) {
    return this.segmentAiController?.stop?.(conversationId) || false;
  }

  async activateSegmentAiConversation(conversationId) {
    if (!this.segmentAiController) {
      return null;
    }
    return this.runSegmentAiConversationAction(
      () => this.segmentAiController.activate(conversationId),
      "无法打开会话"
    );
  }

  async closeSegmentAiConversation(conversationId) {
    return this.runSegmentAiConversationAction(
      () => this.segmentAiController?.close?.(conversationId) || false,
      "无法关闭会话"
    );
  }

  async deleteSegmentAiConversation(conversationId) {
    return this.runSegmentAiConversationAction(
      () => this.segmentAiController?.delete?.(conversationId) || false,
      "无法删除会话"
    );
  }

  async clearAllSegmentAiConversations() {
    return this.runSegmentAiConversationAction(
      () => this.segmentAiController?.clearAll?.() || 0,
      "无法清空全部会话"
    );
  }

  async renameSegmentAiConversation(conversationId, title) {
    return this.runSegmentAiConversationAction(
      () => this.segmentAiController?.rename?.(conversationId, title) || null,
      "无法重命名会话"
    );
  }

  async runSegmentAiConversationAction(action, label) {
    try {
      return await action();
    } catch (error) {
      new Notice(`${label}：${error?.message || "未知错误"}`);
      return {
        state: "failed",
        error: {
          code: error?.code || "Unknown",
          message: error?.message || label,
        },
      };
    }
  }

  updateSegmentAiDraft(conversationId, draft) {
    this.segmentAiWorkspaceStore?.updateDraft?.(conversationId, draft);
    this.scheduleSegmentAiWorkspacePersist();
  }

  updateSegmentAiScroll(conversationId, scroll) {
    this.segmentAiWorkspaceStore?.updateScroll?.(conversationId, scroll);
    this.scheduleSegmentAiWorkspacePersist();
  }

  scheduleSegmentAiWorkspacePersist() {
    if (this.segmentAiEphemeralPersistTimer) {
      clearTimeout(this.segmentAiEphemeralPersistTimer);
    }
    this.segmentAiEphemeralPersistTimer = setTimeout(() => {
      this.segmentAiEphemeralPersistTimer = null;
      void this.persistSegmentAiWorkspaceSnapshot();
    }, 450);
  }

  async persistSegmentAiWorkspaceSnapshot() {
    if (!this.segmentAiWorkspaceStore) {
      return;
    }
    const { conversations, workspace } =
      this.segmentAiWorkspaceStore.serialize();
    this.settings.segmentAiConversations = conversations;
    this.settings.segmentAiWorkspace = workspace;
    this.settings.segmentAiSchemaVersion = 2;
    await this.saveSettings();
  }

  getSegmentAiDiagnostics() {
    const activeConversation = this.segmentAiState?.conversations?.find(
      (conversation) => (
        conversation.id === this.segmentAiState.activeConversationId
      )
    );
    return {
      pluginId: this.manifest?.id || "lacan-translation-helper",
      pluginVersion: this.manifest?.version || "unknown",
      enabled: Boolean(this.settings.segmentAiEnabled),
      provider: normalizeProvider(this.settings.segmentAiProvider),
      status: activeConversation?.status || "empty",
      errorCode: activeConversation?.error?.code || null,
      openConversationCount:
        this.segmentAiState?.openConversationIds?.length || 0,
      runningTurnCount: this.segmentAiState?.runningCount || 0,
      segment: activeConversation
        ? {
            requestedId: activeConversation.requestedId,
            primaryId: activeConversation.primaryId,
            contextHash: activeConversation.contextHash,
          }
        : null,
      runtime: this.segmentAiRuntime?.getDiagnostics?.() || null,
    };
  }

  async openSegmentSource(sourcePath, segmentId) {
    return this.openSegmentId(segmentId, sourcePath);
  }

  initializeTranslationInlineEditing() {
    this.translationPreviewCleanups = new Set();
    this.translationInlineEditor = new TranslationInlineEditor({
      readSegment: async (sourcePath, segmentId) => {
        if (!this.isTranslationLessonPath(sourcePath)) throw new Error("只能编辑中文译文课文。");
        const file = this.app.vault.getAbstractFileByPath(sourcePath);
        if (!(file instanceof TFile)) throw new Error(`找不到译文文件：${sourcePath}`);
        return { ...readTranslationSegment(await this.app.vault.read(file), segmentId), sourcePath, segmentId };
      },
      saveSegment: async (snapshot, markdown) => {
        if (!this.isTranslationLessonPath(snapshot.sourcePath)) throw new Error("只能编辑中文译文课文。");
        const file = this.app.vault.getAbstractFileByPath(snapshot.sourcePath);
        if (!(file instanceof TFile)) throw new Error("译文文件已移动或删除，请重新打开后编辑。");
        await this.app.vault.process(file, (currentText) => replaceTranslationSegment(currentText, snapshot, markdown));
      },
      saveImage: (image, sourcePath) => this.saveTranslationInlineImage(image, sourcePath),
      onSaved: async ({ sourcePath }) => {
        this.segmentPreviewCache?.clear();
        const updates = [];
        this.app.workspace.iterateAllLeaves?.((leaf) => {
          const view = leaf.view;
          if (view?.getViewType?.() === LACAN_BILINGUAL_VIEW_TYPE
            && view.lessonPaths?.()?.translationPath === sourcePath) updates.push(view.render());
          else if (view?.file?.path === sourcePath) updates.push(this.rerenderPreview(view));
        });
        await Promise.all(updates);
        new Notice("中文译文已保存到 Markdown。");
      },
      onClosed: () => {
        for (const leaf of this.app.workspace.getLeavesOfType?.(LACAN_BILINGUAL_VIEW_TYPE) || []) {
          if (leaf.view.pendingInlineRefresh) void leaf.view.render();
        }
      },
      notify: (message) => new Notice(message),
    });
  }

  async saveTranslationInlineImage(image, sourcePath) {
    if (!this.isTranslationLessonPath(sourcePath)) throw new Error("只能编辑中文译文课文。");
    const sourceFile = this.app.vault.getAbstractFileByPath(sourcePath);
    if (!(sourceFile instanceof TFile)) throw new Error("译文文件已移动或删除，请重新打开后编辑。");
    const extensions = {
      "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif",
      "image/webp": "webp", "image/bmp": "bmp", "image/svg+xml": "svg",
      "image/avif": "avif", "image/tiff": "tiff", "image/x-icon": "ico",
    };
    const extension = extensions[image.type];
    if (!extension) throw new Error(`暂不支持这种图片格式：${image.type || "未知格式"}`);
    let name = String(image.name || "").split(/[\\/]/).pop().replace(/[<>:"|?*\u0000-\u001f]/g, "");
    if (!name || /^image\.[^.]+$/i.test(name)) {
      const now = new Date();
      const timestamp = [now.getFullYear(), now.getMonth() + 1, now.getDate(), now.getHours(), now.getMinutes(), now.getSeconds()]
        .map((part, index) => index ? String(part).padStart(2, "0") : String(part)).join("");
      name = `Pasted image ${timestamp}.${extension}`;
    } else if (!/\.(?:png|jpe?g|gif|webp|bmp|svg|avif|tiff?|ico)$/i.test(name)) {
      name += `.${extension}`;
    }
    const data = await image.arrayBuffer();
    const path = await this.app.fileManager.getAvailablePathForAttachment(name, sourcePath);
    const file = await this.app.vault.createBinary(path, data);
    return "!" + this.app.fileManager.generateMarkdownLink(file, sourcePath);
  }

  openTranslationInlineEditor(options) {
    if (!this.translationInlineEditor) return;
    this.frenchLookupPopup?.close();
    return this.translationInlineEditor.open(options);
  }

  bindTranslationBlockEditing(bodyEl, sourcePath, segmentId) {
    if (!this.isTranslationLessonPath(sourcePath)) return;
    bodyEl.addClass("lacan-translation-editable");
    bodyEl.setAttribute("title", "双击编辑整段中文译文、注释和建言");
    bodyEl.addEventListener("dblclick", (event) => {
      const target = event.target?.nodeType === 3 ? event.target.parentElement : event.target;
      if (target?.closest?.("a, button, input, textarea, select, .footnotes, .footnote-ref, .lacan-translation-inline-editor")) return;
      event.preventDefault();
      event.stopPropagation();
      const renderedEls = Array.from(bodyEl.children).filter((element) => (
        !element.matches(".footnotes")
        && !(element.matches("p") && Array.from(element.children).some((child) => (
          child.matches("a.internal-link") && /^(?:阅读笔记|s\d+[a-z]?-\d+)$/.test(child.textContent.trim())
          && element.textContent.trim() === child.textContent.trim()
        )))
      ));
      void this.openTranslationInlineEditor({ sourcePath, segmentId, hostEl: bodyEl, renderedEls });
    }, { capture: true });
  }

  isInsideCommentaryBlockquote(node) {
    const element = typeof node?.closest === "function"
      ? node
      : node?.parentElement || node?.parentNode;
    return Boolean(element?.closest?.("blockquote"));
  }

  renderSegmentAiPreviewActions(containerEl, sourcePath, sectionInfo = null) {
    if (
      !this.settings.segmentAiEnabled
      || !containerEl
      || this.isInsideCommentaryBlockquote(containerEl)
    ) {
      return 0;
    }
    const path = normalizePath(sourcePath || "");
    const markers = this.extractSegmentMarkers(sectionInfo?.text || "");
    if (markers.length === 0) {
      return this.renderCommentAnchoredSegmentAiActions(containerEl, path);
    }

    const existingIds = new Set(
      Array.from(containerEl.querySelectorAll?.(
        ".lacan-segment-ai-control[data-segment-id]"
      ) || []).map((element) => element.dataset.segmentId)
    );
    const uniqueMarkers = markers.filter((marker, index) => (
      markers.findIndex((candidate) => candidate.id === marker.id) === index
    ));
    if (uniqueMarkers.length === 1) {
      const marker = uniqueMarkers[0];
      if (!existingIds.has(marker.id)) {
        containerEl.prepend(this.createSegmentAiPreviewControl(path, marker.id));
      }
      return 1;
    }

    let inserted = 0;
    const usedAnchors = new Set();
    const anchorIndex = this.buildRenderedAnchorIndex(containerEl);
    const lineOffset = this.sectionLineOffset(sectionInfo);
    for (const marker of uniqueMarkers) {
      if (existingIds.has(marker.id)) {
        inserted += 1;
        continue;
      }
      const adjustedMarker = {
        ...marker,
        line: marker.line + lineOffset,
        nextLine: marker.nextLine === null ? null : marker.nextLine + lineOffset,
      };
      const anchorEl = this.findRenderedSegmentAnchor(
        containerEl,
        adjustedMarker,
        usedAnchors,
        anchorIndex
      );
      if (
        !anchorEl?.parentNode
        || this.isInsideCommentaryBlockquote(anchorEl)
      ) {
        continue;
      }
      const controlEl = this.createSegmentAiPreviewControl(path, marker.id);
      anchorEl.parentNode.insertBefore(controlEl, anchorEl);
      usedAnchors.add(anchorEl);
      inserted += 1;
    }
    return inserted;
  }

  renderCommentAnchoredSegmentAiActions(containerEl, sourcePath) {
    if (
      typeof document === "undefined"
      || typeof document.createTreeWalker !== "function"
      || typeof NodeFilter === "undefined"
    ) {
      return 0;
    }
    const walker = document.createTreeWalker(containerEl, NodeFilter.SHOW_COMMENT);
    let inserted = 0;
    let commentNode;
    while ((commentNode = walker.nextNode()) !== null) {
      const segmentId = this.segmentIdFromComment(commentNode.nodeValue);
      if (
        !segmentId
        || !commentNode.parentNode
        || this.isInsideCommentaryBlockquote(commentNode)
      ) {
        continue;
      }
      const exists = Array.from(containerEl.querySelectorAll?.(
        ".lacan-segment-ai-control[data-segment-id]"
      ) || []).some((element) => element.dataset.segmentId === segmentId);
      if (exists) {
        continue;
      }
      commentNode.parentNode.insertBefore(
        this.createSegmentAiPreviewControl(sourcePath, segmentId),
        commentNode.nextSibling
      );
      inserted += 1;
    }
    return inserted;
  }

  createSegmentAiPreviewControl(sourcePath, segmentId) {
    const controlEl = document.createElement("div");
    controlEl.className = "lacan-segment-ai-control";
    controlEl.dataset.segmentId = segmentId;
    controlEl.appendChild(this.createSegmentAiButton(sourcePath, segmentId, {
      includeSegmentId: true,
    }));
    return controlEl;
  }

  createSegmentAiButton(sourcePath, segmentId, { includeSegmentId = false } = {}) {
    const button = document.createElement("button");
    const isOriginal = this.isOriginalLessonPath(sourcePath);
    const actionLabel = isOriginal ? "原文解析" : "AI 解读";
    button.className = `lacan-segment-ai-button${
      includeSegmentId ? " has-segment-id" : ""
    }`;
    button.type = "button";
    button.textContent = includeSegmentId ? `【${segmentId}】 Ф` : "Ф";
    button.title = `${actionLabel} · ${segmentId}`;
    button.setAttribute(
      "aria-label",
      `为 ${segmentId} 运行${actionLabel}`
    );
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      void this.interpretSegment(sourcePath, segmentId);
    });
    return button;
  }

  removeSegmentAiPreviewControls() {
    const rootEl = this.app.workspace?.containerEl || document.body;
    rootEl.querySelectorAll?.(".lacan-segment-ai-control").forEach(
      (element) => element.remove()
    );
  }

  refreshSegmentAiEntrances() {
    this.removeSegmentAiPreviewControls();
    this.app.workspace?.updateOptions?.();
    this.app.workspace?.iterateAllLeaves?.((leaf) => {
      leaf.view?.previewMode?.rerender?.(true);
    });
    this.refreshBilingualReadingViews();
  }

  refreshBilingualReadingViews() {
    for (const leaf of this.app.workspace.getLeavesOfType?.(LACAN_BILINGUAL_VIEW_TYPE) || []) {
      void leaf.view?.render?.();
    }
  }

  async openBilingualReading(sourcePath, sourceLeaf = this.app.workspace.activeLeaf) {
    const path = normalizePath(sourcePath || "");
    if (!this.isSegmentAiLessonPath(path)) {
      throw new Error("双语阅读仅适用于研讨班原文或译文课文。");
    }
    const leaf = sourceLeaf || this.app.workspace.getLeaf(false);
    if (leaf.view?.getViewType?.() === LACAN_BILINGUAL_VIEW_TYPE) return;
    const readingPosition = await this.captureReadingPosition(leaf.view, path);
    await leaf.setViewState({
      type: LACAN_BILINGUAL_VIEW_TYPE,
      state: { sourcePath: path, ...(readingPosition ? { readingPosition } : {}) },
      active: true,
    });
  }

  async captureReadingPosition(view, sourcePath) {
    if (view?.getViewType?.() === LACAN_BILINGUAL_VIEW_TYPE) {
      return view.getReadingPosition();
    }
    if (!view || view.file?.path !== sourcePath) return null;
    const file = this.app.vault.getAbstractFileByPath(sourcePath);
    if (file?.extension !== "md") return null;
    const text = await this.app.vault.cachedRead(file);
    const blocks = new SegmentParser().parse(text, sourcePath);
    const language = this.isTranslationLessonPath(sourcePath) ? "translation" : "original";
    return captureMarkdownReadingPosition(view, blocks, language);
  }

  async openMonolingualReading(sourceView, targetPath, options = {}) {
    const file = this.app.vault.getAbstractFileByPath(targetPath);
    if (file?.extension !== "md") throw new Error(`找不到目标文本：${targetPath}`);
    const position = sourceView.getReadingPosition();
    let location = null;
    if (position) {
      const text = await this.app.vault.cachedRead(file);
      for (const id of new Set([position.segmentId, ...(position.segmentIds || [])])) {
        location = this.findSegmentLocation(text, id);
        if (location) break;
      }
      if (!location) throw new Error(`目标文本中没有对应分段：${position.segmentId}`);
    }
    await sourceView.leaf.openFile(file, {
      ...options,
      state: { ...options.state, mode: options.state?.mode || "preview" },
      ...(location ? { eState: { ...options.eState, scroll: location.line } } : {}),
    });
  }

  showBilingualLanguageMenu(view, button) {
    const paths = view.lessonPaths();
    if (!paths) return;
    const menu = new Obsidian.Menu();
    for (const [label, path] of [["中文", paths.translationPath], ["法语", paths.originalPath]]) {
      menu.addItem((item) => item
        .setTitle(label)
        .setDisabled(!this.app.vault.getAbstractFileByPath(path))
        .onClick(() => this.runWithNotice(() => view.openMonolingual(path), "语言切换失败")));
    }
    const rect = button.getBoundingClientRect();
    menu.showAtPosition({ x: rect.left, y: rect.bottom });
  }

  async handleCreatedFile(file) {
    if (this.syncInProgress) return;
    if (!(file instanceof TFile) || !this.isTranslationLessonPath(file.path)) {
      return;
    }

    // Let Obsidian finish the unresolved-link creation write before we inspect it.
    const timer = window.setTimeout(async () => {
      this.createdFileTimers.delete(timer);
      await this.runWithNotice(
        () => this.fillTranslationIfEmpty(file, { openAfterCreate: false, notify: false, updateProgress: true }),
        "译文骨架生成失败"
      );
    }, 100);
    this.createdFileTimers.add(timer);
  }

  handleModifiedFile(file) {
    if (!(file instanceof TFile)) {
      return;
    }

    if (file.path.startsWith("texts/") && file.extension === "md") {
      this.segmentPreviewCache.clear();
    }

    if (!this.isTranslationLessonPath(file.path)) {
      return;
    }

    if (this.syncInProgress) return;
    const normalized = normalizePath(file.path);
    if (this.progressWritePaths.has(normalized)) {
      this.progressDirtyPaths.add(normalized);
    } else {
      this.scheduleProgressUpdate(file.path);
    }
  }

  addFileMenuItems(menu, file) {
    if (!(file instanceof TFile)) {
      return;
    }
    if (addPdfFileMenuItems(this, menu, file)) return;

    if (this.isOriginalLessonPath(file.path)) {
      menu.addItem((item) => {
        item
          .setTitle("生成译文骨架")
          .setIcon("languages")
          .onClick(async () => {
            await this.runWithNotice(
              () => this.createTranslationForOriginal(file, { openAfterCreate: true, notify: true }),
              "译文骨架生成失败"
            );
          });
      });
      return;
    }

    if (this.isTranslationLessonPath(file.path)) {
      menu.addItem((item) => {
        item
          .setTitle("为空译文填充分段骨架")
          .setIcon("list-plus")
          .onClick(async () => {
            await this.runWithNotice(
              () => this.fillTranslationIfEmpty(file, { openAfterCreate: true, notify: true }),
              "译文骨架生成失败"
            );
          });
      });
    }
  }

  async createSkeletonFromActiveFile() {
    const file = this.app.workspace.getActiveFile();
    if (!(file instanceof TFile)) {
      new Notice("没有活动的课文文件。");
      return;
    }

    if (this.isOriginalLessonPath(file.path)) {
      await this.createTranslationForOriginal(file, { openAfterCreate: true, notify: true, updateProgress: true });
      return;
    }

    if (this.isTranslationLessonPath(file.path)) {
      await this.fillTranslationIfEmpty(file, {
        openAfterCreate: true,
        notify: true,
        notifyExisting: true,
        updateProgress: true,
      });
      return;
    }

    new Notice("当前文件不是 texts/*/original 或 texts/*/translation 下的 Leçon 文件。");
  }

  async createMissingTranslationSkeletons(options = {}) {
    const files = Array.isArray(options.originalFiles)
      ? options.originalFiles
      : this.app.vault.getMarkdownFiles();
    const scopeLabel = options.scopeLabel
      ? String(options.scopeLabel)
      : "全部研讨班";
    const originalFiles = files
      .filter((file) => file instanceof TFile && this.isOriginalLessonPath(file.path))
      .sort((a, b) => a.path.localeCompare(b.path));

    if (originalFiles.length === 0) {
      if (options.notifyOnFinish !== false) {
        new Notice(`${scopeLabel} 下未找到可处理原文文件。`);
      }
      return {
        created: 0,
        skipped: 0,
        failed: 0,
        createdBySeminar: {},
        skippedBySeminar: {},
        failedBySeminar: {},
        total: 0,
      };
    }

    const createdBySeminar = new Map();
    const skippedBySeminar = new Map();
    const failedBySeminar = new Map();
    let created = 0;
    let skipped = 0;
    let failed = 0;

    for (const originalFile of originalFiles) {
      const seminar = this.seminarSlugFromPath(originalFile.path) || "未分类";
      const paths = this.pathsFromOriginal(originalFile.path);
      if (!paths) {
        failed += 1;
        failedBySeminar.set(
          seminar,
          (failedBySeminar.get(seminar) || 0) + 1
        );
        continue;
      }

      const existing = this.app.vault.getAbstractFileByPath(paths.translationPath);
      if (existing instanceof TFile) {
        skipped += 1;
        skippedBySeminar.set(
          seminar,
          (skippedBySeminar.get(seminar) || 0) + 1
        );
        continue;
      }

      try {
        await this.createTranslationForOriginal(originalFile, {
          updateProgress: true,
        });
        created += 1;
        createdBySeminar.set(
          seminar,
          (createdBySeminar.get(seminar) || 0) + 1
        );
      } catch (error) {
        failed += 1;
        failedBySeminar.set(
          seminar,
          (failedBySeminar.get(seminar) || 0) + 1
        );
        console.error(`Lacan Translation Helper: 课文译文骨架批量创建失败`, {
          seminar,
          lesson: originalFile.path,
          error,
        });
      }
    }

    const mapToObject = (map) => {
      const out = {};
      for (const [key, value] of map) {
        out[key] = value;
      }
      return out;
    };

    if (options.notifyOnFinish !== false) {
      new Notice(
        `批量新建译文骨架完成：${scopeLabel}，已新建 ${created} 个，已存在 ${skipped} 个，失败 ${failed} 个。`
      );
    }

    return {
      created,
      skipped,
      failed,
      createdBySeminar: mapToObject(createdBySeminar),
      skippedBySeminar: mapToObject(skippedBySeminar),
      failedBySeminar: mapToObject(failedBySeminar),
      total: originalFiles.length,
    };
  }

  async runWithNotice(action, prefix) {
    try {
      return await action();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Lacan Translation Helper: ${prefix}`, error);
      new Notice(`${prefix}：${message}`);
      return null;
    }
  }

  registerReadingNoteEditorExtension() {
    if (!Decoration || !ViewPlugin || typeof this.registerEditorExtension !== "function") {
      return;
    }
    this.registerEditorExtension(this.createReadingNoteEditorExtension());
  }

  createReadingNoteEditorExtension() {
    const plugin = this;
    return ViewPlugin.fromClass(class {
      constructor(view) {
        this.decorations = plugin.buildReadingNoteEditorDecorations(view);
      }

      update(update) {
        if (update.docChanged || update.viewportChanged || update.focusChanged) {
          this.decorations = plugin.buildReadingNoteEditorDecorations(update.view);
        }
      }
    }, {
      decorations: (value) => value.decorations,
    });
  }

  buildReadingNoteEditorDecorations(view) {
    const sourcePath = this.editorPathFromCodeMirrorView(view);
    if (
      !this.isTranslationLessonPath(sourcePath)
      && !(this.settings.segmentAiEnabled && this.isOriginalLessonPath(sourcePath))
    ) {
      return Decoration.none;
    }

    const ranges = [];
    const visibleRanges = view.visibleRanges?.length
      ? view.visibleRanges
      : [{ from: 0, to: view.state.doc.length }];
    const seenLines = new Set();

    for (const range of visibleRanges) {
      let position = range.from;
      while (position <= range.to) {
        const line = view.state.doc.lineAt(position);
        if (!seenLines.has(line.number)) {
          seenLines.add(line.number);
          const match = line.text.match(SEGMENT_ID_ANCHOR_LINE_RE);
          if (match) {
            ranges.push(
              Decoration.widget({
                widget: new ReadingNoteButtonWidget(this, sourcePath, match[1].toLowerCase()),
                side: 1,
              }).range(line.to)
            );
          }
        }

        if (line.to >= range.to || line.to >= view.state.doc.length) {
          break;
        }
        position = line.to + 1;
      }
    }

    return Decoration.set(ranges, true);
  }

  editorPathFromCodeMirrorView(editorView) {
    let matchedPath = "";
    this.app.workspace.iterateAllLeaves?.((leaf) => {
      if (matchedPath) {
        return;
      }
      const view = leaf?.view;
      if (view?.containerEl?.contains(editorView.dom) && view.file instanceof TFile) {
        matchedPath = normalizePath(view.file.path);
      }
    });

    if (matchedPath) {
      return matchedPath;
    }

    const activeFile = this.app.workspace.getActiveFile();
    return activeFile instanceof TFile ? normalizePath(activeFile.path) : "";
  }

  async createReadingNoteForSegment(sourcePath, segmentId) {
    // Serialize clicks so creating a chapter and appending its segments cannot race.
    const sourceLeaf = this.app.workspace?.activeLeaf;
    const previous = this.readingNoteWriteQueue || Promise.resolve();
    const operation = previous.catch(() => {}).then(() =>
      this.createReadingNoteForSegmentUnlocked(sourcePath, segmentId, sourceLeaf)
    );
    this.readingNoteWriteQueue = operation;
    try {
      return await operation;
    } finally {
      if (this.readingNoteWriteQueue === operation) this.readingNoteWriteQueue = null;
    }
  }

  async createReadingNoteForSegmentUnlocked(sourcePath, segmentId, sourceLeaf) {
    const normalizedPath = normalizePath(sourcePath || "");
    const normalizedSegmentId = String(segmentId || "").trim().toLowerCase();
    if (!this.isTranslationLessonPath(normalizedPath)) {
      throw new Error("当前文件不是译文课文。");
    }
    if (!SEGMENT_ID_LINK_RE.test(normalizedSegmentId)) {
      throw new Error(`不是有效的分段 ID：${segmentId}`);
    }

    const translationFile = this.app.vault.getAbstractFileByPath(normalizedPath);
    if (!(translationFile instanceof TFile)) {
      throw new Error(`找不到译文文件：${normalizedPath}`);
    }

    const notePath = this.readingNotePathForSegment(normalizedPath, normalizedSegmentId);
    if (!notePath) {
      throw new Error("无法计算阅读笔记路径。");
    }

    // Validate the segment before creating any note or changing the translation.
    const translationText = await this.app.vault.read(translationFile);
    const parser = new SegmentParser();
    parser.findByRequestedId(parser.parse(translationText, normalizedPath), normalizedSegmentId);
    const noteFile = await this.createOrUpdateReadingNoteFile(notePath, normalizedSegmentId, normalizedPath);
    await this.app.vault.process(translationFile, (currentText) =>
      this.insertReadingNoteLink(currentText, normalizedSegmentId)
    );

    await this.openReadingNoteOnLeft(noteFile, sourceLeaf);
    new Notice(`已打开章节笔记：${this.readingNoteChapterId(normalizedSegmentId)}`);
  }

  readingNoteChapterId(segmentId) {
    return String(segmentId || "").trim().toLowerCase().replace(/-\d+$/, "");
  }

  readingNotePathForSegment(sourcePath, segmentId) {
    const normalizedPath = normalizePath(sourcePath || "");
    const normalizedSegmentId = String(segmentId || "").trim().toLowerCase();
    const match = normalizedPath.match(TRANSLATION_PATH_RE);
    if (!match || !SEGMENT_ID_LINK_RE.test(normalizedSegmentId)
      || Number(this.lessonFromPath(normalizedPath)) !== Number(normalizedSegmentId.split("-")[1])
      || match[1].split("-")[0].toLowerCase() !== normalizedSegmentId.split("-")[0]) {
      return "";
    }
    return `texts/${match[1]}/notes/${this.readingNoteChapterId(normalizedSegmentId)}.md`;
  }

  readingNoteWikiLinkForSegment(segmentId) {
    const id = String(segmentId || "").trim().toLowerCase();
    return `[[notes/${this.readingNoteChapterId(id)}#${id}|阅读笔记]]`;
  }

  hasReadingNoteLink(text, segmentId) {
    const normalizedSegmentId = String(segmentId || "").trim().toLowerCase();
    const pattern = new RegExp(
      `\\[\\[\\s*notes/${this.escapeRegExp(this.readingNoteChapterId(normalizedSegmentId))}(?:\\.md)?#${this.escapeRegExp(normalizedSegmentId)}(?:\\|[^\\]]*)?\\]\\]`,
      "i"
    );
    return pattern.test(String(text || ""));
  }

  insertReadingNoteLink(text, segmentId) {
    const sourceText = String(text || "");
    const normalizedSegmentId = String(segmentId || "").trim().toLowerCase();
    const markers = this.segmentCommentMatches(sourceText);
    const markerIndex = markers.findIndex((marker) => marker.ids.includes(normalizedSegmentId));
    if (markerIndex < 0) {
      return sourceText;
    }

    const marker = markers[markerIndex];
    const nextMarker = markers[markerIndex + 1];
    const blockStart = marker.end;
    const blockEnd = nextMarker ? nextMarker.index : sourceText.length;
    const updatedBlock = this.insertReadingNoteLinkIntoSegmentBlock(
      sourceText.slice(blockStart, blockEnd),
      marker.id
    );
    return `${sourceText.slice(0, blockStart)}${updatedBlock}${sourceText.slice(blockEnd)}`;
  }

  insertReadingNoteLinkIntoSegmentBlock(block, segmentId) {
    const normalizedSegmentId = String(segmentId || "").trim().toLowerCase();
    const lines = String(block || "").replace(/\r\n/g, "\n").split("\n");
    const keptLines = lines.filter((line) => !this.isReadingNoteLinkLineForSegment(line, normalizedSegmentId));
    return this.formatSegmentBlockSections([
      keptLines,
      [this.readingNoteWikiLinkForSegment(normalizedSegmentId)],
    ]);
  }

  isReadingNoteLinkLineForSegment(line, segmentId) {
    const normalizedSegmentId = String(segmentId || "").trim().toLowerCase();
    const pattern = new RegExp(
      `^\\s*\\[\\[\\s*notes/${this.escapeRegExp(this.readingNoteChapterId(normalizedSegmentId))}(?:\\.md)?#${this.escapeRegExp(normalizedSegmentId)}(?:\\|[^\\]]*)?\\]\\]\\s*$`,
      "i"
    );
    return pattern.test(String(line || ""));
  }

  formatSegmentBlockSections(sections) {
    const normalizedSections = sections
      .map((lines) => this.trimBlankLines(lines))
      .filter((lines) => lines.some((line) => line.trim()));
    return `\n\n${normalizedSections.map((lines) => lines.join("\n")).join("\n\n")}\n\n`;
  }

  trimBlankLines(lines) {
    let start = 0;
    let end = lines.length;
    while (start < end && !String(lines[start] || "").trim()) {
      start += 1;
    }
    while (end > start && !String(lines[end - 1] || "").trim()) {
      end -= 1;
    }
    return lines.slice(start, end);
  }

  async createOrUpdateReadingNoteFile(notePath, segmentId, sourcePath = "") {
    const existing = this.app.vault.getAbstractFileByPath(notePath);
    if (existing instanceof TFile) {
      const text = await this.app.vault.read(existing);
      if (this.readingNoteContainsSegment(text, segmentId)) return existing;
    } else if (existing) {
      throw new Error(`章节笔记路径已被占用：${notePath}`);
    }

    const snapshot = await this.readReadingNoteSnapshot(sourcePath, segmentId);
    if (existing instanceof TFile) {
      const section = this.buildReadingNoteSegmentContent(segmentId, sourcePath, snapshot);
      await this.app.vault.process(existing, (text) =>
        this.readingNoteContainsSegment(text, segmentId) ? text : `${text}\n\n${section}`
      );
      await this.ensureReadingNoteSegmentFrontmatter(existing, snapshot.ids);
      return existing;
    }
    await this.ensureFolder(notePath.split("/").slice(0, -1).join("/"));
    return this.app.vault.create(notePath, this.buildReadingNoteContent(segmentId, sourcePath, snapshot));
  }

  readingNoteContainsSegment(text, segmentId) {
    return this.segmentCommentMatches(text).some((marker) => marker.ids.includes(segmentId))
      || String(text).includes(`<!-- reading-note-segment: ${segmentId} -->`);
  }

  async readReadingNoteSnapshot(sourcePath, segmentId) {
    const parser = new SegmentParser();
    const readBlocks = async (path) => {
      const file = this.app.vault.getAbstractFileByPath(path);
      if (!(file instanceof TFile)) throw new Error(`找不到课文文件：${path}`);
      return parser.parse(await this.app.vault.read(file), path);
    };
    const translation = parser.findByRequestedId(await readBlocks(sourcePath), segmentId);
    const originalPath = this.pathsFromTranslation(sourcePath).originalPath;
    const originals = await readBlocks(originalPath);
    const aligned = [...new Set(translation.ids.map((id) => parser.findByRequestedId(originals, id)))];
    return {
      ids: translation.ids,
      original: aligned.map((block) => block.markdown).join("\n\n"),
      ...this.splitReadingNoteTranslation(translation.markdown),
    };
  }

  splitReadingNoteTranslation(markdown) {
    const sections = { translation: [], annotations: [], commentary: [] };
    const lines = String(markdown).split(/\r?\n/);
    for (let i = 0; i < lines.length;) {
      const line = lines[i];
      if (/^\s*\[\[\s*notes\/[^\]]+\]\]\s*$/.test(line)) {
        i += 1;
      } else if (/^\s*>/.test(line)) {
        const quote = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) quote.push(lines[i++]);
        // Match the site's annotation/commentary convention, keeping Markdown intact.
        const visible = quote.map((value) => value.replace(/^\s*>\s?/, "")).find((value) => value.trim()) || "";
        const isAnnotation = !quote.some((value) => /<!--\s*建言\s*-->/.test(value))
          && /^[【\[（(]*\s*注/.test(visible.trim());
        sections[isAnnotation ? "annotations" : "commentary"].push(...quote, "");
      } else {
        sections.translation.push(line);
        i += 1;
      }
    }
    return Object.fromEntries(Object.entries(sections).map(([key, lines]) => [key, lines.join("\n").trim()]));
  }

  async ensureReadingNoteSegmentFrontmatter(noteFile, segmentIds) {
    const ids = Array.isArray(segmentIds) ? segmentIds : [segmentIds];
    await this.app.fileManager.processFrontMatter(noteFile, (frontmatter) => {
      if (!frontmatter.title) frontmatter.title = `${this.readingNoteChapterId(ids[0])} 章节笔记`;
      const currentSegments = Array.isArray(frontmatter.segments)
        ? frontmatter.segments.map(String)
        : frontmatter.segments ? [String(frontmatter.segments)] : [];
      for (const id of ids) {
        if (!currentSegments.some((value) => value.toLowerCase() === id)) currentSegments.push(id);
      }
      frontmatter.segments = currentSegments;
    });
  }

  buildReadingNoteSegmentContent(segmentId, sourcePath, snapshot) {
    return [
      ...snapshot.ids.map((id) => `<!-- reading-note-segment: ${id} -->`),
      `## ${snapshot.ids[0]}`, "",
      `<!-- id: ${snapshot.ids[0]} -->`,
      ...(snapshot.ids.length > 1 ? [`<!-- ids: ${snapshot.ids.join(" ")} -->`] : []), "",
      this.translationWikiLinkForSegment(sourcePath, segmentId), "",
      "### 法语原文", "", snapshot.original, "",
      "### 中文译文", "", snapshot.translation || "（暂无译文）", "",
      "### 当前段落注释", "", snapshot.annotations || "（无）", "",
      "### 当前段落建言", "", snapshot.commentary || "（无）", "",
      "### 我的笔记", "", "",
    ].join("\n");
  }

  buildReadingNoteContent(segmentId, sourcePath = "", snapshot) {
    const chapterId = this.readingNoteChapterId(segmentId);
    return [
      "---",
      `title: ${chapterId} 章节笔记`,
      "segments:",
      ...snapshot.ids.map((id) => `  - ${id}`),
      "---", "",
      `# ${chapterId} 章节笔记`, "",
      this.buildReadingNoteSegmentContent(segmentId, sourcePath, snapshot),
    ].join("\n");
  }

  translationWikiLinkForSegment(sourcePath, segmentId) {
    const normalizedSegmentId = String(segmentId || "").trim().toLowerCase();
    const normalizedPath = normalizePath(sourcePath || "");
    const label = `「${normalizedSegmentId}」译文`;
    if (!normalizedPath || !SEGMENT_ID_LINK_RE.test(normalizedSegmentId)) {
      return `[[${normalizedSegmentId}|${label}]]`;
    }
    return `[[${normalizedPath}#${normalizedSegmentId}|${label}]]`;
  }

  escapeRegExp(value) {
    return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  getPluginRequest() {
    if (!this.pluginRequest) {
      this.pluginRequest = createPluginRequest({
        requestUrl: Obsidian.requestUrl,
        getSettings: () => this.settings,
      });
    }
    return this.pluginRequest;
  }

  async syncConfiguredRepositories(options = {}) {
    // Keep the existing command entry point so saved shortcuts continue to work.
    return this.syncProjectContent(options);
  }

  async ensureProjectBase() {
    const existing = this.app.vault.getAbstractFileByPath(PROJECT_BASE_PATH);
    if (existing) {
      if (this.app.vault.process) await this.app.vault.process(existing, (contents) => migrateProjectBaseContent(contents, {
        parseYaml: Obsidian.parseYaml, stringifyYaml: Obsidian.stringifyYaml,
      }));
      return { file: existing, created: false };
    }
    const file = await this.app.vault.create(PROJECT_BASE_PATH, PROJECT_BASE_CONTENT);
    return { file, created: true };
  }

  async openProjectLibrary() {
    const { file } = await this.ensureProjectBase();
    await this.openFile(file);
  }

  async initializeProjectLibrary() {
    const { file, created } = await this.ensureProjectBase();
    const engine = this.createProjectSyncEngine();
    await engine.cleanupLegacyBaseCache();
    this.projectCatalog = await engine.readCachedCatalog();
    await this.refreshKnowledgeLibrary({ engine });
    this.refreshProjectCatalogViews();
    await this.reloadProjectBaseViews();
    if (created) await this.openFile(file);
    if (!this.projectCatalog || this.settings.autoSyncOnStartup || this.projectCatalog.files?.some((file) => !file.sha256)) {
      try { await this.refreshProjectCatalog(); }
      catch (error) {
        this.projectCatalogError = error.message || "无法读取文本清单，请检查网络后重试。";
        this.refreshProjectCatalogViews();
        throw error;
      }
    }
    return this.projectCatalog;
  }

  async reloadProjectBaseViews() {
    if (this.projectBaseViewsReloaded) return;
    this.projectBaseViewsReloaded = true;
    // Bases can retain a custom view instance after its plugin is reloaded.
    // Reopen only this library's Base, keeping the leaf and its saved state.
    for (const leaf of this.app.workspace?.getLeavesOfType?.("bases") || []) {
      if (leaf.view.file?.path !== PROJECT_BASE_PATH) continue;
      const state = leaf.getViewState();
      await leaf.setViewState({ type: "empty" });
      await leaf.setViewState(state);
    }
  }

  refreshProjectCatalogViews() {
    for (const view of this.projectCatalogViews || []) view.onDataUpdated();
    for (const view of this.projectKnowledgeViews || []) view.onDataUpdated();
  }

  getKnowledgeLibrary() {
    return this.knowledgeLibrary ||= new KnowledgeLibrary(this);
  }

  getKnowledgeEntries() { return this.getKnowledgeLibrary().getEntries(); }

  refreshKnowledgeLibrary(options) { return this.getKnowledgeLibrary().refresh(options); }

  syncProjectKnowledgeEntry(path, options) { return this.getKnowledgeLibrary().sync(path, options); }

  syncAllProjectKnowledge() { return this.getKnowledgeLibrary().syncAll(); }

  openKnowledgeEntry(path, subpath) { return this.getKnowledgeLibrary().open(path, subpath); }

  handleKnowledgeInternalLinkClick(event) { return this.getKnowledgeLibrary().handleLinkClick(event); }

  getLessonSyncPercent(originalPath) {
    const active = this.projectLessonSyncProgress?.get(originalPath);
    if (Number.isFinite(active)) return active;
    const status = this.settings.projectLessonSync?.[originalPath];
    return status?.status !== "skipped" && status?.version ? 100 : 0;
  }

  setLessonSyncPercent(originalPath, percent) {
    this.projectLessonSyncProgress ||= new Map();
    this.projectLessonSyncProgress.set(originalPath, Math.max(0, Math.min(100, percent)));
    for (const view of this.projectCatalogViews || []) view.updateSyncProgress(originalPath);
  }

  async refreshProjectCatalog({ notify = false } = {}) {
    return this.runProjectLibraryTask(async (engine, signal) => {
      await this.ensureProjectBase();
      this.projectCatalog = await engine.getCatalog({ signal });
      this.projectCatalogError = null;
      await this.refreshKnowledgeLibrary({ engine, signal });
      this.refreshProjectCatalogViews();
      if (notify) new Notice(`文库目录已更新：${this.projectCatalog.lessonCount} 个课次、${this.projectCatalog.knowledgeEntries?.length || 0} 个知识词条。正文请在 Base 中按需同步。`);
      return this.projectCatalog;
    }, { label: "正在更新文本清单…" });
  }

  async initializeProjectSeminar(slug) {
    return this.runProjectLibraryTask(async (engine, signal) => {
      const catalog = this.projectCatalog || await engine.getCatalog({ signal });
      this.projectCatalog = catalog;
      const seminar = catalog.seminars.find((entry) => entry.slug === slug);
      if (!seminar) throw new Error("文本清单中不存在这个研讨班，请先更新清单。");
      const result = await engine.initializeSeminar(slug, { signal });
      for (const folder of ["original", "translation", "notes", "assets"]) {
        await this.ensureFolder(`texts/${slug}/${folder}`);
      }
      this.recordProjectSyncResult(result);
      await this.saveSettings();
      new Notice(result.skippedFiles?.length
        ? `目录已准备好。术语表已有本地修改，已跳过更新。\n${formatSkipNotice(result.skippedFiles)}`
        : `${seminar.code.toUpperCase()} 已初始化：术语表和目录已准备好，课文请逐课同步。`, 10000);
      return result;
    }, { label: "正在初始化研讨班…" });
  }

  async syncProjectLesson(originalPath) {
    this.setLessonSyncPercent(originalPath, 0);
    try {
      return await this.runProjectLibraryTask(async (engine, signal) => {
        const result = await engine.syncLesson(originalPath, { signal });
        const skippedFiles = result.skippedFiles || [];
        this.settings.projectLessonSync ||= {};
        this.settings.projectLessonSync[originalPath] = skippedFiles.length
          ? { status: "skipped", skippedFiles, checkedAt: Date.now() }
          : { status: "synced", version: result.version, syncedAt: Date.now() };
        this.recordProjectSyncResult(result);
        await this.saveSettings();
        this.setLessonSyncPercent(originalPath, skippedFiles.length ? 0 : 100);
        this.refreshReadingAfterRepositorySync();
        new Notice(skippedFiles.length ? formatSkipNotice(skippedFiles) : "本课原文和译文已同步。", 12000);
        return result;
      }, { label: "正在同步本课原文和译文…", originalPath });
    } catch (error) {
      this.setLessonSyncPercent(originalPath, 0);
      throw error;
    }
  }

  recordProjectSyncResult(result) {
    this.settings.projectSyncLastResult = {
      version: result.version, checkedAt: Date.now(),
      added: result.added, updated: result.updated, deleted: result.deleted,
      merged: result.merged || 0, unchanged: result.unchanged,
      skippedCount: result.skippedFiles?.length || 0, skippedFiles: result.skippedFiles || [],
      conflictCount: result.conflicts.length, conflictReportPath: result.conflictReportPath,
    };
  }

  async runProjectLibraryTask(action, { label = "正在同步文库…", originalPath, knowledgePath } = {}) {
    if (this.syncInProgress) throw new Error("已有文库同步正在进行，请等待完成或取消后再试。");
    const knowledgeRefreshRevision = this.knowledgeLibrary?.refreshRevision || 0;
    this.knowledgeLibrary?.pauseRefresh();
    this.syncInProgress = true;
    this.activeLessonSync = originalPath || null;
    this.activeKnowledgeSync = knowledgePath || null;
    const controller = new AbortController();
    this.projectSyncController = controller;
    const progress = new Notice(label, 0);
    this.refreshProjectCatalogViews();
    try {
      const engine = this.createProjectSyncEngine((event) => {
        const ratio = event.total > 0 ? event.completed / event.total : 0;
        let percent = event.phase === "complete" ? 99
          : event.phase === "applying" ? 65 + Math.floor(ratio * 34)
            : event.phase === "downloading" ? 5 + Math.floor(ratio * 60) : 0;
        if (originalPath) {
          percent = Math.max(this.projectLessonSyncProgress?.get(originalPath) || 0, percent);
          this.setLessonSyncPercent(originalPath, percent);
        }
        const activeKnowledgePath = knowledgePath || this.activeKnowledgeSync;
        if (activeKnowledgePath) {
          percent = Math.max(this.knowledgeSyncProgress?.get(activeKnowledgePath) || 0, percent);
          this.getKnowledgeLibrary().setProgress(activeKnowledgePath, percent);
        }
        const bulk = this.knowledgeBulkSync;
        progress.setMessage?.(bulk ? `${label} ${bulk.completed} / ${bulk.total}${bulk.title ? ` · ${bulk.title}` : ""}`
          : `${label}${originalPath || knowledgePath ? ` ${percent}%` : ""}`);
      });
      return await action(engine, controller.signal);
    } finally {
      progress.hide?.();
      if (this.projectSyncController === controller) this.projectSyncController = null;
      this.syncInProgress = false;
      this.activeLessonSync = null;
      this.activeKnowledgeSync = null;
      this.refreshProjectCatalogViews();
      if (!this.knowledgeLibrary?.hasRefreshedSince(knowledgeRefreshRevision, this.projectCatalog)) {
        this.knowledgeLibrary?.scheduleRefresh();
      }
    }
  }

  createProjectSyncEngine(onProgress) {
    const { ProjectSyncEngine } = require("./project-sync");
    const endpointUrl = this.settings.projectEndpointUrl || DEFAULT_PROJECT_ENDPOINT;
    const stateDir = `${this.app.vault.configDir || ".obsidian"}/plugins/lacan-translation-helper/project-sync`;
    const key = JSON.stringify([endpointUrl, stateDir]);
    if (this.projectSyncEngineKey === key && this.projectSyncEngine) {
      this.projectSyncEngine.onProgress = onProgress;
      return this.projectSyncEngine;
    }
    this.projectSyncEngine = new ProjectSyncEngine({
      endpointUrl,
      stateDir,
      storage: this.getProjectSyncStorage(),
      transport: createProjectTransport(this.getPluginRequest()),
      onProgress,
    });
    this.projectSyncEngineKey = key;
    return this.projectSyncEngine;
  }

  getProjectSyncStorage() {
    return createVaultSyncStorage(this.app.vault, {
      isWriteBlocked: (path) => {
        const editor = this.translationInlineEditor?.active;
        return Boolean(editor?.sourcePath === path && (editor.saving || editor.pasting
          || editor.input?.value !== editor.snapshot?.markdown));
      },
      getEditorTexts: (path) => {
        const texts = [];
        this.app.workspace.iterateAllLeaves?.((leaf) => {
          const view = leaf.view;
          if (view?.file?.path === path && view.editor?.getValue && view.getMode?.() !== "preview") {
            texts.push(view.editor.getValue());
          }
        });
        return texts;
      },
    });
  }

  async syncProjectContent(options = {}) {
    return this.refreshProjectCatalog(options);
  }

  cancelProjectSync() {
    this.projectSyncController?.abort();
  }

  async showProjectSyncReport() {
    if (this.syncInProgress) throw new Error("请等待文库同步或冲突保存完成后查看报告。");
    const storage = this.getProjectSyncStorage();
    const summary = this.settings.projectSyncLastResult;
    const reportPath = summary?.conflictReportPath || `${this.app.vault.configDir || ".obsidian"}/plugins/lacan-translation-helper/project-sync/conflicts.json`;
    const bytes = await storage.read(reportPath);
    if (!bytes && !summary) { new Notice("尚无文库同步记录。"); return; }
    const report = bytes ? JSON.parse(new TextDecoder().decode(bytes)) : { version: summary?.version, conflicts: [] };
    const engine = this.createProjectSyncEngine();
    new ProjectSyncReportModal(this.app, storage, Array.isArray(report) ? { version: summary?.version, conflicts: report } : report, {
      readOnly: true,
      skippedFiles: summary?.skippedFiles || [],
      checkedVersion: summary?.version,
      engine: {
        getConflictComparison: (path) => {
          if (this.syncInProgress) throw new Error("文库正在更新，请稍后重新打开比较。");
          return engine.getConflictComparison(path);
        },
        resolveConflict: (path, options) => this.resolveProjectSyncConflict(engine, path, options),
      },
      onResolved: async (result) => {
        this.settings.projectSyncLastResult = {
          ...(this.settings.projectSyncLastResult || { added: 0, updated: 0, deleted: 0, unchanged: 0 }),
          version: result.version, checkedAt: Date.now(), conflictCount: result.conflicts.length,
          conflictReportPath: result.conflictReportPath || reportPath,
        };
        await this.saveSettings();
        this.refreshReadingAfterRepositorySync();
      },
    }).open();
  }

  async resolveProjectSyncConflict(engine, path, options) {
    if (this.syncInProgress) throw new Error("已有文库同步或冲突保存正在进行，请稍后再试。");
    if (engine !== this.createProjectSyncEngine()) throw new Error("文库同步地址已改变，请重新打开冲突比较。");
    this.syncInProgress = true;
    try { return await engine.resolveConflict(path, options); }
    finally { this.syncInProgress = false; }
  }

  refreshReadingAfterRepositorySync() {
    this.segmentPreviewCache.clear();
    this.refreshBilingualReadingViews();
    this.renderReadingToolbar();
  }

  getVaultBasePath() {
    const adapter = this.app.vault.adapter;
    if (typeof adapter.getBasePath === "function") {
      return adapter.getBasePath();
    }
    throw new Error("本机 Agent 需要 Obsidian 桌面端本地文库。");
  }

  scheduleReadingToolbarRender(delay = 220) {
    if (this.readingToolbarRenderTimer) {
      window.clearTimeout(this.readingToolbarRenderTimer);
    }
    this.readingToolbarRenderTimer = window.setTimeout(() => {
      this.readingToolbarRenderTimer = null;
      this.renderReadingToolbar();
    }, delay);
  }

  renderReadingToolbar() {
    const activeView = this.app.workspace.activeLeaf?.view;
    const isBilingual = activeView?.getViewType?.() === LACAN_BILINGUAL_VIEW_TYPE;
    const file = isBilingual
      ? this.app.vault.getAbstractFileByPath(activeView.sourcePath)
      : this.app.workspace.getActiveFile();
    if (!(file instanceof TFile) || !this.isSegmentAiLessonPath(file.path)) {
      this.removeReadingToolbars();
      return;
    }

    const view = isBilingual ? activeView : Obsidian.MarkdownView
      ? this.app.workspace.getActiveViewOfType(Obsidian.MarkdownView)
      : activeView;
    if (!view?.containerEl) {
      return;
    }

    const toolbarMount = this.resolveReadingToolbarMount(view);
    if (!toolbarMount) {
      return;
    }

    const toolbarSignature = normalizePath(file.path);
    let toolbarEl = view.containerEl.querySelector(".lacan-compare-toolbar");
    if (!toolbarEl) {
      toolbarEl = document.createElement("div");
      toolbarEl.className = "lacan-compare-toolbar";
    }
    toolbarEl.classList.toggle("is-view-header", toolbarMount.location === "header");
    toolbarEl.classList.toggle("is-content-fallback", toolbarMount.location === "content");
    toolbarMount.hostEl.insertBefore(toolbarEl, toolbarMount.beforeEl);

    if (toolbarEl.dataset.toolbarSignature !== toolbarSignature) {
      this.renderReadingToolbarContent(toolbarEl, file.path, view.leaf);
      toolbarEl.dataset.toolbarSignature = toolbarSignature;
    }
  }

  resolveReadingToolbarMount(view) {
    const viewHeaderEl = view?.containerEl?.querySelector?.(".view-header");
    if (viewHeaderEl) {
      const viewActionsEl = viewHeaderEl.querySelector?.(":scope > .view-actions")
        || viewHeaderEl.querySelector?.(".view-actions")
        || null;
      return {
        hostEl: viewHeaderEl,
        beforeEl: viewActionsEl,
        location: "header",
      };
    }

    const contentEl = view?.containerEl?.querySelector?.(".view-content");
    if (!contentEl) {
      return null;
    }
    return {
      hostEl: contentEl,
      beforeEl: contentEl.firstChild || null,
      location: "content",
    };
  }

  renderReadingToolbarContent(toolbarEl, sourcePath, sourceLeaf) {
    toolbarEl.empty();
    if (this.isSegmentAiLessonPath(sourcePath || "")) {
      const bilingualButton = toolbarEl.createEl("button", {
        cls: "lacan-compare-button lacan-bilingual-button",
        text: "双语阅读",
      });
      bilingualButton.type = "button";
      const isBilingual = sourceLeaf?.view?.getViewType?.() === LACAN_BILINGUAL_VIEW_TYPE;
      bilingualButton.setAttribute("aria-label", isBilingual
        ? "双语阅读：切换为中文或法语" : "双语阅读：法语原文在上，中文翻译在下");
      if (isBilingual) bilingualButton.setAttribute("aria-haspopup", "menu");
      bilingualButton.addEventListener("click", () => {
        if (sourceLeaf?.view?.getViewType?.() === LACAN_BILINGUAL_VIEW_TYPE) {
          this.showBilingualLanguageMenu(sourceLeaf.view, bilingualButton);
          return;
        }
        return this.runWithNotice(
          () => this.openBilingualReading(sourcePath, sourceLeaf),
          "双语阅读打开失败"
        );
      });
    }
  }

  removeReadingToolbars() {
    const rootEl = this.app.workspace?.containerEl || document.body;
    rootEl.querySelectorAll(".lacan-compare-toolbar").forEach((element) => element.remove());
  }

  async rerenderPreview(view) {
    const rerender = view?.previewMode?.rerender;
    if (typeof rerender !== "function") {
      return;
    }

    try {
      await rerender.call(view.previewMode, true);
      await new Promise((resolve) => window.requestAnimationFrame(resolve));
    } catch (error) {
      console.warn("Lacan Translation Helper: preview rerender failed.", error);
    }
  }

  isTextMarkdownPath(path) {
    const normalized = normalizePath(path || "");
    return normalized.startsWith("texts/") && normalized.endsWith(".md");
  }

  isReadingNotePath(path) {
    return READING_NOTE_PATH_RE.test(normalizePath(path || ""));
  }

  async renderSegmentMarkdownContent(contentEl, content, sourcePath) {
    this.unloadMarkdownRenderComponent(contentEl);
    contentEl.empty();
    const trimmed = String(content || "").trim();
    if (!trimmed) {
      contentEl.setText("[没有对应分段]");
      return;
    }
    const visibleText = trimmed.replace(/<!--[\s\S]*?-->/g, "").trim();
    if (!visibleText && /<!--\s*untranslated\s*-->/i.test(trimmed)) {
      contentEl.setText("[该段尚未翻译]");
      return;
    }

    if (Obsidian.MarkdownRenderer?.render) {
      const component = new MarkdownRenderComponent();
      component.load();
      contentEl[MARKDOWN_RENDER_COMPONENT_KEY] = component;
      await Obsidian.MarkdownRenderer.render(this.app, trimmed, contentEl, sourcePath, component);
      if (!contentEl.isConnected) {
        this.unloadMarkdownRenderComponent(contentEl);
      }
      return;
    }

    contentEl.createEl("pre", {
      text: trimmed,
    });
  }

  unloadMarkdownRenderComponents(rootEl) {
    if (!rootEl) {
      return;
    }
    this.unloadMarkdownRenderComponent(rootEl);
    rootEl.querySelectorAll?.(".lacan-segment-preview-content").forEach((element) => {
      this.unloadMarkdownRenderComponent(element);
    });
  }

  unloadMarkdownRenderComponent(element) {
    const component = element?.[MARKDOWN_RENDER_COMPONENT_KEY];
    if (!component) {
      return;
    }
    try {
      component.unload();
    } catch (error) {
      console.warn("Lacan Translation Helper: failed to unload markdown renderer.", error);
    }
    element[MARKDOWN_RENDER_COMPONENT_KEY] = null;
  }

  extractSegmentsById(text) {
    const segments = new Map();
    const matches = [];
    for (const match of this.segmentCommentMatches(text)) {
      matches.push({
        id: match.id,
        ids: match.ids,
        start: match.index,
        end: match.end,
      });
    }

    for (let index = 0; index < matches.length; index += 1) {
      const current = matches[index];
      const next = matches[index + 1];
      const content = text.slice(current.end, next ? next.start : text.length).trim();
      for (const id of current.ids) {
        if (!segments.has(id)) {
          segments.set(id, content);
        }
      }
    }

    return segments;
  }

  extractSegmentMarkers(text) {
    const markers = [];
    let cursor = 0;
    let line = 0;
    for (const match of this.segmentCommentMatches(text)) {
      while (cursor < match.index) {
        if (text.charCodeAt(cursor) === 10) {
          line += 1;
        }
        cursor += 1;
      }
      markers.push({
        id: match.id,
        ids: match.ids,
        idStart: match.index,
        line,
        targetLine: line,
        contentStart: match.end,
        nextLine: null,
        text: "",
        snippet: "",
      });
    }
    for (let index = 0; index < markers.length; index += 1) {
      const current = markers[index];
      const next = markers[index + 1];
      current.nextLine = next ? next.line : null;
      current.text = text.slice(current.contentStart, next ? next.idStart : text.length);
      const visibleLineOffset = this.firstVisibleSegmentLineOffset(current.text);
      if (visibleLineOffset !== null) {
        current.targetLine = this.lineNumberAtOffset(text, current.contentStart) + visibleLineOffset;
      }
      current.snippet = this.firstVisibleSegmentSnippet(current.text);
    }
    return markers;
  }

  sectionLineOffset(sectionInfo) {
    const candidates = [
      sectionInfo?.lineStart,
      sectionInfo?.startLine,
      sectionInfo?.position?.start?.line,
    ];
    const value = candidates.find((candidate) => Number.isFinite(Number(candidate)));
    return value === undefined ? 0 : Number(value);
  }

  firstVisibleSegmentSnippet(text) {
    const withoutComments = String(text || "").replace(/<!--[\s\S]*?-->/g, "\n");
    for (const line of withoutComments.split(/\r?\n/)) {
      if (this.isSegmentHelperLine(line)) {
        continue;
      }
      const normalized = this.normalizeRenderedText(
        line
          .replace(/^\s{0,3}>\s?/, "")
          .replace(/^\s{0,3}#{1,6}\s+/, "")
          .replace(/^\s{0,3}(?:[-*+]|\d+\.)\s+/, "")
          .replace(/[*_`~[\]()]/g, "")
      );
      if (normalized) {
        return normalized.slice(0, 40);
      }
    }
    return "";
  }

  firstVisibleSegmentLineOffset(text) {
    const lines = String(text || "").split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      if (!this.isSegmentHelperLine(lines[index])) {
        return index;
      }
    }
    return null;
  }

  isSegmentHelperLine(line) {
    const value = String(line || "").trim();
    return !value || /^<!--[\s\S]*-->$/.test(value) || this.isReadingNoteLinkLine(value);
  }

  isReadingNoteLinkLine(line) {
    return /^\[\[\s*notes\/[^|\]]+(?:\|[^\]]*)?\]\]$/.test(String(line || "").trim());
  }

  lineNumberAtOffset(text, offset) {
    const sourceText = String(text || "");
    const limit = Math.max(0, Math.min(Number(offset) || 0, sourceText.length));
    let line = 0;
    for (let index = 0; index < limit; index += 1) {
      if (sourceText.charCodeAt(index) === 10) {
        line += 1;
      }
    }
    return line;
  }

  normalizeRenderedText(text) {
    return String(text || "").replace(/\s+/g, "");
  }

  buildRenderedAnchorIndex(containerEl) {
    const lineAnchors = Array.from(containerEl.querySelectorAll("[data-line]"))
      .map((element) => ({
        element,
        line: Number(element.getAttribute("data-line")),
      }))
      .filter((item) => Number.isFinite(item.line))
      .sort((a, b) => a.line - b.line);

    const blockAnchors = Array.from(
      containerEl.querySelectorAll("p, blockquote, ul, ol, pre, table, h1, h2, h3, h4, h5, h6")
    )
      .map((element) => ({
        element,
        normalizedText: this.normalizeRenderedText(element.textContent),
      }));

    return { lineAnchors, blockAnchors, lineCursor: 0 };
  }

  findRenderedSegmentAnchor(containerEl, marker, usedAnchors, anchorIndex = null) {
    const { lineAnchors, blockAnchors } = anchorIndex || this.buildRenderedAnchorIndex(containerEl);

    const byLine = this.findLineAnchorForMarker(marker, usedAnchors, anchorIndex || { lineAnchors, lineCursor: 0 });
    if (byLine?.element) {
      return byLine.element;
    }

    if (!marker.snippet) {
      return null;
    }

    return (
      blockAnchors.find((item) => {
        if (usedAnchors.has(item.element)) {
          return false;
        }
        return (
          item.normalizedText.includes(marker.snippet) ||
          marker.snippet.includes(item.normalizedText.slice(0, 20))
        );
      })?.element || null
    );
  }

  findLineAnchorForMarker(marker, usedAnchors, anchorIndex) {
    const lineAnchors = anchorIndex?.lineAnchors || [];
    const targetLine = Number.isFinite(Number(marker.targetLine)) ? Number(marker.targetLine) : marker.line;
    let cursor = anchorIndex?.lineCursor || 0;
    while (cursor < lineAnchors.length && lineAnchors[cursor].line < targetLine) {
      cursor += 1;
    }

    for (let index = cursor; index < lineAnchors.length; index += 1) {
      const item = lineAnchors[index];
      if (marker.nextLine !== null && item.line >= marker.nextLine) {
        break;
      }
      if (!usedAnchors.has(item.element)) {
        if (anchorIndex) {
          anchorIndex.lineCursor = index + 1;
        }
        return item;
      }
    }

    if (anchorIndex) {
      anchorIndex.lineCursor = cursor;
    }
    return null;
  }

  segmentIdFromComment(commentText) {
    return this.segmentIdsFromComment(commentText)[0] || "";
  }

  segmentCommentMatches(text) {
    const rawMatches = [];
    SEGMENT_ID_COMMENT_RE.lastIndex = 0;
    let match;
    while ((match = SEGMENT_ID_COMMENT_RE.exec(text)) !== null) {
      const info = this.segmentCommentInfo(match[0]);
      if (info.ids.length === 0) {
        continue;
      }
      rawMatches.push({
        label: info.label,
        id: info.ids[0],
        ids: info.ids,
        index: match.index,
        end: SEGMENT_ID_COMMENT_RE.lastIndex,
      });
    }

    const matches = [];
    for (let index = 0; index < rawMatches.length; index += 1) {
      const current = rawMatches[index];
      if (current.label !== "id") {
        continue;
      }

      const next = rawMatches[index + 1];
      const hasOnlyWhitespaceBetween = (
        Boolean(next)
        && /^\s*$/.test(String(text || "").slice(current.end, next.index))
      );
      const hasAttachedIds = (
        next?.label === "ids"
        && hasOnlyWhitespaceBetween
      );
      const hasAttachedRepeatedPrimaryGroup = (
        next?.label === "id"
        && next.ids.length > 1
        && next.ids[0] === current.ids[0]
        && hasOnlyWhitespaceBetween
      );
      const hasAttachedGroup = hasAttachedIds || hasAttachedRepeatedPrimaryGroup;
      const ids = hasAttachedGroup
        ? this.mergeSegmentIds(current.ids, next.ids)
        : current.ids;
      matches.push({
        id: ids[0],
        ids,
        index: current.index,
        end: hasAttachedGroup ? next.end : current.end,
      });
      if (hasAttachedGroup) {
        index += 1;
      }
    }
    return matches;
  }

  segmentIdsFromComment(commentText) {
    return this.segmentCommentInfo(commentText).ids;
  }

  segmentCommentInfo(commentText) {
    const body = String(commentText || "")
      .replace(/^\s*<!--\s*/, "")
      .replace(/\s*-->\s*$/, "")
      .trim();
    const labelMatch = body.match(/^(ids?)\b\s*:?\s*([\s\S]+)$/i);
    if (!labelMatch) {
      return { label: "", ids: [] };
    }

    const ids = [];
    const seen = new Set();
    SEGMENT_ID_TOKEN_RE.lastIndex = 0;
    let match;
    while ((match = SEGMENT_ID_TOKEN_RE.exec(labelMatch[2])) !== null) {
      const id = match[0].toLowerCase();
      if (!seen.has(id)) {
        ids.push(id);
        seen.add(id);
      }
    }
    return { label: labelMatch[1].toLowerCase(), ids };
  }

  mergeSegmentIds(...groups) {
    const ids = [];
    const seen = new Set();
    for (const group of groups) {
      for (const id of group || []) {
        if (!seen.has(id)) {
          ids.push(id);
          seen.add(id);
        }
      }
    }
    return ids;
  }

  segmentCacheKey(path, segmentId) {
    return `${path}::${segmentId}`;
  }

  decorateRenderedReadingNoteLinks(rootEl, sourcePath) {
    rootEl.querySelectorAll?.("a.internal-link").forEach((linkEl) => {
      if (String(linkEl.textContent || "").trim() !== "阅读笔记") {
        return;
      }

      const target = (
        linkEl.getAttribute?.("data-href") ||
        linkEl.getAttribute?.("href") ||
        ""
      );
      const linkpath = this.safeDecodeURIComponent(String(target).split("#", 1)[0].trim());
      if (!linkpath || /^[a-z][a-z0-9+.-]*:/i.test(linkpath)) {
        return;
      }

      const noteFile = this.app.metadataCache?.getFirstLinkpathDest?.(linkpath, sourcePath);
      if (!(noteFile instanceof TFile) || !this.isReadingNotePath(noteFile.path)) {
        return;
      }

      linkEl.textContent = this.readingNoteDisplayName(noteFile);
    });
  }

  readingNoteDisplayName(noteFile) {
    return String(noteFile.basename || noteFile.path?.split("/").pop() || "")
      .replace(/\.md$/i, "")
      .trim();
  }

  decorateRenderedSegmentLinks(rootEl) {
    rootEl.querySelectorAll?.(
      'a.lacan-segment-link, a.internal-link[data-href*="#"], a.internal-link[href*="#"]'
    ).forEach((linkEl) => {
      const segmentId = this.segmentIdFromLinkElement(linkEl);
      if (!segmentId) {
        return;
      }

      this.markRenderedSegmentLink(linkEl, segmentId, this.segmentTargetPathFromLinkElement(linkEl));
    });
  }

  markRenderedSegmentLink(linkEl, segmentId, targetPath = "") {
    linkEl.classList.remove("internal-link", "is-unresolved");
    linkEl.classList.add("lacan-segment-link");
    linkEl.dataset.lacanSegmentId = segmentId;
    if (targetPath) {
      linkEl.dataset.lacanSegmentTargetPath = targetPath;
    }
    linkEl.setAttribute("href", "#");
    linkEl.setAttribute("title", `打开「${segmentId}」${this.segmentDocumentLabel(targetPath)}`);
  }

  handleSegmentInternalLinkClick(event) {
    const linkEl = this.segmentLinkElementFromEvent(event);
    if (!linkEl) {
      return;
    }

    const segmentId = this.segmentIdFromLinkElement(linkEl);
    if (!segmentId) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    this.runWithNotice(
      () => this.openSegmentId(segmentId, this.segmentTargetPathFromLinkElement(linkEl)),
      "打开分段失败"
    );
  }

  handleSegmentLinkPreviewEnter(event) {
    const linkEl = this.segmentLinkElementFromEvent(event);
    if (!linkEl) {
      return;
    }
    if (
      event.type === "mouseover" &&
      typeof Node !== "undefined" &&
      event.relatedTarget instanceof Node &&
      linkEl.contains(event.relatedTarget)
    ) {
      return;
    }

    const segmentId = this.segmentIdFromLinkElement(linkEl);
    if (!segmentId) {
      return;
    }

    event.stopPropagation();
    this.scheduleSegmentPreview(
      linkEl,
      segmentId,
      this.segmentTargetPathFromLinkElement(linkEl)
    );
  }

  handleSegmentLinkPreviewLeave(event) {
    const linkEl = this.segmentLinkElementFromEvent(event);
    if (!linkEl) {
      return;
    }
    const segmentId = this.segmentIdFromLinkElement(linkEl);
    if (!segmentId) {
      return;
    }

    const relatedTarget = event.relatedTarget;
    if (
      typeof Node !== "undefined" &&
      relatedTarget instanceof Node &&
      (linkEl.contains(relatedTarget) || this.segmentPreviewEl?.contains?.(relatedTarget))
    ) {
      return;
    }

    event.stopPropagation();
    this.scheduleHideSegmentPreview();
  }

  segmentLinkElementFromEvent(event) {
    const targetEl = event.target instanceof Element ? event.target : null;
    const linkEl = targetEl?.closest?.("a.lacan-segment-link, a.internal-link") || null;
    return this.isPotentialSegmentLinkElement(linkEl) ? linkEl : null;
  }

  isPotentialSegmentLinkElement(linkEl) {
    if (!linkEl) {
      return false;
    }
    if (linkEl.classList?.contains?.("lacan-segment-link")) {
      return true;
    }
    const target = (
      linkEl?.dataset?.lacanSegmentId ||
      linkEl?.getAttribute?.("data-href") ||
      linkEl?.getAttribute?.("href") ||
      ""
    );
    return String(target).includes("#");
  }

  segmentIdFromLinkElement(linkEl) {
    const datasetId = this.segmentIdFromLinkTarget(linkEl?.dataset?.lacanSegmentId || "");
    if (datasetId) {
      return datasetId;
    }

    const target = (
      linkEl?.getAttribute?.("data-href") ||
      linkEl?.getAttribute?.("href") ||
      ""
    );
    // Chapter note headings use native Obsidian navigation, not lesson lookup.
    const targetPath = this.segmentTargetPathFromLinkTarget(target);
    if (/^(?:texts\/[^/]+\/)?notes\//i.test(targetPath)) return "";
    const explicitTargetId = this.segmentIdFromExplicitLinkTarget(target);
    if (explicitTargetId) {
      return explicitTargetId;
    }

    return "";
  }

  segmentTargetPathFromLinkElement(linkEl) {
    const datasetTargetPath = String(
      linkEl?.dataset?.lacanSegmentTargetPath || ""
    ).trim();
    if (datasetTargetPath) {
      return normalizePath(datasetTargetPath);
    }

    const target = (
      linkEl?.getAttribute?.("data-href") ||
      linkEl?.getAttribute?.("href") ||
      ""
    );
    return this.segmentTargetPathFromLinkTarget(target);
  }

  segmentTargetPathFromLinkTarget(target) {
    const value = String(target || "").trim();
    if (!value.includes("#")) {
      return "";
    }

    let pathPart = value.split("#")[0].trim();
    if (!pathPart) {
      return "";
    }

    if (/^app:\/\/obsidian\.md\/+/i.test(pathPart)) {
      pathPart = pathPart.replace(/^app:\/\/obsidian\.md\/+/i, "");
    } else if (/^[a-z][a-z0-9+.-]*:/i.test(pathPart)) {
      return "";
    }

    return normalizePath(this.safeDecodeURIComponent(pathPart));
  }

  segmentDocumentLabel(targetPath = "") {
    return normalizePath(targetPath).includes("/original/") ? "原文" : "译文";
  }

  safeDecodeURIComponent(value) {
    try {
      return decodeURIComponent(value);
    } catch (_error) {
      return String(value || "");
    }
  }

  segmentIdFromExplicitLinkTarget(target) {
    const value = String(target || "").trim();
    if (!value.includes("#")) {
      return "";
    }
    return this.segmentIdFromLinkTarget(value);
  }

  segmentIdFromLinkTarget(target) {
    const value = String(target || "")
      .trim()
      .replace(/^#/, "")
      .split("#")
      .pop()
      .trim()
      .toLowerCase();
    return SEGMENT_ID_LINK_RE.test(value) ? value : "";
  }

  scheduleSegmentPreview(linkEl, segmentId, targetPath = "") {
    if (this.segmentPreviewHideTimer) {
      window.clearTimeout(this.segmentPreviewHideTimer);
      this.segmentPreviewHideTimer = null;
    }
    this.showSegmentPreview(linkEl, segmentId, targetPath);
  }

  scheduleHideSegmentPreview(delay = 180) {
    if (this.segmentPreviewHideTimer) {
      window.clearTimeout(this.segmentPreviewHideTimer);
    }
    this.segmentPreviewHideTimer = window.setTimeout(() => {
      this.segmentPreviewHideTimer = null;
      this.hideSegmentPreview();
    }, delay);
  }

  showSegmentPreview(linkEl, segmentId, targetPath = "") {
    const normalizedSegmentId = String(segmentId || "").trim().toLowerCase();
    if (!SEGMENT_ID_LINK_RE.test(normalizedSegmentId)) {
      return;
    }
    const documentLabel = this.segmentDocumentLabel(targetPath);

    this.hideSegmentPreview({ keepHideTimer: true });
    const previewEl = document.createElement("div");
    previewEl.className = "lacan-segment-preview-popover";
    previewEl.addEventListener("mouseenter", () => {
      if (this.segmentPreviewHideTimer) {
        window.clearTimeout(this.segmentPreviewHideTimer);
        this.segmentPreviewHideTimer = null;
      }
    });
    previewEl.addEventListener("mouseleave", () => this.scheduleHideSegmentPreview(120));

    const titleEl = previewEl.createDiv
      ? previewEl.createDiv("lacan-segment-preview-title")
      : previewEl.appendChild(document.createElement("div"));
    titleEl.className = "lacan-segment-preview-title";
    titleEl.textContent = `「${normalizedSegmentId}」${documentLabel}`;

    const contentEl = previewEl.createDiv
      ? previewEl.createDiv("lacan-segment-preview-content")
      : previewEl.appendChild(document.createElement("div"));
    contentEl.className = "lacan-segment-preview-content";
    contentEl.textContent = "加载中...";

    document.body.appendChild(previewEl);
    this.positionSegmentPreview(previewEl, linkEl);
    this.segmentPreviewEl = previewEl;
    const token = ++this.segmentPreviewRenderToken;

    this.loadSegmentPreviewContent(normalizedSegmentId, targetPath)
      .then(({ content, sourcePath }) => {
        if (token !== this.segmentPreviewRenderToken || !contentEl.isConnected) {
          return null;
        }
        return this.renderSegmentMarkdownContent(contentEl, content, sourcePath);
      })
      .catch((error) => {
        if (token === this.segmentPreviewRenderToken && contentEl.isConnected) {
          contentEl.textContent = `无法读取对应${documentLabel}段落：${error.message}`;
        }
      });
  }

  positionSegmentPreview(previewEl, anchorEl) {
    const rect = anchorEl.getBoundingClientRect();
    const margin = 10;
    const width = Math.min(520, Math.max(320, window.innerWidth - margin * 2));
    previewEl.style.width = `${width}px`;
    let left = Math.min(rect.left, window.innerWidth - width - margin);
    left = Math.max(margin, left);
    const estimatedHeight = Math.min(360, Math.max(160, previewEl.offsetHeight || 220));
    let top = rect.bottom + margin;
    if (top + estimatedHeight > window.innerHeight - margin) {
      top = Math.max(margin, rect.top - estimatedHeight - margin);
    }
    previewEl.style.left = `${left + window.scrollX}px`;
    previewEl.style.top = `${top + window.scrollY}px`;
  }

  hideSegmentPreview({ keepHideTimer = false } = {}) {
    if (!keepHideTimer && this.segmentPreviewHideTimer) {
      window.clearTimeout(this.segmentPreviewHideTimer);
      this.segmentPreviewHideTimer = null;
    }
    if (this.segmentPreviewEl) {
      this.unloadMarkdownRenderComponents(this.segmentPreviewEl);
      this.segmentPreviewEl.remove();
      this.segmentPreviewEl = null;
      this.segmentPreviewRenderToken += 1;
    }
  }

  async loadSegmentPreviewContent(segmentId, targetPath = "") {
    const normalizedSegmentId = String(segmentId || "").trim().toLowerCase();
    const match = normalizedSegmentId.match(SEGMENT_ID_LINK_RE);
    if (!match) {
      throw new Error(`不是有效的分段 ID：${segmentId}`);
    }

    const normalizedTargetPath = normalizePath(targetPath || "");
    const cacheKey = this.segmentCacheKey(
      normalizedTargetPath || "auto",
      normalizedSegmentId
    );
    if (this.segmentPreviewCache.has(cacheKey)) {
      return this.segmentPreviewCache.get(cacheKey);
    }

    let file = this.fileFromSegmentTargetPath(normalizedTargetPath);
    let seminarSlug = "";
    const seminarCode = `s${match[1]}`.toLowerCase();
    const lessonNumber = Number(match[2]);
    if (!(file instanceof TFile)) {
      seminarSlug = this.findSeminarSlugForCode(seminarCode);
      if (!seminarSlug) {
        throw new Error(`找不到对应研讨班：${seminarCode}`);
      }
      file = this.findSegmentLessonFile(seminarSlug, lessonNumber);
    }
    if (!(file instanceof TFile)) {
      throw new Error(`找不到对应课文：${seminarSlug} Leçon ${String(lessonNumber).padStart(2, "0")}`);
    }

    const promise = this.app.vault.cachedRead(file).then((text) => ({
      sourcePath: file.path,
      content: this.segmentPreviewContent(text, normalizedSegmentId),
    }));
    this.segmentPreviewCache.set(cacheKey, promise);
    return promise;
  }

  segmentPreviewContent(text, segmentId) {
    const normalizedSegmentId = String(segmentId || "").trim().toLowerCase();
    const content = this.extractSegmentsById(String(text || "")).get(normalizedSegmentId) || "";
    return content
      .split(/\r?\n/)
      .filter((line) => !this.isReadingNoteLinkLine(line))
      .join("\n")
      .trim();
  }

  async openSegmentId(segmentId, targetPath = "") {
    const normalizedSegmentId = String(segmentId || "").trim().toLowerCase();
    const match = normalizedSegmentId.match(SEGMENT_ID_LINK_RE);
    if (!match) {
      throw new Error(`不是有效的分段 ID：${segmentId}`);
    }

    const explicitFile = this.fileFromSegmentTargetPath(targetPath);
    const file = explicitFile || this.findSegmentLessonFileForIdMatch(match);
    if (!(file instanceof TFile)) {
      const seminarCode = `s${match[1]}`.toLowerCase();
      const lessonNumber = Number(match[2]);
      throw new Error(`找不到对应课文：${seminarCode} Leçon ${String(lessonNumber).padStart(2, "0")}`);
    }

    const text = await this.app.vault.cachedRead(file);
    const location = this.findSegmentLocation(text, normalizedSegmentId);
    if (!location) {
      if (explicitFile) {
        throw new Error(`目标文件中没有找到分段：${file.path}#${normalizedSegmentId}`);
      }
      throw new Error(`已找到课文文件，但没有找到分段：${normalizedSegmentId}`);
    }

    await this.openFile(file, this.openStateForSegmentLocation(location));
    const revealed = await this.revealSegmentAfterOpen(normalizedSegmentId, file, location);
    if (!revealed) {
      new Notice(`已打开课文，但暂时无法定位分段：${normalizedSegmentId}`);
    }
  }

  findSegmentLessonFileForIdMatch(match) {
    const seminarCode = `s${match[1]}`.toLowerCase();
    const lessonNumber = Number(match[2]);
    const seminarSlug = this.findSeminarSlugForCode(seminarCode);
    if (!seminarSlug) {
      return null;
    }
    return this.findSegmentLessonFile(seminarSlug, lessonNumber);
  }

  findSegmentLocation(text, segmentId) {
    const normalizedSegmentId = String(segmentId || "").toLowerCase();
    const marker = this.extractSegmentMarkers(text).find((item) => item.ids.includes(normalizedSegmentId));
    if (!marker) {
      return null;
    }

    const line = Math.max(0, Number(marker.targetLine) || 0);
    return {
      line,
      col: 0,
      offset: this.offsetAtLine(text, line),
    };
  }

  offsetAtLine(text, lineNumber) {
    const sourceText = String(text || "");
    const targetLine = Math.max(0, Number(lineNumber) || 0);
    let line = 0;
    for (let index = 0; index < sourceText.length; index += 1) {
      if (line === targetLine) {
        return index;
      }
      if (sourceText.charCodeAt(index) === 10) {
        line += 1;
      }
    }
    return sourceText.length;
  }

  openStateForSegmentLocation(location) {
    const loc = this.normalizedLoc(location);
    return {
      active: true,
      eState: this.ephemeralStateForSegmentLocation(loc),
    };
  }

  ephemeralStateForSegmentLocation(location) {
    const loc = this.normalizedLoc(location);
    return {
      line: loc.line,
      startLoc: loc,
      endLoc: loc,
    };
  }

  normalizedLoc(location) {
    return {
      line: Math.max(0, Number(location?.line) || 0),
      col: Math.max(0, Number(location?.col) || 0),
      offset: Math.max(0, Number(location?.offset) || 0),
    };
  }

  fileFromSegmentTargetPath(targetPath) {
    const normalizedPath = normalizePath(targetPath || "");
    if (!this.isTextMarkdownPath(normalizedPath)) {
      return null;
    }

    const file = this.app.vault.getAbstractFileByPath(normalizedPath);
    return file instanceof TFile ? file : null;
  }

  findSeminarSlugForCode(seminarCode) {
    const prefix = "texts/";
    const seen = new Set();
    for (const file of this.app.vault.getAllLoadedFiles()) {
      const path = normalizePath(file.path || "");
      if (!path.startsWith(prefix)) {
        continue;
      }
      const slug = path.slice(prefix.length).split("/", 1)[0];
      if (!slug || seen.has(slug)) {
        continue;
      }
      seen.add(slug);
      if (slug.split("-", 1)[0].toLowerCase() === seminarCode) {
        return slug;
      }
    }
    return "";
  }

  findSegmentLessonFile(seminarSlug, lessonNumber) {
    const padded = String(lessonNumber).padStart(2, "0");
    const names = [`Leçon-${padded}.md`, `Lecon-${padded}.md`, `lesson-${padded}.md`];
    for (const folder of ["translation", "original"]) {
      for (const name of names) {
        const file = this.app.vault.getAbstractFileByPath(`texts/${seminarSlug}/${folder}/${name}`);
        if (file instanceof TFile) {
          return file;
        }
      }
    }
    return null;
  }

  async revealSegmentAfterOpen(segmentId, file, location) {
    const loc = this.normalizedLoc(location);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await this.nextAnimationFrame();
      if (file instanceof TFile && !this.activeFileMatches(file)) {
        await this.delay(40);
        continue;
      }

      this.applySegmentEphemeralState(loc);
      if (await this.scrollActiveEditorToLocation(loc)) {
        return true;
      }
      if (await this.scrollActivePreviewToSegment(segmentId)) {
        return true;
      }

      await this.delay(40);
    }
    return false;
  }

  applySegmentEphemeralState(location) {
    const view = Obsidian.MarkdownView
      ? this.app.workspace.getActiveViewOfType(Obsidian.MarkdownView)
      : this.app.workspace.activeLeaf?.view;
    if (typeof view?.setEphemeralState === "function") {
      view.setEphemeralState(this.ephemeralStateForSegmentLocation(location));
    }
  }

  async scrollActiveViewToSegment(segmentId, file = null) {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await this.nextAnimationFrame();
      if (file instanceof TFile && !this.activeFileMatches(file)) {
        await this.delay(40);
        continue;
      }

      if (await this.scrollActiveEditorToSegment(segmentId)) {
        return true;
      }
      if (await this.scrollActivePreviewToSegment(segmentId)) {
        return true;
      }

      await this.delay(40);
    }
    return false;
  }

  activeFileMatches(file) {
    const activeFile = this.app.workspace.getActiveFile();
    return (
      activeFile instanceof TFile &&
      normalizePath(activeFile.path) === normalizePath(file.path)
    );
  }

  nextAnimationFrame() {
    if (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") {
      return new Promise((resolve) => window.requestAnimationFrame(resolve));
    }
    return this.delay(0);
  }

  delay(milliseconds) {
    const setTimer = typeof window !== "undefined" && typeof window.setTimeout === "function"
      ? window.setTimeout.bind(window)
      : setTimeout;
    return new Promise((resolve) => setTimer(resolve, milliseconds));
  }

  async scrollActiveEditorToLocation(location) {
    const view = Obsidian.MarkdownView
      ? this.app.workspace.getActiveViewOfType(Obsidian.MarkdownView)
      : this.app.workspace.activeLeaf?.view;
    const editor = view?.editor;
    if (!editor) {
      return false;
    }

    const loc = this.normalizedLoc(location);
    const position = { line: loc.line, ch: loc.col };
    editor.setCursor(position);
    editor.scrollIntoView({ from: position, to: position }, true);
    return true;
  }

  async scrollActiveEditorToSegment(segmentId) {
    const view = Obsidian.MarkdownView
      ? this.app.workspace.getActiveViewOfType(Obsidian.MarkdownView)
      : this.app.workspace.activeLeaf?.view;
    const editor = view?.editor;
    if (!editor) {
      return false;
    }

    const line = this.findSegmentLine(editor.getValue(), segmentId);
    if (line < 0) {
      return false;
    }

    const position = { line, ch: 0 };
    editor.setCursor(position);
    editor.scrollIntoView({ from: position, to: position }, true);
    return true;
  }

  async scrollActivePreviewToSegment(segmentId) {
    const view = Obsidian.MarkdownView
      ? this.app.workspace.getActiveViewOfType(Obsidian.MarkdownView)
      : this.app.workspace.activeLeaf?.view;
    const file = this.app.workspace.getActiveFile();
    const previewEl = view?.containerEl?.querySelector?.(".markdown-preview-view");
    if (!(file instanceof TFile) || !previewEl) {
      return false;
    }

    const text = await this.app.vault.cachedRead(file);
    const normalizedSegmentId = String(segmentId || "").toLowerCase();
    const marker = this.extractSegmentMarkers(text).find((item) => item.ids.includes(normalizedSegmentId));
    if (!marker) {
      return false;
    }

    const anchorEl = this.findRenderedSegmentAnchor(previewEl, marker, new Set());
    if (!anchorEl) {
      return false;
    }
    anchorEl.scrollIntoView({ block: "center", behavior: "smooth" });
    anchorEl.classList.add("lacan-segment-target-flash");
    window.setTimeout(() => anchorEl.classList.remove("lacan-segment-target-flash"), 1600);
    return true;
  }

  findSegmentLine(text, segmentId) {
    const normalizedSegmentId = String(segmentId || "").toLowerCase();
    const marker = this.extractSegmentMarkers(text).find((item) => item.ids.includes(normalizedSegmentId));
    return marker ? marker.targetLine : -1;
  }

  async createTranslationForOriginal(originalFile, options = {}) {
    const paths = this.pathsFromOriginal(originalFile.path);
    if (!paths) {
      throw new Error("不是有效的原文课文路径。");
    }

    const existing = this.app.vault.getAbstractFileByPath(paths.translationPath);
    if (existing instanceof TFile) {
      await this.fillTranslationIfEmpty(existing, options);
      return existing;
    }

    const originalText = await this.app.vault.read(originalFile);
    const skeleton = this.buildSkeleton(originalFile.path, originalText);
    await this.ensureFolder(paths.translationFolder);
    const created = await this.app.vault.create(paths.translationPath, skeleton);
    if (options.updateProgress !== false) {
      await this.updateTranslationProgress(created);
    }

    if (options.openAfterCreate) {
      await this.openFile(created);
    }
    if (options.notify) {
      new Notice(`已创建译文骨架：${paths.translationPath}`);
    }
    return created;
  }

  async fillTranslationIfEmpty(translationFile, options = {}) {
    const paths = this.pathsFromTranslation(translationFile.path);
    if (!paths) {
      throw new Error("不是有效的译文课文路径。");
    }

    const currentText = await this.app.vault.read(translationFile);
    if (currentText.trim().length > 0) {
      if (options.updateProgress) {
        await this.updateTranslationProgress(translationFile);
      }
      if (options.openAfterCreate) {
        await this.openFile(translationFile);
      }
      if (options.notify && options.notifyExisting) {
        new Notice("译文文件已有内容，未覆盖。");
      }
      return translationFile;
    }

    const originalFile = this.app.vault.getAbstractFileByPath(paths.originalPath);
    if (!(originalFile instanceof TFile)) {
      throw new Error(`找不到对应原文：${paths.originalPath}`);
    }

    const originalText = await this.app.vault.read(originalFile);
    const skeleton = this.buildSkeleton(originalFile.path, originalText);
    let filled = false;
    await this.app.vault.process(translationFile, (latestText) => {
      filled = latestText.trim().length === 0;
      return filled ? skeleton : latestText;
    });
    if (filled ? options.updateProgress !== false : options.updateProgress) {
      await this.updateTranslationProgress(translationFile);
    }

    if (options.openAfterCreate) {
      await this.openFile(translationFile);
    }
    if (options.notify && filled) {
      new Notice(`已填充译文骨架：${translationFile.path}`);
    } else if (options.notify && options.notifyExisting) {
      new Notice("译文文件已有内容，未覆盖。");
    }
    return translationFile;
  }

  scheduleProgressUpdate(path) {
    const normalized = normalizePath(path);
    const existing = this.progressTimers.get(normalized);
    if (existing) {
      window.clearTimeout(existing);
    }

    const timer = window.setTimeout(async () => {
      this.progressTimers.delete(normalized);
      if (this.syncInProgress) return;
      await this.runWithNotice(
        () => this.updateTranslationProgressByPath(normalized),
        "翻译进度更新失败"
      );
    }, 500);
    this.progressTimers.set(normalized, timer);
  }

  async updateTranslationProgressByPath(path) {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      return null;
    }
    return this.updateTranslationProgress(file);
  }

  async updateAllTranslationProgress() {
    const files = this.app.vault
      .getMarkdownFiles()
      .filter((file) => this.isTranslationLessonPath(file.path));

    let updated = 0;
    for (const file of files) {
      const changed = await this.updateTranslationProgress(file);
      if (changed) {
        updated += 1;
      }
    }

    new Notice(`已更新 ${updated}/${files.length} 个译文进度。`);
  }

  async updateTranslationProgress(translationFile) {
    const paths = this.pathsFromTranslation(translationFile.path);
    if (!paths) {
      throw new Error("不是有效的译文课文路径。");
    }

    const translationText = await this.app.vault.read(translationFile);
    const originalFile = this.app.vault.getAbstractFileByPath(paths.originalPath);
    const originalText = originalFile instanceof TFile ? await this.app.vault.read(originalFile) : "";
    const stats = this.calculateTranslationProgress(translationText, originalText);
    const values = {
      translation_progress: stats.progress,
      translation_progress_label: stats.progressLabel,
      untranslated_count: stats.untranslatedCount,
      max_segment_id: stats.maxSegmentId,
    };

    const currentFrontmatter = this.app.metadataCache.getFileCache(translationFile)?.frontmatter || {};
    if (!this.frontmatterNeedsUpdate(currentFrontmatter, values)) {
      return false;
    }

    this.suppressProgressModifyEvent(translationFile.path);
    await this.app.fileManager.processFrontMatter(translationFile, (frontmatter) => {
      for (const [key, value] of Object.entries(values)) {
        frontmatter[key] = value;
      }
    });

    return true;
  }

  suppressProgressModifyEvent(path) {
    const normalized = normalizePath(path);
    const existing = this.progressWriteSuppressTimers.get(normalized);
    if (existing) {
      window.clearTimeout(existing);
    }

    this.progressWritePaths.add(normalized);
    const timer = window.setTimeout(() => {
      this.progressWritePaths.delete(normalized);
      this.progressWriteSuppressTimers.delete(normalized);
      if (this.progressDirtyPaths.delete(normalized)) {
        this.scheduleProgressUpdate(normalized);
      }
    }, 1000);
    this.progressWriteSuppressTimers.set(normalized, timer);
  }

  calculateTranslationProgress(translationText, originalText = "") {
    const untranslatedCount = this.countMatches(translationText, UNTRANSLATED_RE);
    const maxSegmentId = Math.max(
      this.maxSegmentIdNumber(originalText),
      this.maxSegmentIdNumber(translationText)
    );
    const ratio = maxSegmentId > 0 ? 1 - untranslatedCount / maxSegmentId : 0;
    const progress = Math.max(0, Math.min(100, ratio * 100));
    const rounded = Math.round(progress * 100) / 100;

    return {
      untranslatedCount,
      maxSegmentId,
      progress: rounded,
      progressLabel: `${rounded.toFixed(2)}%`,
    };
  }

  countMatches(text, regexp) {
    regexp.lastIndex = 0;
    let count = 0;
    while (regexp.exec(text) !== null) {
      count += 1;
    }
    return count;
  }

  maxSegmentIdNumber(text) {
    SEGMENT_ID_RE.lastIndex = 0;
    let max = 0;
    let match;
    while ((match = SEGMENT_ID_RE.exec(text)) !== null) {
      max = Math.max(max, Number(match[1]));
    }
    return max;
  }

  frontmatterNeedsUpdate(frontmatter, values) {
    return Object.entries(values).some(([key, value]) => frontmatter[key] !== value);
  }

  buildSkeleton(originalPath, originalText) {
    const title = this.extractTitle(originalText) || this.fallbackTitle(originalPath);
    const seminar = this.extractCommentValue(originalText, SEMINAR_RE) || this.seminarFromPath(originalPath);
    const lesson = this.extractCommentValue(originalText, LESSON_RE) || this.lessonFromPath(originalPath);
    const ids = this.extractParagraphIds(originalText);

    if (ids.length === 0) {
      throw new Error("原文中没有找到分段 ID。");
    }

    const lines = [
      title,
      "",
      `<!-- source-original: ${originalPath} -->`,
      "",
      `<!-- seminar: ${seminar} -->`,
      "",
      `<!-- lesson: ${lesson} -->`,
      "",
    ];

    for (const id of ids) {
      lines.push(`<!-- id: ${id} -->`, "", "<!-- untranslated -->", "");
    }

    return `${lines.join("\n").replace(/\n+$/, "")}\n`;
  }

  extractTitle(text) {
    for (const line of text.split(/\r?\n/)) {
      if (line.startsWith("#")) {
        return line.trim();
      }
      if (line.trim()) {
        break;
      }
    }
    return "";
  }

  extractCommentValue(text, regexp) {
    const match = regexp.exec(text);
    return match ? match[1].trim() : "";
  }

  extractParagraphIds(text) {
    const ids = [];
    const seen = new Set();
    for (const match of this.segmentCommentMatches(text)) {
      for (const id of match.ids) {
        if (!seen.has(id)) {
          ids.push(id);
          seen.add(id);
        }
      }
    }
    return ids;
  }

  fallbackTitle(path) {
    const lesson = this.lessonFromPath(path);
    return `# Leçon ${lesson}`;
  }

  seminarFromPath(path) {
    const match = path.match(/^texts\/([^/]+)\//);
    return match ? match[1].split("-")[0].toLowerCase() : "";
  }

  seminarSlugFromPath(path) {
    const match = normalizePath(path).match(/^texts\/([^/]+)\//);
    return match ? match[1] : "";
  }

  lessonFromPath(path) {
    const name = path.split("/").pop() || "";
    const match = name.match(LESSON_FILE_RE);
    return match ? match[1] : "";
  }

  isOriginalLessonPath(path) {
    return ORIGINAL_PATH_RE.test(normalizePath(path));
  }

  isTranslationLessonPath(path) {
    return TRANSLATION_PATH_RE.test(normalizePath(path));
  }

  isSegmentAiLessonPath(path) {
    return this.isTranslationLessonPath(path) || this.isOriginalLessonPath(path);
  }

  pathsFromOriginal(path) {
    const normalized = normalizePath(path);
    const match = normalized.match(ORIGINAL_PATH_RE);
    if (!match) {
      return null;
    }
    const translationPath = normalized.replace("/original/", "/translation/");
    return {
      originalPath: normalized,
      translationPath,
      translationFolder: translationPath.split("/").slice(0, -1).join("/"),
    };
  }

  pathsFromTranslation(path) {
    const normalized = normalizePath(path);
    const match = normalized.match(TRANSLATION_PATH_RE);
    if (!match) {
      return null;
    }
    const originalPath = normalized.replace("/translation/", "/original/");
    return {
      originalPath,
      translationPath: normalized,
      translationFolder: normalized.split("/").slice(0, -1).join("/"),
    };
  }

  async ensureFolder(folderPath) {
    const parts = normalizePath(folderPath).split("/").filter(Boolean);
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (!this.app.vault.getAbstractFileByPath(current)) {
        await this.app.vault.createFolder(current);
      }
    }
  }

  async openFile(file, openState = undefined) {
    await this.app.workspace.getLeaf(false).openFile(file, openState);
  }

  async openReadingNoteOnLeft(file, sourceLeaf = this.app.workspace.activeLeaf) {
    const workspace = this.app.workspace;
    const leaves = workspace.getLeavesOfType("markdown");
    const anchor = sourceLeaf || workspace.getMostRecentLeaf();
    if (!anchor) throw new Error("找不到可用于打开章节笔记的正文窗口。");
    const paneBounds = (leaf) => {
      const element = leaf.view.containerEl;
      // Use the tab group so a note behind another tab can still be reused.
      return (element?.closest?.(".workspace-tabs") || element)?.getBoundingClientRect();
    };
    const sourceBounds = paneBounds(anchor);
    const leftNotes = leaves.filter((leaf) => {
      if (leaf === anchor || !this.isReadingNotePath(leaf.view.file?.path)) return false;
      if (leaf.view.containerEl?.ownerDocument !== anchor.view.containerEl?.ownerDocument) return false;
      const bounds = paneBounds(leaf);
      return bounds?.width > 0 && sourceBounds?.width > 0 && bounds.right <= sourceBounds.left + 1;
    });
    const existing = leftNotes.find((leaf) => leaf.view.file?.path === file.path);
    const reusable = leftNotes.includes(this.readingNoteLeaf) ? this.readingNoteLeaf : leftNotes[0];

    const activeLeaf = workspace.activeLeaf;
    const focusedElement = activeLeaf?.view.containerEl?.ownerDocument.activeElement;
    const leaf = existing || (reusable || workspace.createLeafBySplit(anchor, "vertical", true));
    this.readingNoteLeaf = leaf;
    try {
      if (leaf.view.file?.path !== file.path) await leaf.openFile(file, { active: false });
      // Select the note tab without focusing its editor, then keep the source active.
      // This also reveals a note hidden behind another tab in the same split.
      if (workspace.activeLeaf === activeLeaf || workspace.activeLeaf === leaf) {
        workspace.setActiveLeaf(leaf, { focus: false });
        if (activeLeaf) workspace.setActiveLeaf(activeLeaf, { focus: false });
      }
    } finally {
      if (activeLeaf && workspace.activeLeaf === leaf) {
        workspace.setActiveLeaf(activeLeaf, { focus: false });
      }
      // Only undo focus taken by the note; never override navigation made while awaiting I/O.
      if (workspace.activeLeaf === activeLeaf && focusedElement?.isConnected
        && leaf.view.containerEl?.contains(focusedElement.ownerDocument.activeElement)) {
        focusedElement.focus({ preventScroll: true });
      }
    }
  }
};

class LacanTranslationHelperSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
    this.activeSettingsTab = "project";
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Lacan Translation Helper" });
    this.renderSettingsTabs(containerEl);

    if (this.activeSettingsTab === "ai") {
      this.renderSegmentAiSettings(containerEl);
      return;
    }
    if (this.activeSettingsTab === "french") {
      this.renderFrenchLookupSettings(containerEl);
      return;
    }

    new Setting(containerEl)
      .setName("默认优化项目关系图")
      .setDesc("打开全局图谱时只显示知识卡片（绿色）与翻译正文（蓝色），排除 README、索引页、附件和未解析链接，并隐藏孤立节点。关闭后可自行调整图谱筛选；局部图谱不受影响。")
      .addToggle((toggle) => {
        toggle.setValue(Boolean(this.plugin.settings.projectGraphEnabled))
          .onChange(async (value) => {
            this.plugin.settings.projectGraphEnabled = value;
            await this.plugin.saveSettings();
            if (value) {
              await this.plugin.configureProjectGraph({ force: true });
            }
          });
      });

    new Setting(containerEl)
      .setName("知识卡片与翻译关系图")
      .setDesc("查看卡片之间以及卡片与译文章节之间已有的链接关系。")
      .addButton((button) => {
        button.setButtonText("打开关系图")
          .onClick(() => this.plugin.runWithNotice(
            () => this.plugin.openProjectGraph(),
            "项目关系图打开失败"
          ));
      });

    let proxyAddressInput;
    new Setting(containerEl)
      .setName("启用插件 HTTP 代理")
      .setDesc("用于文库同步、词典查询和生词本请求。关闭时沿用 Obsidian 的网络设置；AI CLI 使用自身的网络配置。")
      .addToggle((toggle) => toggle
        .setValue(Boolean(this.plugin.settings.pluginHttpProxyEnabled))
        .onChange(async (value) => {
          this.plugin.settings.pluginHttpProxyEnabled = value;
          proxyAddressInput?.setDisabled(!value);
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("插件 HTTP 代理地址")
      .setDesc("启用后生效。填写 HTTP 或 HTTPS 代理地址，例如 http://127.0.0.1:7890。")
      .addText((text) => {
        proxyAddressInput = text;
        text.setPlaceholder("http://127.0.0.1:7890")
          .setValue(this.plugin.settings.pluginHttpProxyUrl || "")
          .setDisabled(!this.plugin.settings.pluginHttpProxyEnabled)
          .onChange(async (value) => {
            this.plugin.settings.pluginHttpProxyUrl = value.trim();
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("文库同步地址")
      .setDesc("获取课文和知识词条目录，在 Base 中按课、按词条同步正文与附件。")
      .addText((text) => text
        .setPlaceholder(DEFAULT_PROJECT_ENDPOINT)
        .setValue(this.plugin.settings.projectEndpointUrl || DEFAULT_PROJECT_ENDPOINT)
        .onChange(async (value) => {
          this.plugin.settings.projectEndpointUrl = value.trim() || DEFAULT_PROJECT_ENDPOINT;
          this.plugin.projectCatalog = null;
          this.plugin.projectLessonSyncProgress?.clear();
          this.plugin.knowledgeSyncProgress?.clear();
          this.plugin.getKnowledgeLibrary().statuses = {};
          this.plugin.getKnowledgeLibrary().failures = {};
          this.plugin.settings.projectLessonSync = {};
          await this.plugin.saveSettings();
          this.plugin.refreshProjectCatalogViews();
        }));

    new Setting(containerEl)
      .setName("本地笔记与修改保护")
      .setDesc("课文或知识卡及引用附件有本地修改时，跳过本课或本词条。需要重新同步时，请先保留修改副本，再删除有改动的本地文件后同步。未保存的编辑同样受保护。");

    new Setting(containerEl)
      .setName("启动时更新文库目录")
      .setDesc("仅刷新已发布课次和知识词条目录，不下载正文。首次安装会自动获取目录。")
      .addToggle((toggle) => toggle
        .setValue(Boolean(this.plugin.settings.autoSyncOnStartup))
        .onChange(async (value) => {
          this.plugin.settings.autoSyncOnStartup = value;
          await this.plugin.saveSettings();
        }));

    let cancelSyncButton;
    new Setting(containerEl)
      .setName("更新文库目录")
      .setDesc("只更新目录。在 Base 的文本清单中逐课同步原译文，或在知识库中搜索并同步所需词条。")
      .addButton((button) => button
        .setButtonText(this.plugin.syncInProgress ? "处理中…" : "更新清单")
        .setCta()
        .setDisabled(this.plugin.syncInProgress)
        .onClick(async () => {
          button.setDisabled(true);
          button.setButtonText("同步中…");
          cancelSyncButton?.setDisabled(false);
          try { await this.plugin.runWithNotice(() => this.plugin.syncConfiguredRepositories({ notify: true }), "文库同步失败"); }
          finally { this.display(); }
        }))
      .addButton((button) => {
        cancelSyncButton = button;
        button.setButtonText("取消同步")
          .setDisabled(!this.plugin.syncInProgress)
          .onClick(() => this.plugin.cancelProjectSync());
      })
      .addButton((button) => {
        button.setButtonText("打开 Base")
          .onClick(() => this.plugin.runWithNotice(() => this.plugin.openProjectLibrary(), "打开文本清单失败"));
      });

    const summary = this.plugin.settings.projectSyncLastResult;
    new Setting(containerEl)
      .setName("最近同步与跳过记录")
      .setDesc(summary
        ? `最近检查版本 ${summary.version}；新增 ${summary.added}，更新 ${summary.updated}，跳过 ${summary.skippedCount || 0}，保留的旧版冲突记录 ${summary.conflictCount || 0}。最近检查：${new Date(summary.checkedAt).toLocaleString()}`
        : "尚未同步。已有本地修改的文本会整课跳过；删除文件后可重新下载。")
      .addButton((button) => button
        .setButtonText("查看同步报告")
        .setDisabled(!summary)
        .onClick(() => this.plugin.runWithNotice(() => this.plugin.showProjectSyncReport(), "打开同步报告失败")));
  }

  renderSettingsTabs(containerEl) {
    const tabsEl = containerEl.createDiv("lacan-settings-tabs");
    tabsEl.setAttribute("role", "tablist");
    tabsEl.setAttribute("aria-label", "插件设置分类");
    const tabs = [
      { id: "project", label: "项目与同步" },
      { id: "ai", label: "AI 功能" },
      { id: "french", label: "法语取词" },
    ];
    for (const tab of tabs) {
      const active = this.activeSettingsTab === tab.id;
      const button = tabsEl.createEl("button", {
        cls: `lacan-settings-tab${active ? " is-active" : ""}`,
        text: tab.label,
        attr: {
          type: "button",
          role: "tab",
          "aria-selected": active ? "true" : "false",
          tabindex: active ? "0" : "-1",
        },
      });
      button.addEventListener("click", () => {
        if (this.activeSettingsTab === tab.id) {
          return;
        }
        this.activeSettingsTab = tab.id;
        this.display();
      });
    }
  }

  renderFrenchLookupSettings(parentEl) {
    parentEl.createEl("h3", { text: "法语取词与欧路生词本" });
    new Setting(parentEl)
      .setName("启用取词浮窗")
      .setDesc("在正文、阅读视图和双语阅读中取词。保留原选区、法语重音、省音及连字符。")
      .addToggle((toggle) => toggle.setValue(this.plugin.settings.frenchLookupEnabled)
        .onChange(async (value) => {
          this.plugin.settings.frenchLookupEnabled = value;
          if (!value) { this.plugin.frenchLookupPopup?.close(); }
          await this.plugin.saveSettings();
        }));
    new Setting(parentEl)
      .setName("显示释义的方式")
      .setDesc("选中后自动查询，也可改为双击单词后查询。右键菜单和命令面板均可手动取词。")
      .addDropdown((dropdown) => dropdown
        .addOption("selection", "选中后显示释义")
        .addOption("double-click", "双击后显示释义")
        .setValue(this.plugin.settings.frenchLookupTrigger)
        .onChange(async (value) => {
          this.plugin.settings.frenchLookupTrigger = value;
          this.plugin.frenchLookupPopup?.close();
          await this.plugin.saveSettings();
        }));
    new Setting(parentEl)
      .setName("选中短语或句子后自动翻译")
      .setDesc("使用“AI 功能”中配置的本地 Agent 与模型，发送选区和附近一句上下文；给出中文试译及阴阳性、配合、变位等语法说明。关闭后可在浮窗中手动点击“翻译”。")
      .addToggle((toggle) => toggle.setValue(this.plugin.settings.frenchLookupAutoTranslate)
        .onChange(async (value) => {
          this.plugin.settings.frenchLookupAutoTranslate = value;
          await this.plugin.saveSettings();
        }));
    const helpEl = parentEl.createDiv("lacan-french-settings-help setting-item-description");
    helpEl.createEl("p", { text: "词典释义来自法语助手在线词典；生词本使用欧路官方 API，语言固定为法语。反查结果有歧义时会列出候选词元，不自动替换成某个原形。" });
    helpEl.createEl("a", {
      text: `获取法语助手 API 授权码：${EUDIC_AUTHORIZATION_URL}`,
      attr: { href: EUDIC_AUTHORIZATION_URL, target: "_blank", rel: "noopener noreferrer" },
    });
    const secretSetting = new Setting(parentEl)
      .setName("欧路 API 授权码")
      .setDesc("只用于读取你的法语生词本及手动收藏单词。授权码保存在 Obsidian 密钥存储中，插件设置只记录密钥名称。");
    if (this.app.secretStorage?.getSecret && this.app.secretStorage?.setSecret) {
      secretSetting.addButton((button) => button.setButtonText("设置授权码")
        .onClick(() => openEudicTokenModal(this.plugin, () => this.display())));
    } else {
      secretSetting.setDesc("当前 Obsidian 不支持密钥存储。可临时填写授权码，仅在本次运行中使用；升级 Obsidian 后可安全保存。");
      secretSetting.addText((text) => {
        text.inputEl.type = "password";
        text.setPlaceholder("仅本次运行使用，不写入设置文件")
          .onChange((value) => { this.plugin.eudicSessionToken = value; });
      });
    }
    new Setting(parentEl)
      .setName("读取法语生词本")
      .setDesc("保存授权码后点击读取，再选择收藏目标。不会新增或删除已有单词。")
      .addButton((button) => button.setButtonText("读取生词本")
        .onClick(async () => {
          button.setDisabled(true);
          try {
            const books = await this.plugin.frenchDictionaryService.listWordbooks();
            this.plugin.settings.frenchLookupWordbooks = books;
            if (!books.some((book) => book.id === this.plugin.settings.frenchLookupWordbookId)) {
              this.plugin.settings.frenchLookupWordbookId = books[0]?.id || "0";
            }
            await this.plugin.saveSettings();
            new Notice(`已读取 ${books.length} 个法语生词本。`);
            void this.plugin.frenchLookupPopup?.syncWordbookState();
            this.display();
          } catch (error) {
            new Notice(error.message || "无法读取生词本，请检查授权码。");
          } finally { button.setDisabled(false); }
        }));
    new Setting(parentEl)
      .setName("收藏到生词本")
      .setDesc("点击浮窗中的收藏按钮时使用。词形已反查时收藏词典确认的词元，并在浮窗保留原选区。")
      .addDropdown((dropdown) => {
        const books = this.plugin.settings.frenchLookupWordbooks;
        if (!books.length) {
          dropdown.addOption(this.plugin.settings.frenchLookupWordbookId || "0", "默认生词本（尚未读取）");
        } else {
          for (const book of books) { dropdown.addOption(book.id, book.name); }
        }
        dropdown.setValue(this.plugin.settings.frenchLookupWordbookId || "0")
          .onChange(async (id) => {
            this.plugin.settings.frenchLookupWordbookId = id;
            await this.plugin.saveSettings();
            void this.plugin.frenchLookupPopup?.syncWordbookState();
          });
      });
    let testWord = "L’identification";
    new Setting(parentEl)
      .setName("测试取词")
      .setDesc("输入一个法语单词或变形，查看取词浮窗与词典反查结果。")
      .addText((text) => text.setValue(testWord).setPlaceholder("例如：étaient、chevaux")
        .onChange((value) => { testWord = value; }))
      .addButton((button) => button.setButtonText("查词").onClick(() => {
        const lookup = buildFrenchLookup(testWord);
        if (lookup) {
          void this.plugin.frenchLookupPopup.showLookup(lookup, button.buttonEl.getBoundingClientRect(), {
            mode: "dictionary", doc: button.buttonEl.ownerDocument,
          });
        } else { new Notice("请输入有效的法语单词或短语。"); }
      }));
  }

  renderSegmentAiProviderSettings(containerEl) {
    const plugin = this.plugin;
    const selected = normalizeProvider(plugin.settings.segmentAiProvider);
    new Setting(containerEl)
      .setName("CLI 工具")
      .setDesc("分段解读和法语语境翻译使用此工具。每种工具独立保存会话、草稿和模型设置；切换时停止当前生成。")
      .addDropdown((dropdown) => {
        for (const provider of PROVIDER_DEFINITIONS) {
          dropdown.addOption(provider.id, provider.label);
        }
        dropdown.setValue(selected).onChange(async (value) => {
          dropdown.setDisabled(true);
          try {
            await plugin.setSegmentAiProvider(value);
          } catch (error) {
            new Notice(`切换 CLI 失败：${error.message}`);
          } finally {
            this.display();
          }
        });
      })
      .addButton((button) => button.setButtonText("重新检测").onClick(async () => {
        button.setDisabled(true).setButtonText("检测中...");
        await Promise.allSettled(PROVIDER_DEFINITIONS.map(({ id }) => plugin.discoverSegmentAiCli(id)));
        this.display();
      }));

    const sourceLabels = { custom: "自定义路径", path: "PATH", "login-shell": "登录 Shell", common: "常见安装目录", application: "应用内置" };
    for (const provider of PROVIDER_DEFINITIONS) {
      const card = containerEl.createEl("details", { cls: "lacan-ai-cli-card" });
      if (provider.id === selected) card.setAttribute("open", "");
      const summary = card.createEl("summary");
      summary.createSpan({ text: provider.label + (provider.id === selected ? " · 当前使用" : "") });
      const status = summary.createSpan({ cls: "lacan-ai-cli-status" });
      const resolvedPath = card.createEl("code", { cls: "lacan-ai-cli-resolved-path" });
      const update = (state) => {
        status.textContent = state?.status === "ready"
          ? `${state.version || state.versionError || "已找到"} · ${sourceLabels[state.source] || "自动发现"}`
          : state?.status === "failed" ? "未找到或无法启动" : "正在检测...";
        status.setAttribute("data-status", state?.status || "checking");
        resolvedPath.textContent = state?.status === "ready" ? state.path : state?.message || "";
      };
      let pathChangeTimer;
      new Setting(card)
        .setClass("lacan-ai-setting-wide")
        .setName(`${provider.label} 路径`)
        .setDesc("此电脑的可选 CLI 路径。留空自动检测 PATH、登录 Shell 和常见安装目录；支持 Windows 与 macOS。")
        .addText((text) => text
          .setPlaceholder(process.platform === "win32"
            ? `C:\\Users\\用户名\\AppData\\Roaming\\npm\\${provider.id === "deepseek" ? "dsh" : provider.id}.cmd`
            : provider.placeholder)
          .setValue(plugin.getSegmentAiCliPath(provider.id))
          .onChange((value) => {
            clearTimeout(pathChangeTimer);
            pathChangeTimer = setTimeout(async () => {
              try {
                await plugin.setSegmentAiCliPath(provider.id, value);
                const state = await plugin.discoverSegmentAiCli(provider.id);
                if (plugin.segmentAiCliDetections?.[provider.id] === state) update(state);
              } catch (error) {
                new Notice(`保存 CLI 路径失败：${error.message}`);
              }
            }, 500);
          }));
      const detection = plugin.segmentAiCliDetections?.[provider.id];
      update(detection);
      if (!detection || detection.configuredPath !== plugin.getSegmentAiCliPath(provider.id)) {
        void plugin.discoverSegmentAiCli(provider.id).then((state) => {
          if (plugin.segmentAiCliDetections?.[provider.id] === state) update(state);
        });
      }
    }
  }

  renderSegmentAiSettings(parentEl) {
    const containerEl = parentEl.createDiv("lacan-ai-settings");
    containerEl.createEl("h3", { text: "AI 功能（本地 Agent）" });
    const descriptionEl = containerEl.createDiv("lacan-ai-settings-description setting-item-description");
    descriptionEl.createEl("p", {
      text: "点击译文分段旁的“Ф”运行 AI 解读；点击原文分段旁的同一按钮，直接显示该 ID 的项目译文、完整注释与建言，并快速生成原文试译。",
    });
    descriptionEl.createEl("p", {
      text: "译文解读使用下方提示词；原文解析使用专用翻译流程，先查看试译与项目版本，需要词义、双关或语境分析时可继续追问。两种功能分别保存会话。",
    });
    descriptionEl.createEl("p", {
      text: "本地 Agent 指编排、文件检索和权限控制在本机运行，不等于使用本地模型。发送给模型的上下文和 Agent 读取的材料仍可能离开本机。",
    });
    descriptionEl.createEl("p", {
      text: "所有 AI 功能保持只读，不创建或修改笔记。译文解读每次回答必须使用内置 Web Search，外部来源只接受法语、德语或英语网页；所选 CLI 未提供网页工具时，回答须明确说明。原文解析只做翻译与直接对话。各 CLI 的工具支持范围见下方说明。",
    });

    new Setting(containerEl)
      .setName("启用分段 AI 功能")
      .setDesc("默认关闭。关闭后不会为分段解读启动 CLI；法语取词的语境翻译使用所选 CLI 单独运行。")
      .addToggle((toggle) => {
        toggle
          .setValue(Boolean(this.plugin.settings.segmentAiEnabled))
          .onChange(async (value) => {
            this.plugin.settings.segmentAiEnabled = value;
            await this.plugin.saveSettings();
            await this.plugin.resetSegmentAiRuntime();
            this.display();
          });
      });

    new Setting(containerEl)
      .setName("会话上限")
      .setDesc(
        "允许同时打开和生成的会话数，范围 1–5。打开新会话达到上限时，自动关闭最左侧的空闲会话并保留历史；正在生成的会话会跳过。调低上限时不会立即关闭现有会话或停止任务。"
      )
      .addDropdown((dropdown) => {
        for (let value = 1; value <= 5; value += 1) {
          dropdown.addOption(String(value), `${value} 个`);
        }
        dropdown
          .setValue(String(this.plugin.settings.segmentAiMaxOpenSessions))
          .onChange(async (value) => {
            const normalized = normalizeMaxOpenSessions(value);
            this.plugin.settings.segmentAiMaxOpenSessions = normalized;
            this.plugin.segmentAiWorkspaceStore?.setMaxOpenSessions(normalized);
            await this.plugin.saveSettings();
            await this.plugin.segmentAiController?.publish?.({ persist: true });
            this.display();
          });
      });

    this.renderSegmentAiProviderSettings(containerEl);
    const provider = normalizeProvider(this.plugin.settings.segmentAiProvider);
    if (provider === "codex") {
      const modelCatalog = this.plugin.getSegmentAiModelCatalog();
      const selectedModel = String(this.plugin.settings.segmentAiModel || "").trim();
      const modelCatalogUpdatedAt = Number(
        this.plugin.settings.segmentAiModelCatalogUpdatedAt || 0
      );
      const modelCatalogCliPath = this.plugin.segmentAiRuntime?.getDiagnostics?.().cliPath
        || this.plugin.segmentAiCliDetections?.codex?.path
        || this.plugin.getSegmentAiCliPath("codex")
        || "自动检测";
      const modelCatalogStatus = modelCatalog.length > 0
        ? `已从本机 Codex 获取 ${modelCatalog.length} 个模型${
            modelCatalogUpdatedAt
              ? `，最近刷新：${new Date(modelCatalogUpdatedAt).toLocaleString()}`
              : ""
          }。`
        : "尚未获取模型列表。";
      new Setting(containerEl)
        .setClass("lacan-ai-setting-wide")
        .setName("Agent 模型")
        .setDesc(
          `列表由本机 Codex App Server 的 model/list 提供，同时读取各模型支持的推理强度。CLI：${modelCatalogCliPath}。${modelCatalogStatus}`
        )
        .addDropdown((dropdown) => {
          dropdown.addOption("", "使用 Codex 默认模型");
          for (const model of modelCatalog) {
            const label = model.displayName === model.model
              ? model.displayName
              : `${model.displayName} · ${model.model}`;
            dropdown.addOption(
              model.model,
              model.isDefault ? `${label}（Codex 默认）` : label
            );
          }
          if (
            selectedModel
            && !modelCatalog.some((model) => model.model === selectedModel)
          ) {
            dropdown.addOption(selectedModel, `${selectedModel}（已保存，当前未发现）`);
          }
          dropdown
            .setValue(selectedModel)
            .onChange(async (value) => {
              this.plugin.settings.segmentAiModel = String(value || "").trim();
              this.plugin.settings.segmentAiReasoningEffort =
                coerceCodexReasoningEffort(
                  modelCatalog,
                  this.plugin.settings.segmentAiModel,
                  this.plugin.settings.segmentAiReasoningEffort
                );
              await this.plugin.saveSettings();
              await this.plugin.resetSegmentAiRuntime();
              this.display();
            });
        })
        .addButton((button) => {
          button
            .setButtonText("刷新模型")
            .onClick(async () => {
              button.setDisabled(true);
              button.setButtonText("获取中...");
              try {
                await this.plugin.resetSegmentAiRuntime();
                const models = await this.plugin.discoverSegmentAiModels();
                new Notice(`已从 Codex 获取 ${models.length} 个可用模型及其推理强度。`);
              } catch (error) {
                new Notice(
                  `模型列表获取失败：${error?.message || "请检查 Codex CLI 路径和登录状态。"}`
                );
              } finally {
                button.setDisabled(false);
                button.setButtonText("刷新模型");
                this.display();
              }
            });
        });

      const reasoningProfile = resolveCodexReasoningProfile(
        modelCatalog,
        selectedModel
      );
      const selectedReasoningEffort = coerceCodexReasoningEffort(
        modelCatalog,
        selectedModel,
        this.plugin.settings.segmentAiReasoningEffort
      );
      const defaultReasoningLabel = reasoningProfile?.defaultReasoningEffort
        ? REASONING_EFFORT_LABELS[reasoningProfile.defaultReasoningEffort]
          || reasoningProfile.defaultReasoningEffort
        : "";
      const reasoningDescription = reasoningProfile
        ? `${reasoningProfile.model} 支持的强度来自 model/list；留空时使用模型默认值${
            defaultReasoningLabel ? ` ${defaultReasoningLabel}` : ""
          }。所选强度会作为 turn/start 的 effort 发送。`
        : modelCatalog.length > 0
          ? selectedModel
            ? `当前 CLI 未返回已选模型 ${selectedModel}，无法确认其推理强度。请检查 CLI 路径与版本后刷新模型，或选择列表中的模型。`
            : "当前模型列表未标明默认模型。请选择列表中的模型，以查看它支持的推理强度。"
          : "尚未取得当前模型的推理强度目录；刷新模型时会一起读取。留空时由 Codex 选择默认值。";
      new Setting(containerEl)
        .setClass("lacan-ai-setting-wide")
        .setName("推理强度")
        .setDesc(reasoningDescription)
        .addDropdown((dropdown) => {
          dropdown.addOption(
            "",
            defaultReasoningLabel
              ? `跟随模型默认值（${defaultReasoningLabel}）`
              : "跟随模型默认值"
          );
          for (const effort of reasoningProfile?.supportedReasoningEfforts || []) {
            dropdown.addOption(
              effort.value,
              REASONING_EFFORT_LABELS[effort.value] || effort.value
            );
          }
          if (
            selectedReasoningEffort
            && !reasoningProfile?.supportedReasoningEfforts.some(
              (effort) => effort.value === selectedReasoningEffort
            )
          ) {
            dropdown.addOption(
              selectedReasoningEffort,
              `${REASONING_EFFORT_LABELS[selectedReasoningEffort]
                || selectedReasoningEffort}（已保存，待刷新验证）`
            );
          }
          dropdown
            .setValue(selectedReasoningEffort)
            .onChange(async (value) => {
              this.plugin.settings.segmentAiReasoningEffort = String(
                value || ""
              ).trim();
              await this.plugin.saveSettings();
              await this.plugin.resetSegmentAiRuntime();
              this.display();
            });
        });

    } else if (provider === "claude") {
      new Setting(containerEl)
        .setClass("lacan-ai-setting-wide")
        .setName("Agent 模型")
        .setDesc("留空使用 Claude Code 当前默认模型，也可填写 sonnet、opus 或完整模型名称。沿用 CLI 已有登录。")
        .addText((text) => text
          .setPlaceholder("使用 Claude Code 默认模型")
          .setValue(this.plugin.settings.segmentAiModel || "")
          .onChange(async (value) => {
            this.plugin.settings.segmentAiModel = value.trim();
            await this.plugin.saveSettings();
            await this.plugin.resetSegmentAiRuntime();
          }));
      new Setting(containerEl)
        .setName("推理强度")
        .setDesc("使用 Claude Code 的 --effort 参数；可用强度取决于所选模型。")
        .addDropdown((dropdown) => {
          dropdown.addOption("", "跟随模型默认值");
          for (const effort of ["low", "medium", "high", "max"]) {
            dropdown.addOption(effort, REASONING_EFFORT_LABELS[effort]);
          }
          dropdown.setValue(this.plugin.settings.segmentAiReasoningEffort || "")
            .onChange(async (value) => {
              this.plugin.settings.segmentAiReasoningEffort = value;
              await this.plugin.saveSettings();
              await this.plugin.resetSegmentAiRuntime();
            });
        });
      containerEl.createEl("p", {
        cls: "setting-item-description",
        text: "Claude Code 使用内置只读与网页工具，禁用文件写入、Shell、Hooks 和 Slash Commands。",
      });
    } else {
      containerEl.createEl("p", {
        cls: "setting-item-description",
        text: "DeepSeek Harness 使用 headless profile 中配置的模型、凭据和推理参数。请先在终端完成 dsh 配置；插件只向模型开放允许的只读／网页工具，profile 自带插件仍可能在启动时运行。当前适配不提供模型清单。",
      });
    }

    containerEl.createEl("h4", { text: "解读提示词" });
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text: "默认功能：术语与符号对照 + 语境性解读。术语表只读，缺项或不一致只提示，由用户判断是否修改。",
    });
    const globalPromptSetting = new Setting(containerEl);
    globalPromptSetting.settingEl.addClass("lacan-ai-global-prompt-setting");
    globalPromptSetting
      .setName("解读提示词")
      .setDesc("这是插件唯一的可编辑解读提示词，适用于所有译文分段。只读、安全、本地 Vault 文件范围和外部来源语言限制仍由插件内部固定。")
      .addTextArea((text) => {
        text
          .setValue(
            this.plugin.settings.segmentAiPrompt
              || DEFAULT_INTERPRETATION_PROMPT
          )
          .setPlaceholder(DEFAULT_INTERPRETATION_PROMPT)
          .onChange(async (value) => {
            this.plugin.settings.segmentAiPrompt = String(value || "");
            this.plugin.segmentAiController?.promptBuilder
              ?.setInterpretationPrompt?.(value);
            await this.plugin.saveSettings();
          });
        text.inputEl.rows = 12;
        text.inputEl.addClass("lacan-ai-global-prompt");
      })
      .addButton((button) => {
        button
          .setButtonText("恢复默认")
          .onClick(async () => {
            this.plugin.settings.segmentAiPrompt =
              DEFAULT_INTERPRETATION_PROMPT;
            this.plugin.segmentAiController?.promptBuilder
              ?.setInterpretationPrompt?.(DEFAULT_INTERPRETATION_PROMPT);
            await this.plugin.saveSettings();
            this.display();
          });
      });
    const diagnostics = this.plugin.getSegmentAiDiagnostics();
    new Setting(containerEl)
      .setName("本地 Agent 诊断")
      .setDesc(
        diagnostics.runtime?.userAgent
          ? `${diagnostics.runtime.userAgent} · ${diagnostics.status}`
          : `尚未启动 · ${diagnostics.status}`
      )
      .addButton((button) => {
        button
          .setButtonText("应用配置并重启")
          .onClick(async () => {
            await this.plugin.resetSegmentAiRuntime();
            new Notice("已重置分段 AI 功能运行时。");
            this.display();
          });
      })
      .addButton((button) => {
        button
          .setButtonText("复制诊断")
          .onClick(async () => {
            const text = JSON.stringify(this.plugin.getSegmentAiDiagnostics(), null, 2);
            if (globalThis.navigator?.clipboard?.writeText) {
              await globalThis.navigator.clipboard.writeText(text);
              new Notice("已复制 AI 功能诊断。");
            }
          });
      });
  }
}

class LacanLessonListBasesView extends ObsidianBasesView {
  constructor(controller, parentEl, plugin) {
    super(controller);
    this.plugin = plugin;
    this.containerEl = parentEl.createDiv("lacan-bases-list");
    this.catalogContainer = parentEl.closest?.(".view-content");
    this.catalogContainer?.addClass("lacan-catalog-base");
    this.openSeminars = new Set();
    this.progressElements = new Map();
    plugin.projectCatalogViews ||= new Set();
    plugin.projectCatalogViews.add(this);
    this.onDataUpdated();
  }

  onunload() {
    this.plugin.projectCatalogViews?.delete(this);
    this.catalogContainer?.removeClass("lacan-catalog-base");
  }

  onDataUpdated() {
    this.containerEl.empty();
    this.progressElements.clear();
    const catalog = this.plugin.projectCatalog;
    if (!catalog) {
      this.containerEl.createEl("p", {
        cls: "lacan-bases-catalog-status",
        text: this.plugin.projectCatalogError || "正在获取完整文本清单，课文将在点击同步后下载。",
      });
      this.createActionLink(this.containerEl, "更新文本清单", () => this.plugin.refreshProjectCatalog({ notify: true }));
      return;
    }
    this.containerEl.createEl("p", {
      cls: "lacan-bases-catalog-status",
      text: `${catalog.lessonCount} 个课次 · ${catalog.seminars.length} 个研讨班 · 课文按需同步`,
    });
    const search = this.containerEl.createEl("input", {
      cls: "lacan-bases-catalog-search", type: "search", placeholder: "搜索研讨班或课次",
      attr: { "aria-label": "搜索完整文本清单" },
    });
    search.value = this.searchText || "";
    this.groupsEl = this.containerEl.createDiv("lacan-bases-catalog-groups");
    search.addEventListener("input", () => {
      this.searchText = search.value;
      this.renderCatalogGroups(catalog);
    });
    this.renderCatalogGroups(catalog);
  }

  renderCatalogGroups(catalog) {
    this.groupsEl.empty();
    this.progressElements.clear();
    const query = String(this.searchText || "").trim().toLocaleLowerCase();
    for (const seminar of catalog.seminars) {
      const lessons = query ? seminar.lessons.filter((lesson) => `${seminar.title} ${lesson.title} ${lesson.originalPath}`.toLocaleLowerCase().includes(query)) : seminar.lessons;
      if (!lessons.length) continue;
      const details = this.groupsEl.createEl("details", { cls: "lacan-bases-group" });
      const summary = details.createEl("summary", { cls: "lacan-bases-group-summary" });
      summary.createSpan({
        cls: "lacan-bases-group-title",
        text: `${String(seminar.order).padStart(2, "0")} · ${seminar.title}`,
      });
      this.createActionLink(summary, "初始化研讨班", () => this.plugin.initializeProjectSeminar(seminar.slug), true);
      summary.createSpan({ cls: "lacan-bases-group-count", text: `${lessons.length}` });
      const listEl = details.createEl("ul", { cls: "lacan-bases-group-list" });
      const renderEntries = () => {
        if (details.dataset.entriesRendered === "true") return;
        for (const lesson of lessons) this.renderLesson(listEl, lesson);
        details.dataset.entriesRendered = "true";
      };
      details.addEventListener("toggle", () => {
        if (details.open) { this.openSeminars.add(seminar.slug); renderEntries(); }
        else this.openSeminars.delete(seminar.slug);
      });
      if (query || this.openSeminars.has(seminar.slug)) {
        details.open = true;
        renderEntries();
      }
    }
  }

  renderLesson(listEl, lesson) {
    const item = listEl.createEl("li", { cls: "lacan-bases-entry" });
    const main = item.createDiv("lacan-bases-entry-main");
    main.createSpan({ cls: "lacan-bases-entry-title", text: lesson.title });
    this.createActionLink(main, "原文", () => this.openDownloadedFile(lesson.originalPath));
    this.createActionLink(main, "译文", () => this.openDownloadedFile(lesson.translationPath));
    this.createActionLink(main, this.plugin.activeLessonSync === lesson.originalPath ? "同步中…" : "同步",
      () => this.plugin.syncProjectLesson(lesson.originalPath), true);
    const progress = main.createSpan({ cls: "lacan-bases-progress" });
    progress.setAttribute("role", "progressbar");
    progress.setAttribute("aria-label", `${lesson.title} 原文和译文同步进度`);
    progress.setAttribute("aria-valuemin", "0");
    progress.setAttribute("aria-valuemax", "100");
    this.progressElements.set(lesson.originalPath, progress);
    this.updateSyncProgress(lesson.originalPath);
    const syncStatus = this.plugin.settings.projectLessonSync?.[lesson.originalPath];
    if (syncStatus?.status === "skipped" && this.plugin.activeLessonSync !== lesson.originalPath) main.createSpan({
      cls: "lacan-bases-sync-status is-skipped", text: "已跳过",
      attr: { title: formatSkipNotice(syncStatus.skippedFiles || []) },
    });
    const meta = item.createDiv("lacan-bases-entry-meta");
    meta.createSpan({ text: `原文：${lesson.originalPath}` });
    meta.createSpan({ text: `译文：${lesson.translationPath}` });
  }

  updateSyncProgress(originalPath) {
    const element = this.progressElements.get(originalPath);
    if (!element) return;
    const percent = this.plugin.getLessonSyncPercent(originalPath);
    element.textContent = `${percent}%`;
    element.setAttribute("aria-valuenow", `${percent}`);
  }

  createActionLink(parentEl, text, action, syncAction = false) {
    const link = parentEl.createEl("a", { cls: "lacan-bases-link", href: "#", text });
    const disabled = syncAction && Boolean(this.plugin.syncInProgress);
    link.setAttribute("aria-disabled", String(disabled));
    if (disabled) link.addClass("is-disabled");
    link.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (disabled) return;
      await this.plugin.runWithNotice(action, "文库操作失败");
    });
    return link;
  }

  async openDownloadedFile(path) {
    const file = this.plugin.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) throw new Error("本课尚未下载，请先点击同步，同时获取原文和译文。");
    await this.plugin.openFile(file);
  }
}
