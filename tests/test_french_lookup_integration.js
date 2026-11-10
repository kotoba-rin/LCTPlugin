const assert = require("assert");
const Module = require("module");
const path = require("path");

const originalLoad = Module._load;
const settingRows = [];
const tokenModalCalls = [];
const authorizationUrl = "https://my.frdic.com/OpenAPI/Authorization";
const popups = [];
const translators = [];
const runtimeOptions = [];
const serviceOptions = [];

class Control {
  constructor() { this.inputEl = {}; this.buttonEl = { getBoundingClientRect: () => ({}) }; }
  setValue(value) { this.value = value; return this; }
  setPlaceholder() { return this; }
  setButtonText(text) { this.buttonText = text; return this; }
  setDisabled(value) { this.disabled = value; return this; }
  setCta() { return this; }
  addOption() { return this; }
  onChange(callback) { this.change = callback; return this; }
  onClick(callback) { this.click = callback; return this; }
}
class MockSetting {
  constructor() { this.controls = []; settingRows.push(this); }
  setName(name) { this.name = name; return this; }
  setDesc(description) { this.description = description; return this; }
  addControl(callback) { const control = new Control(); this.controls.push(control); callback(control); return this; }
  addText(callback) { return this.addControl(callback); }
  addToggle(callback) { return this.addControl(callback); }
  addDropdown(callback) { return this.addControl(callback); }
  addButton(callback) { return this.addControl(callback); }
  addComponent(callback) { callback({}); return this; }
}
class MockPopup {
  constructor(plugin, options) { this.plugin = plugin; this.options = options; this.started = 0; this.destroyed = 0; this.closed = 0; this.synced = 0; this.modes = []; popups.push(this); }
  start() { this.started += 1; }
  destroy() { this.destroyed += 1; }
  close() { this.closed += 1; }
  async syncWordbookState() { this.synced += 1; }
  lookupCurrentSelection(mode) { this.modes.push(mode); return true; }
}
class MockTranslator {
  constructor(options) { this.options = options; this.destroyed = 0; translators.push(this); }
  translate(lookup, options) { return { lookup, options }; }
  destroy() { this.destroyed += 1; }
}
class MockRuntime {
  constructor(options) { runtimeOptions.push(options); }
}
class MockMenu {}

Module._load = function load(request, parent, isMain) {
  if (request === "obsidian") {
    return {
      Plugin: class {},
      PluginSettingTab: class { constructor(app) { this.app = app; } },
      ItemView: class {}, FileView: class {}, BasesView: class {},
      Setting: MockSetting, Notice: class {}, Component: class {}, TFile: class {},
      Menu: MockMenu,
      normalizePath: (value) => String(value || "").replace(/\\/g, "/"),
      requestUrl: () => { throw new Error("Integration tests must not call the network"); },
    };
  }
  if (request === "@codemirror/view") { return { WidgetType: class {} }; }
  if (request === "./french-dictionary-service") {
    return { FrenchDictionaryService: class { constructor(options) { serviceOptions.push(options); } } };
  }
  if (request === "./french-lookup-popup") { return { FrenchLookupPopup: MockPopup }; }
  if (request === "./french-selection-translator") { return { FrenchSelectionTranslator: MockTranslator }; }
  if (request === "./eudic-token-modal") {
    return { openEudicTokenModal: (...args) => tokenModalCalls.push(args), EUDIC_AUTHORIZATION_URL: authorizationUrl };
  }
  if (request === "../segment-ai/codex-app-server-runtime") {
    return { ...originalLoad(request, parent, isMain), CodexAppServerRuntime: MockRuntime };
  }
  return originalLoad(request, parent, isMain);
};
let PluginClass;
try {
  PluginClass = require(path.resolve(__dirname, "../src/main.js"));
} finally {
  Module._load = originalLoad;
}

async function run() {
  const storedToken = "test-only-stored-token";
  const temporaryToken = "test-only-session-token";
  const settingsSaves = [];
  const commands = new Map();
  const events = new Map();
  let settingTab;
  const plugin = Object.create(PluginClass.prototype);
  plugin.app = {
    secretStorage: { getSecret: (name) => name === "dictionary-secret" ? storedToken : "", setSecret() {} },
    vault: { on: () => ({}) },
    workspace: {
      on(name, callback) { events.set(name, callback); return {}; },
      onLayoutReady() {},
    },
  };
  plugin.manifest = { version: "test-version" };
  plugin.loadData = async () => ({
    forks: [{ id: "legacy", name: "旧 Fork", localBranch: "old-fork", enabled: true }],
    mode: "editer", repositoryUrl: "https://example.com/legacy.git", repositoryBranch: "main",
    githubProxyEnabled: true, githubProxyUrl: " http://127.0.0.1:6789 ",
    frenchLookupEnabled: false,
    frenchLookupTrigger: "double-click",
    frenchLookupAutoTranslate: false,
    frenchLookupSecretName: "dictionary-secret",
    frenchLookupWordbooks: [{ id: "7", name: "法语测试生词本" }, { id: 42, name: "invalid" }],
    segmentAiCodexPath: "/mock/codex", segmentAiModel: "test-model", autoSyncOnStartup: false,
  });
  plugin.saveData = async (data) => { settingsSaves.push(JSON.parse(JSON.stringify(data))); };
  plugin.addSettingTab = (tab) => { settingTab = tab; };
  plugin.addCommand = (command) => commands.set(command.id, command);
  plugin.registerEvent = () => {};
  plugin.registerDomEvent = () => {};
  plugin.getVaultBasePath = () => "/mock/vault";
  for (const name of ["initializeSegmentAi", "registerReadingNoteEditorExtension", "registerMarkdownPostProcessor", "registerProjectBasesView", "scheduleReadingToolbarRender", "refreshSegmentAiEntrances", "removeSegmentAiPreviewControls", "hideSegmentPreview", "removeReadingToolbars"]) {
    plugin[name] = () => {};
  }
  const previousDocument = global.document;
  global.document = {};
  try { await plugin.onload(); } finally { global.document = previousDocument; }
  assert.strictEqual(Object.hasOwn(plugin.settings, "forks"), false, "startup must retire saved Fork settings");
  assert.strictEqual(plugin.settings.projectEndpointUrl, "https://kotoba-rin.com/wp-json/lctp/v1/project");
  assert.strictEqual(Object.hasOwn(plugin.settings, "mode"), false, "Reader and Editer are retired");
  assert.strictEqual(plugin.settings.pluginHttpProxyEnabled, true, "existing proxy preference must migrate to the plugin HTTP proxy");
  assert.strictEqual(plugin.settings.pluginHttpProxyUrl, "http://127.0.0.1:6789");
  for (const key of ["githubProxyEnabled", "githubProxyUrl", "repositoryUrl", "repositoryBranch"]) {
    assert.strictEqual(Object.hasOwn(plugin.settings, key), false, `retire ${key} after migration`);
  }
  assert.ok(settingsSaves.length > 0);
  assert.ok(settingsSaves.every((settings) => !Object.hasOwn(settings, "forks")), "startup must persist the settings migration without restoring retired Forks");
  assert.ok(commands.has("open-pdf-reading"), "plugin startup must register the PDF reading command");
  assert.strictEqual(plugin.settings.frenchLookupEnabled, false, "startup must preserve an explicitly disabled selection trigger");
  assert.strictEqual(plugin.settings.frenchLookupTrigger, "double-click");
  assert.strictEqual(plugin.settings.frenchLookupAutoTranslate, false);
  assert.deepStrictEqual(plugin.settings.frenchLookupWordbooks, [{ id: "7", name: "法语测试生词本" }]);
  assert.strictEqual(popups[0].started, 1);
  assert.strictEqual(runtimeOptions.length, 0, "plugin initialization must not start a model process or translation");
  assert.strictEqual(plugin.getEudicToken(), storedToken);
  assert.strictEqual(serviceOptions[0].getToken(), storedToken);
  assert.strictEqual(serviceOptions[0].requestUrl, plugin.getPluginRequest(), "dictionary requests must use the shared plugin transport");
  assert.ok(!JSON.stringify(settingsSaves).includes(storedToken), "saving settings must never serialize a resolved SecretStorage value");

  commands.get("lookup-french-selection").callback();
  assert.ok(popups[0].options.createMenu() instanceof MockMenu, "reading lookup must receive the Obsidian menu factory");
  commands.get("translate-french-selection").callback();
  assert.deepStrictEqual(popups[0].modes, ["dictionary", "translation"]);
  const menuItems = [];
  const menu = { addItem(callback) {
    const item = { setTitle() { return this; }, setIcon() { return this; }, onClick(callback) { this.click = callback; return this; } };
    menuItems.push(item); callback(item);
  } };
  events.get("editor-menu")(menu, { getSelection: () => "L’identification" });
  assert.strictEqual(menuItems.length, 0, "disabled selection lookup must not inject editor context-menu items");
  plugin.settings.frenchLookupEnabled = true;
  events.get("editor-menu")(menu, { getSelection: () => "" });
  assert.strictEqual(menuItems.length, 0);
  events.get("editor-menu")(menu, { getSelection: () => "L’identification" });
  assert.strictEqual(menuItems.length, 2);
  menuItems[0].click(); menuItems[1].click();
  assert.deepStrictEqual(popups[0].modes.slice(-2), ["dictionary", "translation"]);

  translators[0].options.createRuntime();
  assert.deepStrictEqual(runtimeOptions[0], {
    provider: "codex",
    vaultRoot: "/mock/vault", pluginVersion: "test-version", cliPath: "/mock/codex", defaultModel: "test-model",
    defaultReasoningEffort: "low", ephemeralThreads: true, requestTimeoutMs: 15000, turnTimeoutMs: 60000,
  });
  const lookup = { selection: "étaient", context: "Ils étaient ici." };
  const signal = new AbortController().signal;
  assert.deepStrictEqual(popups[0].options.translate(lookup, { signal }), { lookup, options: { signal } });

  const createdElements = [];
  const parentEl = {
    createEl(tag, options) { createdElements.push({ tag, ...options }); return this; },
    createDiv() { return this; }, empty() {}, setAttribute() {}, addEventListener() {},
  };
  settingTab.containerEl = parentEl;
  settingTab.display();
  assert.ok(settingRows.some((row) => row.name === "更新文本清单"), "project settings refresh only the published catalog");
  assert.ok(!settingRows.some((row) => /首次下载完整文库|立即同步/.test(`${row.name} ${row.description}`)), "project settings must not offer whole-library downloads");
  assert.ok(!settingRows.some((row) => /Reader|Editer|GitHub|上游分支/.test(`${row.name} ${row.description}`)), "project settings expose one HTTP sync behavior without Git configuration");
  assert.ok(!/fork/i.test(JSON.stringify({ createdElements, settingRows })), "project settings must not expose retired Fork configuration or descriptions");
  const proxyToggle = settingRows.find((row) => row.name === "启用插件 HTTP 代理").controls[0];
  const proxyAddress = settingRows.find((row) => row.name === "插件 HTTP 代理地址").controls[0];
  assert.strictEqual(proxyToggle.value, true);
  assert.strictEqual(proxyAddress.value, "http://127.0.0.1:6789");
  assert.strictEqual(proxyAddress.disabled, false);
  await proxyToggle.change(false);
  assert.strictEqual(plugin.settings.pluginHttpProxyEnabled, false);
  assert.strictEqual(proxyAddress.disabled, true);
  await proxyAddress.change(" http://127.0.0.1:7890 ");
  assert.strictEqual(plugin.settings.pluginHttpProxyUrl, "http://127.0.0.1:7890");
  await proxyToggle.change(true);
  assert.strictEqual(proxyAddress.disabled, false);
  assert.strictEqual(plugin.settings.pluginHttpProxyEnabled, true);
  assert.strictEqual(settingsSaves.at(-1).pluginHttpProxyUrl, "http://127.0.0.1:7890", "proxy controls must persist their changes");
  settingRows.length = 0;
  createdElements.length = 0;
  let settingsRefreshes = 0;
  settingTab.display = () => { settingsRefreshes += 1; };
  settingTab.renderFrenchLookupSettings(parentEl);
  const supportedTokenRow = settingRows.find((row) => /API 授权码/.test(row.name));
  assert.strictEqual(supportedTokenRow.controls[0].buttonText, "设置授权码", "supported SecretStorage must use the dedicated authorization modal button");
  assert.strictEqual(supportedTokenRow.controls[0].inputEl.type, undefined, "the settings row must not expose a raw authorization input");
  await supportedTokenRow.controls[0].click();
  assert.strictEqual(tokenModalCalls.length, 1);
  assert.strictEqual(tokenModalCalls[0].length, 2, "the modal receives only the plugin and saved callback, without a raw token argument");
  assert.strictEqual(tokenModalCalls[0][0], plugin);
  assert.strictEqual(typeof tokenModalCalls[0][1], "function");
  assert.strictEqual(plugin.settings.frenchLookupSecretName, "dictionary-secret", "opening authorization settings must preserve the selected secret name");
  tokenModalCalls[0][1]();
  assert.strictEqual(settingsRefreshes, 1, "saving through the dedicated modal must refresh the settings view");
  const authorizationLink = createdElements.find((element) => element.tag === "a" && element.attr?.href === authorizationUrl);
  assert.ok(authorizationLink, "the authorization link must point to the exact French service authorization page");
  assert.ok(authorizationLink.text.includes("获取法语助手 API 授权码"));
  assert.ok(JSON.stringify(createdElements).includes(authorizationUrl), "settings must expose the exact authorization URL");
  const wordbookRow = settingRows.find((row) => row.name === "收藏到生词本");
  await wordbookRow.controls[0].change("9");
  assert.strictEqual(plugin.settings.frenchLookupWordbookId, "9");
  assert.strictEqual(popups[0].synced, 1, "changing the target wordbook must refresh an already-open popup");
  plugin.frenchDictionaryService.listWordbooks = async () => [{ id: "10", name: "新生词本" }];
  const loadWordbooksRow = settingRows.find((row) => row.name === "读取法语生词本");
  await loadWordbooksRow.controls[0].click();
  assert.strictEqual(plugin.settings.frenchLookupWordbookId, "10");
  assert.strictEqual(popups[0].synced, 2, "a refreshed wordbook list that changes the target must also refresh membership");
  const enabledRow = settingRows.find((row) => row.name === "启用取词浮窗");
  await enabledRow.controls[0].change(false);
  assert.strictEqual(plugin.settings.frenchLookupEnabled, false);
  assert.strictEqual(popups[0].closed, 1, "disabling the feature must immediately close any existing popup");

  plugin.app.secretStorage = null;
  settingRows.length = 0;
  settingTab.renderFrenchLookupSettings(parentEl);
  const tokenRow = settingRows.find((row) => /API 授权码/.test(row.name));
  assert.strictEqual(tokenRow.controls[0].inputEl.type, "password");
  tokenRow.controls[0].change(temporaryToken);
  assert.strictEqual(plugin.getEudicToken(), temporaryToken);
  await plugin.saveSettings();
  assert.ok(!JSON.stringify(settingsSaves).includes(temporaryToken), "legacy fallback tokens must remain in memory, outside settings saves");

  plugin.initializeFrenchLookup();
  assert.strictEqual(popups[0].destroyed, 1);
  assert.strictEqual(translators[0].destroyed, 1);
  assert.strictEqual(popups[1].started, 1);
  plugin.onunload();
  assert.strictEqual(popups[1].destroyed, 1, "unloading the plugin must destroy its current popup controller");
  assert.strictEqual(translators[1].destroyed, 1, "unloading the plugin must cancel its current translation controller");
  plugin.loadData = async () => ({
    frenchLookupEnabled: false, autoSyncOnStartup: false,
    pluginHttpProxyEnabled: false, pluginHttpProxyUrl: "http://127.0.0.1:8888",
    githubProxyEnabled: true, githubProxyUrl: "http://127.0.0.1:6789",
  });
  global.document = {};
  try { await plugin.onload(); } finally { global.document = previousDocument; }
  assert.strictEqual(plugin.settings.pluginHttpProxyEnabled, false, "explicit modern proxy preferences take precedence over legacy settings");
  assert.strictEqual(plugin.settings.pluginHttpProxyUrl, "http://127.0.0.1:8888");
  plugin.onunload();
  console.log("French lookup integration tests passed");
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
