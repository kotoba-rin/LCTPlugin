const {
  ACTIVE_STATUSES,
  normalizeProjectTranslations,
  workspaceError,
} = require("./workspace-store");
const { normalizeControllerError } = require("./interpretation-controller");
const { segmentKeyFor } = require("./session-store");

class InterpretationWorkspaceController {
  constructor({
    resolver,
    promptBuilder,
    store,
    runtime,
    skillCatalog,
    onState = () => {},
    persistWorkspace = async () => {},
  } = {}) {
    if (
      !resolver
      || !promptBuilder
      || !store
      || !runtime
      || !skillCatalog
    ) {
      throw new TypeError(
        "InterpretationWorkspaceController requires all domain services."
      );
    }
    this.resolver = resolver;
    this.promptBuilder = promptBuilder;
    this.store = store;
    this.runtime = runtime;
    this.skillCatalog = skillCatalog;
    this.onState = onState;
    this.persistWorkspace = persistWorkspace;
    this.runningTurns = new Map();
    this.pendingInterpretations = new Map();
    this.contexts = new Map();
  }

  snapshot() {
    return this.store.snapshot();
  }

  runningCount() {
    return this.runningTurns.size;
  }

  interpret(
    sourcePath,
    requestedId,
    {
      model = "",
      effort = "",
      forceNew = false,
    } = {}
  ) {
    const normalizedSourcePath = String(sourcePath || "").trim();
    const normalizedRequestedId = String(requestedId || "").trim().toLowerCase();
    const requestKey = [
      normalizedSourcePath,
      normalizedRequestedId,
      forceNew ? "new" : "reuse",
    ].join("::");
    if (this.pendingInterpretations.has(requestKey)) {
      return this.pendingInterpretations.get(requestKey);
    }
    const operation = this.performInterpret(
      normalizedSourcePath,
      normalizedRequestedId,
      { model, effort, forceNew }
    ).finally(() => {
      this.pendingInterpretations.delete(requestKey);
    });
    this.pendingInterpretations.set(requestKey, operation);
    return operation;
  }

  async performInterpret(
    sourcePath,
    requestedId,
    { model, effort, forceNew }
  ) {
    let conversation;
    try {
      const context = await this.resolver.resolve(sourcePath, requestedId);
      const builtPrompt = this.promptBuilder.buildInitial(context);
      const segmentKey = segmentKeyFor(context);
      if (!forceNew) {
        const existing = this.store.findLatest(segmentKey);
        if (existing) {
          this.store.open(existing.id);
          if (context.analysisMode === "original") {
            this.store.update(existing.id, {
              projectTranslations: normalizeProjectTranslations(context.alignedTranslations),
            });
          }
          this.contexts.set(existing.id, context);
          let staleError = null;
          if (
            existing.contextHash
            && existing.contextHash !== context.contextHash
          ) {
            staleError = {
              code: "ContextChanged",
              message: "分段或相关资料已经变化，可重新解读以使用当前内容。",
            };
          } else if (
            String(existing.promptVersion || "") !== builtPrompt.promptVersion
          ) {
            staleError = {
              code: "PromptChanged",
              message: "全局解读提示词已经变化，请重新解读以使用新提示词。",
            };
          }
          if (staleError && !ACTIVE_STATUSES.has(existing.status)) {
            this.store.update(existing.id, {
              status: "stale",
              error: staleError,
            });
          }
          if (
            existing.contextHash === context.contextHash
            && existing.promptVersion === builtPrompt.promptVersion
            && !String(existing.answer || "").trim()
            && existing.messages.length === 0
          ) {
            return await this.restoreEmptyConversation(existing.id, context);
          }
          await this.publish({ persist: true });
          return {
            state: "opened",
            conversationId: existing.id,
            conversation: this.store.get(existing.id),
          };
        }
      }
      conversation = this.store.createConversation({
        context,
        model,
        effort,
      });
      this.contexts.set(conversation.id, context);
      this.store.appendMessage(conversation.id, {
        role: "user",
        kind: "initial",
        status: "completed",
        content: initialMessageLabel(context),
      });
      this.store.update(conversation.id, {
        status: "starting",
        promptVersion: builtPrompt.promptVersion,
      });
      await this.publish({ persist: true });
      return await this.startInitialTurn(
        conversation.id,
        context,
        builtPrompt
      );
    } catch (error) {
      if (conversation) {
        this.store.update(conversation.id, {
          status: "failed",
          error: normalizeControllerError(error),
        });
        await this.publish({ persist: true });
        return {
          state: "failed",
          conversationId: conversation.id,
          error: normalizeControllerError(error),
        };
      }
      return {
        state: "failed",
        error: normalizeControllerError(error),
      };
    }
  }

  async restoreEmptyConversation(conversationId, context) {
    const conversation = this.store.get(conversationId);
    if (!conversation?.threadId || typeof this.runtime.restoreThread !== "function") {
      const error = normalizeControllerError(workspaceError(
        "EmptyAgentResponse",
        "旧会话没有可显示的回答，请重新解读。"
      ));
      this.store.update(conversationId, {
        status: "failed",
        error,
      });
      await this.publish({ persist: true });
      return { state: "failed", conversationId, error };
    }
    this.store.update(conversationId, {
      status: "starting",
      error: null,
    });
    await this.publish({ persist: true });
    try {
      const built = this.promptBuilder.buildInitial(context);
      const restored = await this.runtime.restoreThread({
        threadId: conversation.threadId,
        baseInstructions: built.baseInstructions,
        model: conversation.model,
        researchEnabled: context.analysisMode !== "original",
        allowSkillRead: true,
      });
      const text = String(restored.text || "");
      if (!text.trim()) {
        throw workspaceError(
          "EmptyAgentResponse",
          "旧会话没有可显示的回答，请重新解读。"
        );
      }
      this.store.appendMessage(conversationId, {
        role: "user",
        kind: "initial",
        status: "completed",
        content: initialMessageLabel(context),
      });
      this.store.appendMessage(conversationId, {
        role: "assistant",
        kind: "initial",
        status: restored.status === "interrupted"
          ? "interrupted"
          : "completed",
        content: text,
      });
      const status = restored.status === "interrupted"
        ? "interrupted"
        : "completed";
      this.store.update(conversationId, {
        threadId: restored.threadId,
        status,
        answer: text,
        error: status === "interrupted"
          ? {
              code: "TurnInterrupted",
              message: "旧会话曾被停止，已恢复当时收到的内容。",
            }
          : null,
      });
      await this.publish({ persist: true });
      return {
        state: status,
        conversationId,
        threadId: restored.threadId,
        text,
      };
    } catch (error) {
      const normalized = normalizeControllerError(error);
      this.store.update(conversationId, {
        status: "failed",
        error: normalized,
      });
      await this.publish({ persist: true });
      return {
        state: "failed",
        conversationId,
        error: normalized,
      };
    }
  }

  async startInitialTurn(conversationId, context, builtPrompt = null) {
    const { availableSkills } = await this.skillCatalog.resolveAvailable();
    this.store.update(conversationId, {
      availableSkillSnapshot: compactSkillSnapshot(availableSkills),
    });
    const built = applyAvailableSkillsToPrompt(
      builtPrompt || this.promptBuilder.buildInitial(context),
      availableSkills
    );
    return this.executeTurn({
      conversationId,
      context,
      baseInstructions: built.baseInstructions,
      prompt: built.userPrompt,
      threadId: "",
      kind: "initial",
    });
  }

  async followUp(conversationId, question) {
    const conversation = this.store.get(conversationId);
    if (!conversation) {
      return {
        state: "failed",
        error: normalizeControllerError(
          workspaceError("ConversationNotFound", "找不到这个解读会话。")
        ),
      };
    }
    if (this.runningTurns.has(conversationId)) {
      return {
        state: "busy",
        conversationId,
        error: normalizeControllerError(workspaceError(
          "TurnBusy",
          "这个会话仍在生成，问题草稿已经保留。"
        )),
      };
    }
    if (this.runningTurns.size >= this.store.maxOpenSessions) {
      return {
        state: "busy",
        conversationId,
        error: normalizeControllerError(workspaceError(
          "ConcurrencyLimit",
          `当前已有 ${this.runningTurns.size} 个任务在生成，问题草稿已经保留。`
        )),
      };
    }
    const normalizedQuestion = String(
      question === undefined ? conversation.draft : question
    ).trim();
    if (!normalizedQuestion) {
      return {
        state: "empty",
        conversationId,
        error: normalizeControllerError(workspaceError(
          "EmptyFollowUp",
          "请输入继续追问的内容。"
        )),
      };
    }
    try {
      const context = await this.resolveConversationContext(conversation);
      const { availableSkills } = await this.skillCatalog.resolveAvailable();
      this.store.update(conversationId, {
        availableSkillSnapshot: compactSkillSnapshot(availableSkills),
      });
      const initialPrompt = applyAvailableSkillsToPrompt(
        this.promptBuilder.buildInitial(context),
        availableSkills
      );
      if (
        String(conversation.promptVersion || "")
        !== initialPrompt.promptVersion
      ) {
        throw workspaceError(
          "PromptChanged",
          "全局解读提示词已经变化。请重新解读后再继续追问。"
        );
      }
      const prompt = this.promptBuilder.buildFollowUp(context, normalizedQuestion);
      const userMessage = this.store.appendMessage(conversationId, {
        role: "user",
        kind: "follow-up",
        status: "completed",
        content: normalizedQuestion,
      });
      this.store.update(conversationId, {
        status: "starting",
        error: null,
      });
      await this.publish({ persist: true });
      return await this.executeTurn({
        conversationId,
        context,
        baseInstructions: initialPrompt.baseInstructions,
        prompt,
        threadId: conversation.threadId,
        kind: "follow-up",
        acceptedDraft: normalizedQuestion,
        userMessageId: userMessage.id,
      });
    } catch (error) {
      this.store.update(conversationId, {
        status: "failed",
        error: normalizeControllerError(error),
      });
      await this.publish({ persist: true });
      return {
        state: "failed",
        conversationId,
        error: normalizeControllerError(error),
      };
    }
  }

  async executeTurn({
    conversationId,
    context,
    baseInstructions,
    prompt,
    threadId,
    kind,
    acceptedDraft,
    userMessageId,
  }) {
    if (this.runningTurns.has(conversationId)) {
      return {
        state: "busy",
        conversationId,
        error: normalizeControllerError(workspaceError(
          "TurnBusy",
          "这个会话仍在生成。"
        )),
      };
    }
    if (this.runningTurns.size >= this.store.maxOpenSessions) {
      return {
        state: "busy",
        conversationId,
        error: normalizeControllerError(workspaceError(
          "ConcurrencyLimit",
          "同时生成的任务已经达到会话上限。"
        )),
      };
    }
    const conversationBeforeTurn = this.store.get(conversationId);
    const assistantMessage = this.store.appendMessage(conversationId, {
      role: "assistant",
      kind,
      status: "pending",
      content: "",
    });
    const turnState = {
      threadId: String(threadId || ""),
      turnId: "",
      assistantMessageId: assistantMessage.id,
      userMessageId,
      accepted: false,
    };
    this.runningTurns.set(conversationId, turnState);
    try {
      const result = await this.runtime.runTurn({
        ...(threadId ? { threadId } : {}),
        baseInstructions,
        prompt,
        model: conversationBeforeTurn.model,
        effort: conversationBeforeTurn.effort,
        researchEnabled: context.analysisMode !== "original",
        allowSkillRead: true,
        onEvent: (event) => {
          void this.handleRuntimeEvent(
            conversationId,
            context,
            assistantMessage.id,
            event,
            acceptedDraft
          );
        },
      });
      const status = result.status === "interrupted" ? "interrupted" : "completed";
      this.store.updateMessage(conversationId, assistantMessage.id, {
        content: result.text,
        status,
      });
      this.store.update(conversationId, {
        threadId: result.threadId,
        turnId: result.turnId,
        status,
        answer: result.text,
        error: status === "interrupted"
          ? {
              code: "TurnInterrupted",
              message: "解读已停止，已保留收到的内容。",
            }
          : null,
      });
      this.store.markAttention(conversationId);
      await this.publish({ persist: true });
      return {
        state: status,
        conversationId,
        threadId: result.threadId,
        turnId: result.turnId,
        text: result.text,
      };
    } catch (error) {
      const normalized = normalizeControllerError(error);
      const current = this.store.get(conversationId);
      const partial = current?.messages.find(
        (message) => message.id === assistantMessage.id
      )?.content || "";
      if (turnState.accepted) {
        this.store.updateMessage(conversationId, assistantMessage.id, {
          content: partial,
          status: "failed",
        });
      } else {
        this.store.removeMessage(conversationId, assistantMessage.id);
        if (userMessageId) {
          this.store.removeMessage(conversationId, userMessageId);
        }
      }
      this.store.update(conversationId, {
        status: "failed",
        answer: turnState.accepted
          ? partial || conversationBeforeTurn.answer
          : conversationBeforeTurn.answer,
        error: normalized,
      });
      this.store.markAttention(conversationId);
      await this.publish({ persist: true });
      return {
        state: "failed",
        conversationId,
        error: normalized,
      };
    } finally {
      this.runningTurns.delete(conversationId);
    }
  }

  async handleRuntimeEvent(
    conversationId,
    context,
    assistantMessageId,
    event,
    acceptedDraft
  ) {
    const active = this.runningTurns.get(conversationId);
    if (!active) {
      return;
    }
    if (event.type === "started") {
      active.accepted = true;
      active.threadId = event.threadId;
      active.turnId = event.turnId;
      const currentDraft = this.store.get(conversationId)?.draft || "";
      if (
        acceptedDraft !== undefined
        && currentDraft.trim() === String(acceptedDraft).trim()
      ) {
        this.store.updateDraft(conversationId, "");
      }
      this.store.update(conversationId, {
        threadId: event.threadId,
        turnId: event.turnId,
        status: context.analysisMode === "original" ? "streaming" : "searching",
        error: null,
      });
      await this.publish({ persist: true });
      return;
    }
    if (event.type === "delta") {
      this.store.updateMessage(conversationId, assistantMessageId, {
        content: String(event.text || ""),
        status: "pending",
      });
      this.store.update(conversationId, {
        status: "streaming",
        answer: String(event.text || ""),
        threadId: event.threadId,
        turnId: event.turnId,
      });
      const conversation = this.store.get(conversationId);
      if (
        this.store.activeConversationId !== conversationId
        || conversation.scroll.followLatest === false
      ) {
        this.store.updateScroll(conversationId, {
          // A streamed assistant response is one unread item even if the
          // App Server delivers it in thousands of incremental deltas.
          unseenMessageCount: Math.max(
            1,
            conversation.scroll.unseenMessageCount
          ),
        });
      }
      await this.publish({ persist: false });
    }
  }

  async resolveConversationContext(conversation) {
    if (this.contexts.has(conversation.id)) {
      return this.contexts.get(conversation.id);
    }
    const context = await this.resolver.resolve(
      conversation.sourcePath,
      conversation.requestedId
    );
    this.contexts.set(conversation.id, context);
    return context;
  }

  async retry(conversationId) {
    const conversation = this.store.get(conversationId);
    if (!conversation) {
      return {
        state: "failed",
        error: normalizeControllerError(workspaceError(
          "ConversationNotFound",
          "找不到这个解读会话。"
        )),
      };
    }
    const needsCurrentSlot = conversation.isOpen
      && this.store.openConversationIds.length >= this.store.maxOpenSessions;
    if (needsCurrentSlot) {
      try {
        this.store.close(conversation.id);
        await this.publish({ persist: true });
      } catch (error) {
        return {
          state: "failed",
          conversationId,
          error: normalizeControllerError(error),
        };
      }
    }
    const result = await this.interpret(
      conversation.sourcePath,
      conversation.requestedId,
      {
      model: conversation.model,
      effort: conversation.effort,
      forceNew: true,
      }
    );
    if (needsCurrentSlot && result.state === "failed" && !result.conversationId) {
      this.store.open(conversation.id);
      await this.publish({ persist: true });
    }
    return result;
  }

  async stop(conversationId) {
    const active = this.runningTurns.get(String(conversationId || ""));
    if (!active) {
      return false;
    }
    return this.runtime.interrupt({
      threadId: active.threadId,
      turnId: active.turnId,
    });
  }

  async activate(conversationId) {
    this.store.activate(conversationId);
    await this.publish({ persist: true });
    return this.store.get(conversationId);
  }

  async close(conversationId) {
    this.store.close(conversationId);
    await this.publish({ persist: true });
    return true;
  }

  async delete(conversationId) {
    const removed = this.store.delete(conversationId);
    await this.publish({ persist: true });
    return removed;
  }

  async clearAll() {
    if (this.runningTurns.size > 0 || this.pendingInterpretations.size > 0) {
      throw workspaceError(
        "ConversationClearBusy",
        "仍有 AI 任务正在运行，请先停止并等待任务结束后再清空全部会话。"
      );
    }
    const removedCount = this.store.clearAll();
    this.contexts.clear();
    await this.publish({ persist: true });
    return removedCount;
  }

  async rename(conversationId, title) {
    const conversation = this.store.rename(conversationId, title);
    await this.publish({ persist: true });
    return conversation;
  }

  async updateDraft(conversationId, draft) {
    this.store.updateDraft(conversationId, draft);
    await this.publish({ persist: false });
  }

  async updateScroll(conversationId, scroll) {
    this.store.updateScroll(conversationId, scroll);
    await this.publish({ persist: false });
  }

  async publish({ persist = false } = {}) {
    const snapshot = this.store.snapshot();
    this.onState(snapshot);
    if (persist) {
      await this.persistWorkspace(this.store.serialize());
    }
    return snapshot;
  }
}

const initialMessageLabel = (context) => `${context.reference.requestedId} · ${
  context.analysisMode === "original" ? "原文解析" : "初始解读"
}`;

const applyAvailableSkillsToPrompt = (built, skills = []) => ({
  ...built,
  baseInstructions: [
    built.baseInstructions,
    "",
    "Skills 自动发现：下列目录来自当前项目与本次配置的 agent 实际安装的 skills。",
    "这只是可用目录，不代表已经使用；根据本次用户请求和 skill 描述按需选择，可使用零个、一个或多个，不存在主要或辅助绑定。",
    "只使用此目录中的 skills；先读取所选 SKILL.md，再按需读取其必要支持文件。不得把整个清单当成必须执行的指令。",
    "遵守 agent 原生隐式调用策略及 skill 自身的 allow_implicit_invocation 限制；目录不是显式调用，不得据此启用禁止隐式调用的 skill。",
    "读取 skills 定义及必要支持文件是本地资料范围的例外；它不扩大业务文件范围、写入权限、工具或网络权限。与当前任务的固定限制冲突的步骤不得执行。",
    "历史消息中的旧 Skill 方案、主要/辅助选择与旧清单不再约束本次选择，以当前目录为准。",
    "<available-skills>",
    JSON.stringify(skills.map((skill) => ({
      name: skill.name,
      description: skill.description,
      scope: skill.scope,
      path: skill.path,
      ...(skill.policy ? { policy: skill.policy } : {}),
    }))).replace(/</g, "\\u003c").replace(/>/g, "\\u003e"),
    "</available-skills>",
  ].join("\n"),
});

const compactSkillSnapshot = (skills) => (
  Array.isArray(skills) ? skills : []
).map((skill) => ({
  name: String(skill?.name || ""),
  scope: String(skill?.scope || ""),
  path: String(skill?.path || ""),
  description: String(skill?.description || ""),
}));

module.exports = {
  InterpretationWorkspaceController,
  applyAvailableSkillsToPrompt,
  compactSkillSnapshot,
};
