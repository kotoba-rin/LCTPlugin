const PROVIDER_DEFINITIONS = Object.freeze([
  Object.freeze({
    id: "codex",
    label: "Codex CLI",
    pathSetting: "segmentAiCodexPath",
    placeholder: "/opt/homebrew/bin/codex",
  }),
  Object.freeze({
    id: "claude",
    label: "Claude Code",
    pathSetting: "segmentAiClaudePath",
    placeholder: "~/.local/bin/claude",
  }),
  Object.freeze({
    id: "deepseek",
    label: "DeepSeek Harness",
    pathSetting: "segmentAiDeepseekPath",
    placeholder: "/opt/homebrew/bin/dsh",
  }),
]);

const normalizeProvider = (value) => {
  const provider = String(value || "").trim().toLowerCase().replace(/\s+/g, "-");
  if (["claude", "claude-code"].includes(provider)) return "claude";
  if (["deepseek", "deepseek-harness", "dsh"].includes(provider)) return "deepseek";
  return "codex";
};

const PROFILE_DEFAULTS = Object.freeze({
  segmentAiModel: "",
  segmentAiReasoningEffort: "",
  segmentAiModelCatalog: [],
  segmentAiModelCatalogUpdatedAt: 0,
  segmentAiSkillCatalog: [],
  segmentAiSkillCatalogUpdatedAt: 0,
  segmentAiConversations: [],
  segmentAiWorkspace: { openConversationIds: [], activeConversationId: null },
  segmentAiSessions: [],
  segmentAiSchemaVersion: 2,
});

const clone = (value) => JSON.parse(JSON.stringify(value));
const isRecord = (value) => Boolean(value && typeof value === "object" && !Array.isArray(value));

const normalizeProfile = (value) => {
  const source = isRecord(value) ? value : {};
  return Object.fromEntries(Object.entries(PROFILE_DEFAULTS).map(([key, fallback]) => {
    let normalized = source[key];
    if (Array.isArray(fallback)) {
      normalized = Array.isArray(normalized) ? normalized : fallback;
    } else if (isRecord(fallback)) {
      normalized = isRecord(normalized) ? normalized : fallback;
    } else if (typeof fallback === "number") {
      normalized = Number.isFinite(normalized) && normalized >= 0 ? normalized : fallback;
    } else if (typeof fallback === "boolean") {
      normalized = normalized === true;
    } else {
      normalized = typeof normalized === "string" ? normalized.trim() : fallback;
    }
    return [key, clone(normalized)];
  }));
};

// Active legacy fields remain the persistence surface used by controllers. Profiles
// snapshot those fields only at migration and provider switches, so every provider
// keeps its own native thread IDs, cached capabilities, and unsent follow-ups.
const normalizeProviderSettings = (settings) => {
  if (!isRecord(settings)) throw new TypeError("Provider settings must be an object.");
  for (const key of Object.keys(settings)) {
    if (key.startsWith("segmentAiMcp")) delete settings[key];
  }
  const provider = normalizeProvider(settings.segmentAiProvider);
  const storedProfiles = isRecord(settings.segmentAiProviderProfiles)
    ? settings.segmentAiProviderProfiles
    : {};
  const profiles = Object.fromEntries(PROVIDER_DEFINITIONS.map(({ id }) => [
    id, normalizeProfile(storedProfiles[id]),
  ]));
  const activeValues = Object.fromEntries(Object.keys(PROFILE_DEFAULTS).map((key) => [
    key,
    Object.prototype.hasOwnProperty.call(settings, key)
      ? settings[key]
      : profiles[provider][key],
  ]));
  const activeProfile = normalizeProfile(activeValues);
  Object.assign(settings, activeProfile);
  profiles[provider] = clone(activeProfile);
  settings.segmentAiProvider = provider;
  settings.segmentAiProviderProfiles = profiles;
  for (const { pathSetting } of PROVIDER_DEFINITIONS) {
    settings[pathSetting] = String(settings[pathSetting] || "").trim();
  }
  return settings;
};

const switchProviderSettings = (settings, nextProvider) => {
  normalizeProviderSettings(settings);
  const provider = normalizeProvider(nextProvider);
  if (settings.segmentAiProvider === provider) return provider;
  Object.assign(settings, clone(settings.segmentAiProviderProfiles[provider]));
  settings.segmentAiProvider = provider;
  return provider;
};

module.exports = {
  PROVIDER_DEFINITIONS,
  normalizeProvider,
  normalizeProviderSettings,
  switchProviderSettings,
};
