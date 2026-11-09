const assert = require("assert");
const {
  PROVIDER_DEFINITIONS,
  normalizeProvider,
  normalizeProviderSettings,
  switchProviderSettings,
} = require("../segment-ai/provider-settings");

assert.deepStrictEqual(PROVIDER_DEFINITIONS.map((provider) => provider.id), [
  "codex", "claude", "deepseek",
]);
assert.strictEqual(normalizeProvider(), "codex");
assert.strictEqual(normalizeProvider("unknown"), "codex");
assert.strictEqual(normalizeProvider("Claude Code"), "claude");
assert.strictEqual(normalizeProvider("dsh"), "deepseek");

const conversation = {
  id: "codex-conversation",
  threadId: "codex-thread",
  draft: "尚未发送的追问",
  messages: [{ role: "assistant", content: "Codex 回答" }],
};
const retiredMcpKeys = [
  "segmentAiMcpEnabled", "segmentAiMcpEnabledServers",
  "segmentAiMcpServerCatalog", "segmentAiMcpServerCatalogUpdatedAt",
];
const assertNoMcpSettings = (settings) => {
  for (const record of [settings, ...Object.values(settings.segmentAiProviderProfiles)]) {
    for (const key of retiredMcpKeys) {
      assert.strictEqual(Object.hasOwn(record, key), false, `${key} must be removed from saved settings`);
    }
  }
};
const legacy = {
  segmentAiCodexPath: " /opt/homebrew/bin/codex ",
  segmentAiModel: "codex-model",
  segmentAiReasoningEffort: "high",
  segmentAiModelCatalog: [{ model: "codex-model" }],
  segmentAiModelCatalogUpdatedAt: 42,
  segmentAiConversations: [conversation],
  segmentAiWorkspace: {
    openConversationIds: [conversation.id],
    activeConversationId: conversation.id,
  },
  segmentAiSkillCatalog: [{ name: "codex-skill", path: "/skill/SKILL.md" }],
  segmentAiMcpEnabled: true,
  segmentAiMcpEnabledServers: ["codex-mcp"],
  segmentAiMcpServerCatalog: ["codex-mcp"],
  segmentAiMcpServerCatalogUpdatedAt: 77,
  segmentAiProviderProfiles: {
    claude: { segmentAiModel: "saved-claude", segmentAiMcpEnabled: true, segmentAiMcpEnabledServers: ["stale"] },
    deepseek: { segmentAiMcpEnabled: true, segmentAiMcpServerCatalog: ["stale"] },
    retiredProvider: { segmentAiMcpEnabled: true, segmentAiMcpServerCatalogUpdatedAt: 99 },
  },
  segmentAiPrompt: "共用提示词",
  segmentAiMaxOpenSessions: 4,
};
assert.strictEqual(normalizeProviderSettings(legacy), legacy);
assert.strictEqual(legacy.segmentAiProvider, "codex");
assert.strictEqual(legacy.segmentAiCodexPath, "/opt/homebrew/bin/codex");
assert.strictEqual(legacy.segmentAiClaudePath, "");
assert.strictEqual(legacy.segmentAiDeepseekPath, "");
assertNoMcpSettings(legacy);
assert.deepStrictEqual(legacy.segmentAiConversations, [conversation]);
assert.notStrictEqual(legacy.segmentAiConversations[0], conversation);
assert.notStrictEqual(
  legacy.segmentAiProviderProfiles.codex.segmentAiConversations,
  legacy.segmentAiConversations
);

assert.strictEqual(switchProviderSettings(legacy, "claude"), "claude");
assert.deepStrictEqual(legacy.segmentAiConversations, []);
assert.deepStrictEqual(legacy.segmentAiWorkspace, {
  openConversationIds: [], activeConversationId: null,
});
assert.strictEqual(legacy.segmentAiModel, "saved-claude");
assert.strictEqual(legacy.segmentAiReasoningEffort, "");
assert.deepStrictEqual(legacy.segmentAiModelCatalog, []);
assert.deepStrictEqual(legacy.segmentAiSkillCatalog, []);
assertNoMcpSettings(legacy);
assert.strictEqual(legacy.segmentAiPrompt, "共用提示词");
assert.strictEqual(legacy.segmentAiMaxOpenSessions, 4);
assert.strictEqual(legacy.segmentAiCodexPath, "/opt/homebrew/bin/codex");

legacy.segmentAiClaudePath = "/users/local/claude";
legacy.segmentAiModel = "claude-model";
legacy.segmentAiConversations.push({
  id: "claude-conversation", threadId: "claude-thread", draft: "Claude 草稿",
});
legacy.segmentAiWorkspace.openConversationIds.push("claude-conversation");
legacy.segmentAiWorkspace.activeConversationId = "claude-conversation";
assert.strictEqual(switchProviderSettings(legacy, "deepseek"), "deepseek");
assert.deepStrictEqual(legacy.segmentAiConversations, []);
legacy.segmentAiModel = "deepseek-model";
legacy.segmentAiConversations.push({ id: "deepseek", threadId: "dsh-session" });

switchProviderSettings(legacy, "codex");
assert.deepStrictEqual(legacy.segmentAiConversations, [conversation]);
assert.strictEqual(legacy.segmentAiModel, "codex-model");
assert.strictEqual(legacy.segmentAiReasoningEffort, "high");
assert.strictEqual(legacy.segmentAiModelCatalogUpdatedAt, 42);
assertNoMcpSettings(legacy);
assert.strictEqual(legacy.segmentAiClaudePath, "/users/local/claude");
legacy.segmentAiConversations[0].draft = "Codex 草稿改动";
assert.strictEqual(
  legacy.segmentAiProviderProfiles.codex.segmentAiConversations[0].draft,
  "尚未发送的追问"
);
switchProviderSettings(legacy, "claude");
assert.strictEqual(legacy.segmentAiModel, "claude-model");
assert.deepStrictEqual(legacy.segmentAiConversations.map((item) => item.threadId), ["claude-thread"]);
assert.strictEqual(legacy.segmentAiConversations[0].draft, "Claude 草稿");
switchProviderSettings(legacy, "codex");
assert.strictEqual(legacy.segmentAiConversations[0].draft, "Codex 草稿改动");

// Saved active values remain authoritative over an older profile snapshot.
const reloaded = JSON.parse(JSON.stringify(legacy));
reloaded.segmentAiModel = "new-model-after-settings-save";
normalizeProviderSettings(reloaded);
assert.strictEqual(reloaded.segmentAiModel, "new-model-after-settings-save");
assert.strictEqual(reloaded.segmentAiProviderProfiles.codex.segmentAiModel, reloaded.segmentAiModel);
switchProviderSettings(reloaded, "codex");
assert.strictEqual(reloaded.segmentAiConversations[0].draft, "Codex 草稿改动");

const malformed = {
  segmentAiProvider: "unknown",
  segmentAiConversations: null,
  segmentAiWorkspace: [],
  segmentAiModelCatalog: "bad",
  segmentAiModelCatalogUpdatedAt: "bad",
  segmentAiMcpEnabled: "true",
  segmentAiMcpEnabledServers: null,
  segmentAiProviderProfiles: { claude: null, deepseek: [] },
};
normalizeProviderSettings(malformed);
assert.strictEqual(malformed.segmentAiProvider, "codex");
assert.deepStrictEqual(malformed.segmentAiConversations, []);
assert.deepStrictEqual(malformed.segmentAiWorkspace, { openConversationIds: [], activeConversationId: null });
assert.deepStrictEqual(malformed.segmentAiModelCatalog, []);
assert.strictEqual(malformed.segmentAiModelCatalogUpdatedAt, 0);
assertNoMcpSettings(malformed);
assert.strictEqual(switchProviderSettings(malformed, "bad"), "codex");

const legacySessions = { segmentAiSessions: [{ threadId: "legacy-codex" }] };
normalizeProviderSettings(legacySessions);
switchProviderSettings(legacySessions, "claude");
assert.deepStrictEqual(legacySessions.segmentAiSessions, []);
switchProviderSettings(legacySessions, "codex");
assert.deepStrictEqual(legacySessions.segmentAiSessions, [{ threadId: "legacy-codex" }]);

// Old true values must never be carried back by any provider switch or reload.
for (const provider of ["codex", "claude", "deepseek", "codex"]) {
  legacy.segmentAiMcpEnabled = true;
  legacy.segmentAiProviderProfiles.deepseek.segmentAiMcpEnabledServers = ["stale"];
  switchProviderSettings(legacy, provider);
  assertNoMcpSettings(legacy);
}
const withoutMcpAfterReload = normalizeProviderSettings(JSON.parse(JSON.stringify(legacy)));
assertNoMcpSettings(withoutMcpAfterReload);
