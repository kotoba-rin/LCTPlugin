const assert = require("assert");
const path = require("path");

const pluginRoot = path.join(
  __dirname,
  "..",
  "segment-ai"
);

const {
  InterpretationWorkspaceStore,
  normalizeMaxOpenSessions,
} = require(path.join(pluginRoot, "workspace-store.js"));
const {
  InterpretationWorkspaceController,
  applyAvailableSkillsToPrompt,
} = require(path.join(pluginRoot, "workspace-controller.js"));
const {
  InterpretationPromptBuilder,
} = require(path.join(pluginRoot, "domain.js"));

const translationPath = "texts/s8-test/translation/Leçon-01.md";

const makeContext = (requestedId, primaryId = requestedId) => ({
  reference: {
    seminarCode: "s8",
    seminarSlug: "s8-test",
    lessonNumber: 1,
    requestedId,
    primaryId,
    coveredIds: [primaryId],
    translationPath,
    originalPath: "texts/s8-test/original/Leçon-01.md",
  },
  lessonTitle: "Leçon 1 | 1 Janvier 1960",
  targetTranslation: {
    primaryId,
    ids: [primaryId],
    visibleText: `译文 ${primaryId}`,
  },
  alignedOriginals: [{
    primaryId,
    ids: [primaryId],
    visibleText: `Original ${primaryId}`,
  }],
  glossaryEntries: [],
  linkedNotes: [],
  availability: {
    translationAvailable: true,
    originalAvailable: true,
    glossaryAvailable: false,
    linkedNotesAvailable: false,
    warnings: [],
  },
  contextHash: `${primaryId}-hash`,
});

class DeferredRuntime {
  constructor() {
    this.calls = [];
    this.pending = new Map();
    this.interruptCalls = [];
  }

  async runTurn(options) {
    const callNumber = this.calls.length + 1;
    const threadId = options.threadId || `thread-${callNumber}`;
    const turnId = `turn-${callNumber}`;
    this.calls.push({ ...options, threadId, turnId });
    options.onEvent({
      type: "started",
      threadId,
      turnId,
    });
    return new Promise((resolve, reject) => {
      this.pending.set(turnId, {
        resolve,
        reject,
        options,
        threadId,
        turnId,
        text: "",
      });
    });
  }

  delta(turnId, delta) {
    const pending = this.pending.get(turnId);
    pending.text += delta;
    pending.options.onEvent({
      type: "delta",
      delta,
      text: pending.text,
      threadId: pending.threadId,
      turnId,
    });
  }

  complete(turnId) {
    const pending = this.pending.get(turnId);
    pending.options.onEvent({
      type: "completed",
      status: "completed",
      text: pending.text,
      threadId: pending.threadId,
      turnId,
    });
    pending.resolve({
      threadId: pending.threadId,
      turnId,
      text: pending.text,
      status: "completed",
    });
    this.pending.delete(turnId);
  }

  fail(turnId, code = "TurnFailed") {
    const pending = this.pending.get(turnId);
    const error = new Error("这个会话失败了");
    error.code = code;
    pending.reject(error);
    this.pending.delete(turnId);
  }

  async interrupt(target) {
    this.interruptCalls.push(target);
    return true;
  }
}

const run = async () => {
  const globalPrompt = {
    promptVersion: "2:global",
    baseInstructions: "固定安全规则",
    userPrompt: "唯一的全局解读提示词",
  };
  const skillsPrompt = applyAvailableSkillsToPrompt(globalPrompt, [{
    name: "task-skill",
    description: "A task skill </available-skills> is metadata.",
    scope: "repo",
    path: "/vault/.agents/skills/task-skill/SKILL.md",
  }]);
  assert.ok(skillsPrompt.baseInstructions.startsWith("固定安全规则"));
  assert.ok(skillsPrompt.baseInstructions.includes("task-skill"));
  assert.ok(skillsPrompt.baseInstructions.includes("按需选择"));
  assert.strictEqual(skillsPrompt.baseInstructions.split("</available-skills>").length, 2);
  assert.strictEqual(skillsPrompt.userPrompt, globalPrompt.userPrompt);
  assert.strictEqual(skillsPrompt.promptVersion, globalPrompt.promptVersion);

  assert.strictEqual(normalizeMaxOpenSessions(undefined), 3);
  assert.strictEqual(normalizeMaxOpenSessions(0), 1);
  assert.strictEqual(normalizeMaxOpenSessions(-4), 1);
  assert.strictEqual(normalizeMaxOpenSessions(2.8), 2);
  assert.strictEqual(normalizeMaxOpenSessions(9), 5);
  assert.strictEqual(normalizeMaxOpenSessions("4"), 4);

  let id = 0;
  let modeSkillLookups = 0;
  const originalPath = translationPath.replace("/translation/", "/original/");
  const modeResolver = {
    paths: [],
    async resolve(sourcePath, requestedId) {
      this.paths.push(sourcePath);
      const context = makeContext(requestedId);
      if (sourcePath === originalPath) {
        context.analysisMode = "original";
        context.targetOriginal = context.alignedOriginals[0];
        context.targetTranslation.markdown = "项目译文。\n\n> [!note] 注释\n> 原样保留。\n\n> [!tip] 建言\n> 建议内容。";
        context.targetTranslation.sourcePath = translationPath;
        context.alignedTranslations = [context.targetTranslation];
        context.contextHash += "-original";
      }
      return context;
    },
  };
  const modeStore = new InterpretationWorkspaceStore({
    maxOpenSessions: 4,
    idFactory: (prefix) => `${prefix}-mode-${++id}`,
  });
  const modeCalls = [];
  const modeServices = {
    resolver: modeResolver,
    promptBuilder: new InterpretationPromptBuilder(),
    skillCatalog: {
      async resolveAvailable() {
        modeSkillLookups += 1;
        return { availableSkills: [] };
      },
    },
    runtime: {
      async runTurn(options) {
        modeCalls.push(options);
        return {
          threadId: options.threadId || `mode-thread-${modeCalls.length}`,
          turnId: `mode-turn-${modeCalls.length}`,
          text: `回答 ${modeCalls.length}`,
          status: "completed",
        };
      },
    },
  };
  const modeController = new InterpretationWorkspaceController({
    ...modeServices,
    store: modeStore,
  });
  const translatedResult = await modeController.interpret(translationPath, "s8-01-0001");
  const originalResult = await modeController.interpret(originalPath, "s8-01-0001");
  assert.strictEqual(translatedResult.state, "completed");
  assert.strictEqual(originalResult.state, "completed");
  assert.notStrictEqual(originalResult.conversationId, translatedResult.conversationId);
  const originalConversation = modeStore.get(originalResult.conversationId);
  assert.strictEqual(originalConversation.segmentKey, `${originalPath}::s8-01-0001`);
  assert.strictEqual(originalConversation.sourcePath, originalPath);
  assert.strictEqual(originalConversation.analysisMode, "original");
  assert.ok(originalConversation.projectTranslations[0].markdown.includes("建言"));
  assert.strictEqual(modeCalls[0].researchEnabled, true);
  assert.strictEqual(modeCalls[1].researchEnabled, false);
  assert.ok(!Object.hasOwn(modeCalls[1], "skillInputs"));
  assert.strictEqual(modeCalls[1].allowSkillRead, true);
  assert.ok(originalConversation.title.includes("原文解析"));
  assert.ok(originalConversation.messages[0].content.includes("原文解析"));
  assert.notStrictEqual(
    originalConversation.promptVersion,
    modeStore.get(translatedResult.conversationId).promptVersion
  );
  const reopenedOriginal = await modeController.interpret(originalPath, "s8-01-0001");
  assert.strictEqual(reopenedOriginal.state, "opened");
  assert.strictEqual(reopenedOriginal.conversationId, originalResult.conversationId);
  assert.strictEqual(modeCalls.length, 2, "opening an existing original analysis must reuse its history");

  const restartedModeStore = new InterpretationWorkspaceStore({
    ...modeStore.serialize(),
    maxOpenSessions: 4,
    idFactory: (prefix) => `${prefix}-mode-restart-${++id}`,
  });
  const restartedModeController = new InterpretationWorkspaceController({
    ...modeServices,
    store: restartedModeStore,
  });
  const originalFollowUp = await restartedModeController.followUp(
    originalResult.conversationId,
    "这个词的第二个义项有词典依据吗？"
  );
  assert.strictEqual(originalFollowUp.state, "completed", "existing original histories continue after enabling automatic Skills");
  assert.strictEqual(modeResolver.paths.at(-1), originalPath);
  assert.strictEqual(modeCalls.at(-1).threadId, originalResult.threadId);
  const originalRetry = await restartedModeController.retry(originalResult.conversationId);
  assert.strictEqual(originalRetry.state, "completed");
  assert.strictEqual(modeResolver.paths.at(-1), originalPath);
  assert.strictEqual(restartedModeStore.get(originalRetry.conversationId).analysisMode, "original");
  assert.strictEqual(modeSkillLookups, 4, "both translation and original turns must discover Skills");
  assert.strictEqual(modeCalls.at(-1).researchEnabled, false);
  assert.strictEqual(
    restartedModeStore.get(translatedResult.conversationId).analysisMode,
    "interpretation",
    "legacy translation histories should keep their original mode"
  );

  const store = new InterpretationWorkspaceStore({
    maxOpenSessions: 2,
    idFactory: (prefix) => `${prefix}-${++id}`,
    now: () => new Date("2026-07-23T08:00:00.000Z"),
  });
  const first = store.createConversation({
    context: makeContext("s8-01-0001"),
  });
  const second = store.createConversation({
    context: makeContext("s8-01-0002"),
  });
  assert.deepStrictEqual(store.snapshot().openConversationIds, [first.id, second.id]);
  assert.strictEqual(store.snapshot().activeConversationId, second.id);
  store.update(first.id, { status: "streaming" });
  store.update(second.id, { status: "starting" });
  assert.throws(
    () => store.createConversation({
      context: makeContext("s8-01-0003"),
      }),
    (error) => error.code === "OpenSessionLimit"
  );
  store.update(first.id, { status: "idle" });
  store.update(second.id, { status: "idle" });

  store.updateDraft(first.id, "尚未发送的问题");
  store.updateScroll(first.id, {
    followLatest: false,
    scrollTop: 240,
    unseenMessageCount: 2,
  });
  store.activate(first.id);
  store.updateScroll(second.id, {
    followLatest: true,
    scrollTop: 0,
    unseenMessageCount: 7,
  });
  store.activate(second.id);
  assert.strictEqual(
    store.get(second.id).scroll.unseenMessageCount,
    0,
    "activating a conversation that follows latest should clear stale unread updates"
  );
  store.activate(first.id);
  store.close(second.id);
  assert.strictEqual(store.get(first.id).draft, "尚未发送的问题");
  assert.deepStrictEqual(store.get(first.id).scroll, {
    followLatest: false,
    scrollTop: 240,
    unseenMessageCount: 2,
  });
  assert.strictEqual(store.get(second.id).isOpen, false);
  assert.ok(store.listHistory().some((conversation) => conversation.id === second.id));
  store.open(second.id);
  assert.strictEqual(store.snapshot().activeConversationId, second.id);
  store.rename(second.id, "欲望与要求");
  assert.strictEqual(store.get(second.id).title, "欲望与要求");
  store.close(first.id);
  assert.strictEqual(store.delete(first.id), true);
  assert.strictEqual(store.get(first.id), undefined);

  const clearStore = new InterpretationWorkspaceStore({
    maxOpenSessions: 3,
    idFactory: (prefix) => `${prefix}-clear-${++id}`,
  });
  clearStore.createConversation({
    context: makeContext("s8-01-0003"),
  });
  clearStore.createConversation({
    context: makeContext("s8-01-0004"),
  });
  assert.strictEqual(clearStore.clearAll(), 2);
  assert.deepStrictEqual(clearStore.snapshot().conversations, []);
  assert.deepStrictEqual(clearStore.snapshot().openConversationIds, []);
  assert.strictEqual(clearStore.snapshot().activeConversationId, null);

  const migrated = InterpretationWorkspaceStore.migrateLegacy({
    legacySessions: [{
      segmentKey: `${translationPath}::s8-01-0099`,
      threadId: "legacy-thread",
      contextHash: "legacy-hash",
      promptVersion: "legacy-prompt",
      lastOpenedAt: "2026-07-22T08:00:00.000Z",
      status: "completed",
      answer: "旧回答",
    }],
    idFactory: () => "conversation-legacy",
  });
  assert.strictEqual(migrated.conversations.length, 1);
  assert.strictEqual(migrated.conversations[0].answer, "旧回答");
  assert.strictEqual(migrated.conversations[0].skillMode, "automatic");
  assert.strictEqual(migrated.conversations[0].messages.at(-1).content, "旧回答");

  const restartedStore = new InterpretationWorkspaceStore({
    maxOpenSessions: 3,
    conversations: [{
      id: "conversation-restarted",
      title: "重启前任务",
      segmentKey: `${translationPath}::s8-01-0100`,
      sourcePath: translationPath,
      requestedId: "s8-01-0100",
      primaryId: "s8-01-0100",
      status: "streaming",
      answer: "已经收到的部分内容",
      messages: [{
        id: "message-pending",
        role: "assistant",
        content: "已经收到的部分内容",
        status: "pending",
      }],
        isOpen: true,
    }],
    workspace: {
      openConversationIds: ["conversation-restarted"],
      activeConversationId: "conversation-restarted",
    },
  });
  assert.strictEqual(
    restartedStore.get("conversation-restarted").status,
    "interrupted"
  );
  assert.strictEqual(
    restartedStore.get("conversation-restarted").messages[0].status,
    "interrupted"
  );

  const changedPromptBuilder = new InterpretationPromptBuilder({
    interpretationPrompt: "这是新保存的唯一全局提示词。",
  });
  const promptChangedStore = new InterpretationWorkspaceStore({
    maxOpenSessions: 2,
    conversations: [{
      id: "conversation-old-prompt",
      title: "s8-01-0299",
      segmentKey: `${translationPath}::s8-01-0299`,
      sourcePath: translationPath,
      requestedId: "s8-01-0299",
      primaryId: "s8-01-0299",
      contextHash: "s8-01-0299-hash",
      promptVersion: "1:old-prompt",
      threadId: "thread-old-prompt",
      status: "completed",
      answer: "旧提示词生成的回答。",
      messages: [{
        id: "message-old-prompt",
        role: "assistant",
        kind: "initial",
        status: "completed",
        content: "旧提示词生成的回答。",
      }],
        isOpen: false,
    }],
  });
  let changedPromptRuntimeCalls = 0;
  const promptChangedController = new InterpretationWorkspaceController({
    resolver: {
      async resolve(_sourcePath, requestedId) {
        return makeContext(requestedId);
      },
    },
    promptBuilder: changedPromptBuilder,
    store: promptChangedStore,
    skillCatalog: {
      async resolveAvailable() {
        return { availableSkills: [] };
      },
    },
    runtime: {
      async runTurn() {
        changedPromptRuntimeCalls += 1;
        throw new Error("a stale prompt should not silently start a turn");
      },
    },
  });
  const openedOldPrompt = await promptChangedController.interpret(
    translationPath,
    "s8-01-0299"
  );
  assert.strictEqual(openedOldPrompt.state, "opened");
  assert.strictEqual(
    promptChangedStore.get("conversation-old-prompt").status,
    "stale"
  );
  assert.strictEqual(
    promptChangedStore.get("conversation-old-prompt").error.code,
    "PromptChanged"
  );
  assert.strictEqual(changedPromptRuntimeCalls, 0);

  const restorePromptVersion = new InterpretationPromptBuilder()
    .buildInitial(makeContext("s8-01-0300"))
    .promptVersion;
  const restoreStore = new InterpretationWorkspaceStore({
    maxOpenSessions: 2,
    conversations: [{
      id: "conversation-empty-legacy",
      title: "s8-01-0300",
      segmentKey: `${translationPath}::s8-01-0300`,
      sourcePath: translationPath,
      requestedId: "s8-01-0300",
      primaryId: "s8-01-0300",
      contextHash: "s8-01-0300-hash",
      promptVersion: restorePromptVersion,
      threadId: "thread-empty-legacy",
      status: "completed",
      answer: "",
      messages: [],
        isOpen: false,
    }],
  });
  let restoreCalls = 0;
  const restoreController = new InterpretationWorkspaceController({
    resolver: {
      async resolve(_sourcePath, requestedId) {
        return makeContext(requestedId);
      },
    },
    promptBuilder: new InterpretationPromptBuilder(),
    store: restoreStore,
    skillCatalog: {
      async resolveAvailable() {
        return { availableSkills: [] };
      },
    },
    runtime: {
      async restoreThread({ threadId }) {
        restoreCalls += 1;
        assert.strictEqual(threadId, "thread-empty-legacy");
        return {
          threadId,
          text: "从 Codex thread 恢复的旧回答。",
          status: "completed",
        };
      },
    },
  });
  const restoredLegacy = await restoreController.interpret(
    translationPath,
    "s8-01-0300"
  );
  assert.strictEqual(restoredLegacy.state, "completed");
  assert.strictEqual(restoreCalls, 1);
  assert.strictEqual(
    restoreStore.get("conversation-empty-legacy").answer,
    "从 Codex thread 恢复的旧回答。"
  );

  const controllerStore = new InterpretationWorkspaceStore({
    maxOpenSessions: 3,
    idFactory: (prefix) => `${prefix}-controller-${++id}`,
    now: () => new Date("2026-07-23T09:00:00.000Z"),
  });
  const runtime = new DeferredRuntime();
  const snapshots = [];
  const persisted = [];
  let seminarFingerprint = "seminar-v1";
  const controller = new InterpretationWorkspaceController({
    resolver: {
      async resolve(_sourcePath, requestedId) {
        return makeContext(requestedId);
      },
    },
    promptBuilder: new InterpretationPromptBuilder(),
    store: controllerStore,
    runtime,
    skillCatalog: {
      async resolveAvailable() {
        return {
          availableSkills: [{
            name: `task-skill-${seminarFingerprint}`,
            path: `/vault/.agents/skills/task-skill-${seminarFingerprint}/SKILL.md`,
            description: "Follow the current task.",
            scope: "repo",
          }],
        };
      },
    },
    onState: (snapshot) => snapshots.push(snapshot),
    persistWorkspace: async (snapshot) => persisted.push(snapshot),
  });

  const firstTask = controller.interpret(translationPath, "s8-01-0010", {
  });
  const secondTask = controller.interpret(translationPath, "s8-01-0011", {
    skillProfile: {
      id: "seminar",
      title: "研讨班细读",
      mode: "standard-with-skills",
      primarySkill: {
        name: "translate-lacan-seminars",
        scope: "repo",
      },
      supportingSkills: [],
      additionalInstruction: "",
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.strictEqual(runtime.calls.length, 2, "different conversations should run concurrently");
  assert.strictEqual(controller.runningCount(), 2);
  assert.ok(!Object.hasOwn(runtime.calls[0], "skillInputs"));
  assert.ok(!Object.hasOwn(runtime.calls[1], "skillInputs"));
  assert.ok(runtime.calls.every((call) => call.baseInstructions.includes("task-skill-seminar-v1")));
  assert.ok(runtime.calls.every((call) => call.allowSkillRead === true));

  runtime.delta("turn-1", "第一个会话");
  runtime.delta("turn-1", "继续生成");
  runtime.delta("turn-2", "第二个会话");
  runtime.fail("turn-1");
  runtime.complete("turn-2");
  const [firstResult, secondResult] = await Promise.all([firstTask, secondTask]);
  assert.strictEqual(firstResult.state, "failed");
  assert.strictEqual(secondResult.state, "completed");
  const failedConversation = controllerStore.get(firstResult.conversationId);
  const completedConversation = controllerStore.get(secondResult.conversationId);
  assert.strictEqual(failedConversation.status, "failed");
  assert.strictEqual(
    failedConversation.scroll.unseenMessageCount,
    1,
    "one streaming answer should count as one unseen update, not one per delta"
  );
  assert.strictEqual(completedConversation.status, "completed");
  assert.strictEqual(completedConversation.answer, "第二个会话");
  assert.strictEqual(
    completedConversation.availableSkillSnapshot[0].name,
    "task-skill-seminar-v1"
  );
  assert.strictEqual(controller.runningCount(), 0);
  assert.ok(persisted.length > 0);

  controllerStore.updateDraft(completedConversation.id, "接着追问");
  const followUp = controller.followUp(completedConversation.id);
  await new Promise((resolve) => setImmediate(resolve));
  assert.strictEqual(runtime.calls.length, 3);
  assert.strictEqual(runtime.calls[2].threadId, completedConversation.threadId);
  assert.strictEqual(controllerStore.get(completedConversation.id).draft, "");
  runtime.delta("turn-3", "追问回答");
  runtime.complete("turn-3");
  assert.strictEqual((await followUp).state, "completed");
  assert.deepStrictEqual(
    controllerStore.get(completedConversation.id).messages.map((message) => message.role),
    ["user", "assistant", "user", "assistant"]
  );

  controllerStore.updateDraft(completedConversation.id, "生成时保留的草稿");
  const activeFollowUp = controller.followUp(completedConversation.id);
  await new Promise((resolve) => setImmediate(resolve));
  controllerStore.updateDraft(completedConversation.id, "下一问草稿");
  const rejected = await controller.followUp(completedConversation.id);
  assert.strictEqual(rejected.state, "busy");
  assert.strictEqual(
    controllerStore.get(completedConversation.id).draft,
    "下一问草稿",
    "a rejected send must preserve the per-conversation draft"
  );
  assert.strictEqual(await controller.stop(completedConversation.id), true);
  assert.deepStrictEqual(runtime.interruptCalls.at(-1), {
    threadId: runtime.calls[3].threadId,
    turnId: "turn-4",
  });
  runtime.delta("turn-4", "停止前内容");
  runtime.complete("turn-4");
  await activeFollowUp;

  const existing = await controller.interpret(translationPath, "s8-01-0011", {
    skillProfile: controllerStore.get(completedConversation.id).skillProfile,
  });
  assert.strictEqual(existing.state, "opened");
  assert.strictEqual(existing.conversationId, completedConversation.id);
  assert.strictEqual(runtime.calls.length, 4, "opening the same segment must not rerun even with legacy profile arguments");
  assert.strictEqual(snapshots.at(-1).activeConversationId, completedConversation.id);

  seminarFingerprint = "seminar-v2";
  controllerStore.updateDraft(completedConversation.id, "Skill 更新后的追问");
  const changedSkillTask = controller.followUp(completedConversation.id);
  await new Promise((resolve) => setImmediate(resolve));
  assert.strictEqual(runtime.calls.length, 5);
  assert.ok(runtime.calls[4].baseInstructions.includes("task-skill-seminar-v2"));
  assert.ok(!runtime.calls[4].baseInstructions.includes("task-skill-seminar-v1"));
  runtime.delta("turn-5", "使用新目录的回答");
  runtime.complete("turn-5");
  assert.strictEqual((await changedSkillTask).state, "completed");
  assert.strictEqual(controllerStore.get(completedConversation.id).draft, "");
  assert.strictEqual(
    controllerStore.get(completedConversation.id).availableSkillSnapshot[0].name,
    "task-skill-seminar-v2"
  );

  seminarFingerprint = "seminar-v1";
  controllerStore.updateDraft(completedConversation.id, "恢复 thread 失败时的问题");
  runtime.runTurn = async () => {
    const error = new Error("旧 thread 无法恢复");
    error.code = "ThreadUnavailable";
    throw error;
  };
  const messagesBeforeRejectedStart =
    controllerStore.get(completedConversation.id).messages;
  const answerBeforeRejectedStart =
    controllerStore.get(completedConversation.id).answer;
  const rejectedBeforeStart = await controller.followUp(
    completedConversation.id
  );
  assert.strictEqual(rejectedBeforeStart.state, "failed");
  assert.deepStrictEqual(
    controllerStore.get(completedConversation.id).messages,
    messagesBeforeRejectedStart,
    "a failure before turn acceptance must not leave empty messages behind"
  );
  assert.strictEqual(
    controllerStore.get(completedConversation.id).answer,
    answerBeforeRejectedStart,
    "a failed follow-up start must keep the last visible answer"
  );
  assert.strictEqual(
    controllerStore.get(completedConversation.id).draft,
    "恢复 thread 失败时的问题"
  );

  let singleTurn = 0;
  const singleStore = new InterpretationWorkspaceStore({
    maxOpenSessions: 1,
    idFactory: (prefix) => `${prefix}-single-${++id}`,
  });
  const singleController = new InterpretationWorkspaceController({
    resolver: {
      async resolve(_sourcePath, requestedId) {
        return makeContext(requestedId);
      },
    },
    promptBuilder: new InterpretationPromptBuilder(),
    store: singleStore,
    skillCatalog: {
      async resolveAvailable() {
        return { availableSkills: [] };
      },
    },
    runtime: {
      async runTurn(options) {
        singleTurn += 1;
        const result = {
          threadId: `single-thread-${singleTurn}`,
          turnId: `single-turn-${singleTurn}`,
          text: `单会话回答 ${singleTurn}`,
          status: "completed",
        };
        options.onEvent({ type: "started", ...result });
        options.onEvent({ type: "delta", delta: result.text, ...result });
        return result;
      },
    },
  });
  const singleInitial = await singleController.interpret(
    translationPath,
    "s8-01-0200"
  );
  const singleRetry = await singleController.retry(singleInitial.conversationId);
  assert.strictEqual(singleRetry.state, "completed");
  assert.notStrictEqual(
    singleRetry.conversationId,
    singleInitial.conversationId
  );
  assert.strictEqual(singleStore.get(singleInitial.conversationId).isOpen, false);
  assert.strictEqual(singleStore.listHistory().length, 2);

  const fiveRuntime = new DeferredRuntime();
  const fiveStore = new InterpretationWorkspaceStore({
    maxOpenSessions: 5,
    idFactory: (prefix) => `${prefix}-five-${++id}`,
  });
  const fiveController = new InterpretationWorkspaceController({
    resolver: {
      async resolve(_sourcePath, requestedId) {
        return makeContext(requestedId);
      },
    },
    promptBuilder: new InterpretationPromptBuilder(),
    store: fiveStore,
    skillCatalog: {
      async resolveAvailable() {
        return { availableSkills: [] };
      },
    },
    runtime: fiveRuntime,
  });
  const fiveTasks = Array.from({ length: 5 }, (_, index) =>
    fiveController.interpret(
      translationPath,
      `s8-01-03${String(index + 1).padStart(2, "0")}`
    )
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.strictEqual(fiveRuntime.calls.length, 5);
  assert.strictEqual(fiveController.runningCount(), 5);
  const sixthResult = await fiveController.interpret(
    translationPath,
    "s8-01-0399"
  );
  assert.strictEqual(sixthResult.state, "failed");
  assert.strictEqual(sixthResult.error.code, "OpenSessionLimit");
  assert.strictEqual(
    fiveController.runningCount(),
    5,
    "rejecting a sixth session must not disturb the five active turns"
  );
  await assert.rejects(
    () => fiveController.clearAll(),
    (error) => error.code === "ConversationClearBusy",
    "clear-all must not orphan turns that are still running"
  );
  for (let turnNumber = 1; turnNumber <= 5; turnNumber += 1) {
    fiveRuntime.delta(`turn-${turnNumber}`, `并发回答 ${turnNumber}`);
    fiveRuntime.complete(`turn-${turnNumber}`);
  }
  const fiveResults = await Promise.all(fiveTasks);
  assert.ok(fiveResults.every((result) => result.state === "completed"));
  assert.strictEqual(fiveController.runningCount(), 0);
  assert.strictEqual(await fiveController.clearAll(), 5);
  assert.deepStrictEqual(fiveController.snapshot().conversations, []);
  assert.deepStrictEqual(fiveController.snapshot().openConversationIds, []);
  assert.strictEqual(fiveController.snapshot().activeConversationId, null);
};

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
