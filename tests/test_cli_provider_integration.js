const assert = require("assert");
const Module = require("module");
const os = require("os");
const { normalizeProviderSettings } = require("../segment-ai/provider-settings");
const { migrateMachineCliPaths } = require("../segment-ai/machine-cli-settings");

const originalLoad = Module._load;
const originalDocument = global.document;
const clone = (value) => JSON.parse(JSON.stringify(value));
const lifecycle = [];

class MockRuntime {
  constructor(options) {
    this.options = options;
    this.shutdownCalls = 0;
  }
  async shutdown() {
    lifecycle.push(`shutdown:${this.options.provider}`);
    this.shutdownCalls += 1;
    await this.onShutdown?.();
  }
  getDiagnostics() { return { provider: this.options.provider }; }
}
class MockCodexRuntime extends MockRuntime {}
class MockCliRuntime extends MockRuntime {}
class MockWorkspaceStore {
  constructor({ conversations, workspace }) {
    this.data = clone({ conversations, workspace });
  }
  serialize() {
    lifecycle.push("snapshot");
    return clone(this.data);
  }
  snapshot() { return clone(this.data); }
}
class MockWorkspaceController {
  constructor(options) { Object.assign(this, options); }
}
class MockFrenchTranslator {
  constructor(options) { Object.assign(this, options); this.destroyCalls = 0; }
  destroy() { this.destroyCalls += 1; }
}

Module._load = function load(request, parent, isMain) {
  if (request === "obsidian") {
    return {
      Plugin: class {},
      PluginSettingTab: class {},
      ItemView: class {},
      FileView: class {},
      BasesView: class {},
      Component: class {},
      Modal: class {},
      Notice: class {},
      Setting: class {},
      TFile: class {},
      Menu: class {},
      MarkdownRenderer: { async render() {} },
      normalizePath: (value) => String(value || "").replace(/\\/g, "/"),
    };
  }
  if (request === "@codemirror/view") return { WidgetType: class {} };
  if (request === "../segment-ai/codex-app-server-runtime") {
    return {
      ...originalLoad(request, parent, isMain),
      CodexAppServerRuntime: MockCodexRuntime,
    };
  }
  if (request === "../segment-ai/cli-agent-runtime") return { CliAgentRuntime: MockCliRuntime };
  if (request === "../segment-ai/workspace-store") {
    return {
      ...originalLoad(request, parent, isMain),
      InterpretationWorkspaceStore: MockWorkspaceStore,
    };
  }
  if (request === "../segment-ai/workspace-controller") {
    return { InterpretationWorkspaceController: MockWorkspaceController };
  }
  if (request === "./french-selection-translator") return { FrenchSelectionTranslator: MockFrenchTranslator };
  if (request === "./french-lookup-popup") {
    return { FrenchLookupPopup: class { start() {} destroy() {} } };
  }
  if (request === "./pdf-reading") return { registerPdfReading() {}, addPdfFileMenuItems() {} };
  return originalLoad(request, parent, isMain);
};

const run = async () => {
  const PluginClass = require("../src/main");
  const makePlugin = () => {
    const plugin = Object.create(PluginClass.prototype);
    plugin.settings = {
      segmentAiProvider: "codex",
      segmentAiEnabled: false,
      segmentAiModel: "codex-model",
      segmentAiReasoningEffort: "high",
      segmentAiCodexPath: "/custom/codex",
      segmentAiClaudePath: "/custom/claude",
      segmentAiDeepseekPath: "/custom/dsh",
      segmentAiCliPathsByMachine: {
        [`${process.platform}:${os.hostname()}`]: {
          codex: "/custom/codex", claude: "/custom/claude", deepseek: "/custom/dsh",
        },
      },
      segmentAiMcpEnabled: true,
      segmentAiMcpEnabledServers: ["allowed"],
      segmentAiMaxOpenSessions: 3,
      segmentAiConversations: [{ id: "codex-chat", threadId: "codex-thread", draft: "旧草稿" }],
      segmentAiWorkspace: { openConversationIds: ["codex-chat"], activeConversationId: "codex-chat" },
    };
    normalizeProviderSettings(plugin.settings);
    migrateMachineCliPaths(plugin.settings);
    plugin.getVaultBasePath = () => "/vault";
    plugin.manifest = { version: "test" };
    plugin.app = { vault: {}, workspace: { getLeavesOfType: () => [] } };
    plugin.saveCalls = 0;
    plugin.saveSettings = async () => { plugin.saveCalls += 1; };
    plugin.refreshSegmentAiEntrances = () => {};
    return plugin;
  };

  const factory = makePlugin();
  assert.strictEqual(Object.hasOwn(factory.settings, "segmentAiMcpEnabled"), false);
  // A stale external settings mutation must not enable native MCP services.
  factory.settings.segmentAiMcpEnabled = true;
  factory.settings.segmentAiMcpEnabledServers = ["stale-service"];
  const codex = factory.createSegmentAiRuntime();
  assert.ok(codex instanceof MockCodexRuntime);
  assert.strictEqual(codex.options.provider, "codex");
  assert.strictEqual(codex.options.cliPath, "/custom/codex");
  assert.strictEqual(codex.options.defaultModel, "codex-model");
  assert.notStrictEqual(codex.options.mcpEnabled, true);
  assert.ok(!codex.options.enabledMcpServerNames?.length);
  for (const provider of ["claude", "deepseek"]) {
    factory.settings.segmentAiProvider = provider;
    const runtime = factory.createSegmentAiRuntime();
    assert.ok(runtime instanceof MockCliRuntime);
    assert.strictEqual(runtime.options.provider, provider);
    assert.strictEqual(runtime.options.cliPath, provider === "claude" ? "/custom/claude" : "/custom/dsh");
    assert.notStrictEqual(runtime.options.mcpEnabled, true);
    assert.ok(!runtime.options.enabledMcpServerNames?.length);
  }
  const deepseek = factory.createSegmentAiRuntime({ defaultModel: "unsupported", defaultReasoningEffort: "low" });
  assert.strictEqual(deepseek.options.defaultModel, "");
  assert.strictEqual(deepseek.options.defaultReasoningEffort, "");

  factory.initializeFrenchLookup();
  assert.strictEqual(factory.frenchLookupTranslator.getReasoningEffort(), "");
  const frenchDeepseek = factory.frenchLookupTranslator.createRuntime();
  assert.strictEqual(frenchDeepseek.options.provider, "deepseek");
  assert.strictEqual(frenchDeepseek.options.defaultReasoningEffort, "");
  assert.strictEqual(frenchDeepseek.options.ephemeralThreads, true);
  assert.notStrictEqual(frenchDeepseek.options.mcpEnabled, true);
  assert.strictEqual(frenchDeepseek.options.turnTimeoutMs, 60000);
  factory.settings.segmentAiProvider = "claude";
  assert.strictEqual(factory.frenchLookupTranslator.getReasoningEffort(), "low");
  assert.strictEqual(factory.frenchLookupTranslator.createRuntime().options.provider, "claude");

  const switching = makePlugin();
  switching.initializeSegmentAi();
  const oldRuntime = switching.segmentAiRuntime;
  const oldController = switching.segmentAiController;
  const oldTranslator = new MockFrenchTranslator({});
  switching.frenchLookupTranslator = oldTranslator;
  oldRuntime.onShutdown = async () => {
    switching.segmentAiWorkspaceStore.data.conversations[0].draft = "停止时最后保存的草稿";
  };
  lifecycle.length = 0;
  await switching.setSegmentAiProvider("claude");
  assert.strictEqual(oldRuntime.shutdownCalls, 1);
  assert.deepStrictEqual(lifecycle.slice(0, 2), ["shutdown:codex", "snapshot"]);
  assert.strictEqual(oldTranslator.destroyCalls, 1);
  assert.strictEqual(switching.settings.segmentAiProvider, "claude");
  assert.ok(switching.segmentAiRuntime instanceof MockCliRuntime);
  assert.deepStrictEqual(switching.settings.segmentAiConversations, []);
  const currentState = switching.segmentAiState;
  const currentSaves = switching.saveCalls;
  await oldController.persistWorkspace({
    conversations: [{ id: "late-codex", threadId: "late-native-id" }],
    workspace: { openConversationIds: ["late-codex"], activeConversationId: "late-codex" },
  });
  oldController.onState({ conversations: [{ id: "late-codex" }] });
  assert.deepStrictEqual(switching.settings.segmentAiConversations, []);
  assert.strictEqual(switching.segmentAiState, currentState, "old events must not replace the selected provider's view state");
  assert.strictEqual(switching.saveCalls, currentSaves, "old persistence must not save over a new provider");
  await switching.setSegmentAiProvider("codex");
  assert.strictEqual(switching.settings.segmentAiConversations[0].threadId, "codex-thread");
  assert.strictEqual(switching.settings.segmentAiConversations[0].draft, "停止时最后保存的草稿");

  const rapidSwitch = makePlugin();
  rapidSwitch.initializeSegmentAi();
  const rapidOldRuntime = rapidSwitch.segmentAiRuntime;
  let markShutdownStarted;
  const shutdownStarted = new Promise((resolve) => { markShutdownStarted = resolve; });
  const shutdownReleases = [];
  rapidOldRuntime.onShutdown = () => new Promise((resolve) => {
    shutdownReleases.push(resolve);
    markShutdownStarted();
  });
  const firstSwitch = rapidSwitch.setSegmentAiProvider("claude");
  await shutdownStarted;
  const secondSwitch = rapidSwitch.setSegmentAiProvider("deepseek");
  await Promise.resolve();
  await Promise.resolve();
  const shutdownsWhileFirstPending = rapidOldRuntime.shutdownCalls;
  for (const release of shutdownReleases) release();
  await Promise.all([firstSwitch, secondSwitch]);
  assert.strictEqual(shutdownsWhileFirstPending, 1, "rapid provider changes must serialize before stopping or snapshotting the same runtime");
  assert.strictEqual(rapidSwitch.settings.segmentAiProvider, "deepseek");
  assert.deepStrictEqual(rapidSwitch.settings.segmentAiProviderProfiles.claude.segmentAiConversations, []);

  const pathPlugin = makePlugin();
  pathPlugin.resetCalls = 0;
  pathPlugin.resetSegmentAiRuntime = async () => { pathPlugin.resetCalls += 1; };
  pathPlugin.settings.segmentAiModelCatalog = [{ model: "cached-model" }];
  pathPlugin.settings.segmentAiSkillCatalog = [{ name: "cached-skill" }];
  pathPlugin.settings.segmentAiProviderProfiles.claude.segmentAiModelCatalog = [{ model: "old-cli-model" }];
  pathPlugin.settings.segmentAiProviderProfiles.claude.segmentAiSkillCatalog = [{ name: "old-cli-skill" }];
  await pathPlugin.setSegmentAiCliPath("claude", "/other/claude");
  assert.deepStrictEqual(pathPlugin.settings.segmentAiProviderProfiles.claude.segmentAiModelCatalog, []);
  assert.deepStrictEqual(pathPlugin.settings.segmentAiProviderProfiles.claude.segmentAiSkillCatalog, []);
  assert.strictEqual(pathPlugin.getSegmentAiCliPath("claude"), "/other/claude");
  assert.strictEqual(pathPlugin.resetCalls, 0);
  assert.strictEqual(pathPlugin.settings.segmentAiModelCatalog.length, 1);
  assert.strictEqual(pathPlugin.settings.segmentAiSkillCatalog.length, 1);
  await pathPlugin.setSegmentAiCliPath("codex", "/other/codex");
  assert.strictEqual(pathPlugin.resetCalls, 1);
  assert.deepStrictEqual(pathPlugin.settings.segmentAiModelCatalog, []);
  assert.deepStrictEqual(pathPlugin.settings.segmentAiSkillCatalog, []);
  const savedAfterPathChange = pathPlugin.saveCalls;
  await pathPlugin.setSegmentAiCliPath("codex", " /other/codex ");
  assert.strictEqual(pathPlugin.resetCalls, 1);
  assert.strictEqual(pathPlugin.saveCalls, savedAfterPathChange);

  // Exercise startup migration through the plugin, with UI registration stubbed.
  const startup = Object.create(PluginClass.prototype);
  startup.loadData = async () => ({
    segmentAiCodexPath: "/legacy/codex",
    segmentAiMcpEnabled: true,
    segmentAiMcpEnabledServers: ["legacy-service"],
    segmentAiProviderProfiles: { claude: { segmentAiMcpEnabled: true }, retired: { segmentAiMcpEnabled: true } },
  });
  let savedStartupSettings;
  startup.saveData = async (settings) => { savedStartupSettings = clone(settings); };
  startup.app = {
    vault: { on: () => ({}) },
    workspace: { on: () => ({}), onLayoutReady() {} },
  };
  for (const name of [
    "initializeSegmentAi", "initializeFrenchLookup",
    "initializeTranslationInlineEditing", "addSettingTab", "addCommand", "registerEvent",
    "registerDomEvent", "registerReadingNoteEditorExtension", "registerMarkdownPostProcessor",
    "registerProjectBasesView", "scheduleReadingToolbarRender", "refreshSegmentAiEntrances",
  ]) startup[name] = () => {};
  startup.scheduleSegmentAiMcpBackgroundCheck = () => assert.fail("startup must not run MCP preflight");
  global.document = {};
  await startup.onload();
  const machineKey = `${process.platform}:${os.hostname()}`;
  assert.strictEqual(startup.settings.segmentAiProvider, "codex");
  for (const settings of [startup.settings, savedStartupSettings,
    ...Object.values(startup.settings.segmentAiProviderProfiles)]) {
    assert.ok(!Object.keys(settings).some((key) => key.startsWith("segmentAiMcp")));
  }
  for (const method of ["getSegmentAiMcpServerCatalog", "scheduleSegmentAiMcpBackgroundCheck",
    "runSegmentAiMcpBackgroundCheck", "refreshSegmentAiMcpServers"]) {
    assert.strictEqual(typeof PluginClass.prototype[method], "undefined", `${method} should be retired`);
  }
  if (process.platform !== "win32") {
    assert.strictEqual(startup.settings.segmentAiCliPathsByMachine[machineKey].codex, "/legacy/codex");
    assert.strictEqual(startup.getSegmentAiCliPath("codex"), "/legacy/codex");
  }
  startup.loadData = async () => ({
    segmentAiCodexPath: "/other-machine/codex",
    segmentAiCliPathsByMachine: { "darwin:other-machine": { codex: "/other-machine/codex" } },
  });
  await startup.onload();
  assert.strictEqual(startup.getSegmentAiCliPath("codex"), "", "startup must not import another host's synced legacy path");
};

const testTimeout = setTimeout(() => {
  console.error("CLI provider integration did not finish within 10 seconds.");
  process.exitCode = 1;
}, 10000);
run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => {
  clearTimeout(testTimeout);
  Module._load = originalLoad;
  if (originalDocument === undefined) delete global.document;
  else global.document = originalDocument;
});
