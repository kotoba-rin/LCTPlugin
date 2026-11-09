const assert = require("assert");
const { EventEmitter } = require("events");
const path = require("path");
const { PassThrough } = require("stream");

const runtimeModulePath = path.join(
  __dirname,
  "..",
  "segment-ai",
  "codex-app-server-runtime.js"
);

const {
  CodexAppServerRuntime,
  READ_ONLY_SANDBOX_POLICY,
  coerceCodexReasoningEffort,
  normalizeCodexModelCatalog,
  resolveCodexCli,
  resolveCodexReasoningProfile,
} = require(runtimeModulePath);

const VAULT_ROOT = "/Users/example/Lacan-Vault";
const CLI_PATH = process.execPath;

assert.strictEqual(resolveCodexCli(CLI_PATH), CLI_PATH);
assert.throws(
  () => resolveCodexCli("/definitely/missing/codex"),
  (error) => error.code === "CodexNotFound"
);

class ScriptedAppServerProcess extends EventEmitter {
  constructor(handler) {
    super();
    this.stdin = new PassThrough();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.messages = [];
    this.killed = false;
    this.handler = handler;
    let buffer = "";
    this.stdin.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split("\n");
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.trim()) {
          continue;
        }
        const message = JSON.parse(line);
        this.messages.push(message);
        if (
          Object.prototype.hasOwnProperty.call(message, "id")
          && message.method === "config/read"
        ) {
          this.respond(message, globalMcpConfigResponse);
        } else {
          this.handler(message, this);
        }
      }
    });
  }

  respond(request, result) {
    this.stdout.write(`${JSON.stringify({ id: request.id, result })}\n`);
  }

  fail(request, code, message) {
    this.stdout.write(`${JSON.stringify({
      id: request.id,
      error: { code, message },
    })}\n`);
  }

  notify(method, params) {
    this.stdout.write(`${JSON.stringify({ method, params })}\n`);
  }

  kill() {
    this.killed = true;
    this.emit("exit", 0, null);
  }
}

const initializeResponse = {
  codexHome: "/Users/example/.codex",
  platformFamily: "unix",
  platformOs: "macos",
  userAgent: "codex-cli/0.144.5",
};

const accountResponse = {
  account: {
    email: "reader@example.com",
    planType: "plus",
    type: "chatgpt",
  },
  requiresOpenaiAuth: true,
};

const globalMcpConfigResponse = {
  config: {
    mcp_servers: {
      "global-server": {
        command: "global-server",
        enabled: true,
      },
    },
  },
  origins: {},
};

const threadResponse = (threadId) => ({
  activePermissionProfile: null,
  approvalPolicy: "never",
  approvalsReviewer: "user",
  cwd: VAULT_ROOT,
  instructionSources: [],
  model: "gpt-5.6-terra",
  modelProvider: "openai",
  multiAgentMode: "explicitRequestOnly",
  reasoningEffort: null,
  runtimeWorkspaceRoots: [],
  sandbox: {
    type: "readOnly",
    networkAccess: false,
  },
  serviceTier: null,
  thread: {
    id: threadId,
    preview: "",
    modelProvider: "openai",
    createdAt: 1,
    updatedAt: 1,
    status: { type: "idle" },
    path: null,
    cwd: VAULT_ROOT,
    cliVersion: "0.144.5",
    source: "appServer",
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    turns: [],
  },
});

const turn = (id, status) => ({
  id,
  items: [],
  status,
  error: null,
});

const globalMcpInventory = {
  data: [
    {
      authStatus: "unsupported",
      name: "global-server",
      resourceTemplates: [],
      resources: [],
      tools: {
        lookup: {
          name: "lookup",
          description: "A configured global tool.",
          inputSchema: { type: "object" },
        },
      },
    },
  ],
  nextCursor: null,
};

const isolatedMcpInventory = {
  data: [],
  nextCursor: null,
};

const createHappyHandler = () => (message, process) => {
  if (!Object.prototype.hasOwnProperty.call(message, "id")) {
    return;
  }
  switch (message.method) {
    case "initialize":
      process.respond(message, initializeResponse);
      break;
    case "account/read":
      process.respond(message, accountResponse);
      break;
    case "mcpServerStatus/list":
      process.respond(
        message,
        message.params.threadId ? isolatedMcpInventory : globalMcpInventory
      );
      break;
    case "thread/start":
      process.respond(message, threadResponse("thread-1"));
      break;
    case "app/list":
      process.respond(message, { data: [], nextCursor: null });
      break;
    case "turn/start":
      process.respond(message, { turn: turn("turn-1", "inProgress") });
      setImmediate(() => {
        process.notify("unknown/notification", { ignored: true });
        process.notify("item/agentMessage/delta", {
          delta: "第一段",
          itemId: "item-1",
          threadId: "thread-1",
          turnId: "turn-1",
        });
        process.notify("item/agentMessage/delta", {
          delta: "第二段",
          itemId: "item-1",
          threadId: "thread-1",
          turnId: "turn-1",
        });
        process.notify("turn/completed", {
          threadId: "thread-1",
          turn: turn("turn-1", "completed"),
        });
      });
      break;
    default:
      process.fail(message, -32601, `Unsupported test method: ${message.method}`);
  }
};

const runHappyPath = async () => {
  const spawnCalls = [];
  let fakeProcess;
  const runtime = new CodexAppServerRuntime({
    vaultRoot: VAULT_ROOT,
    pluginVersion: "0.5.0",
    cliPath: CLI_PATH,
    defaultModel: "gpt-5.6-terra",
    defaultReasoningEffort: "xhigh",
    spawnProcess: (binary, args, options) => {
      spawnCalls.push({ binary, args, options });
      fakeProcess = new ScriptedAppServerProcess(createHappyHandler());
      return fakeProcess;
    },
    requestTimeoutMs: 200,
  });
  const events = [];
  const result = await runtime.runTurn({
    baseInstructions: "只能只读解释。",
    prompt: "请解释这个分段。",
    skillInputs: [{
      type: "skill",
      name: "translate-lacan-seminars",
      path: `${VAULT_ROOT}/.agents/skills/translate-lacan-seminars/SKILL.md`,
    }],
    onEvent: (event) => events.push(event),
  });

  assert.deepStrictEqual(result, {
    threadId: "thread-1",
    turnId: "turn-1",
    text: "第一段第二段",
    status: "completed",
  });
  assert.deepStrictEqual(
    events.filter((event) => event.type === "delta").map((event) => event.delta),
    ["第一段", "第二段"]
  );

  assert.strictEqual(spawnCalls.length, 1);
  assert.strictEqual(spawnCalls[0].binary, CLI_PATH);
  assert.strictEqual(spawnCalls[0].options.cwd, VAULT_ROOT);
  assert.strictEqual(
    spawnCalls[0].options.env.PATH.split(path.delimiter)[0],
    path.dirname(CLI_PATH)
  );
  for (const feature of ["apps", "plugins", "multi_agent", "standalone_web_search"]) {
    const featureIndex = spawnCalls[0].args.indexOf(feature);
    assert.ok(featureIndex > 0);
    assert.strictEqual(spawnCalls[0].args[featureIndex - 1], "--disable");
  }
  assert.ok(spawnCalls[0].args.includes('web_search="live"'));

  const threadStart = fakeProcess.messages.find((message) => message.method === "thread/start");
  assert.strictEqual(threadStart.params.cwd, VAULT_ROOT);
  assert.deepStrictEqual(threadStart.params.runtimeWorkspaceRoots, [VAULT_ROOT]);
  assert.strictEqual(threadStart.params.approvalPolicy, "never");
  assert.strictEqual(threadStart.params.sandbox, "read-only");
  assert.deepStrictEqual(threadStart.params.dynamicTools, []);
  assert.deepStrictEqual(threadStart.params.environments, []);
  assert.deepStrictEqual(threadStart.params.selectedCapabilityRoots, []);
  assert.strictEqual(threadStart.params.ephemeral, undefined, "normal interpretation threads remain persistent");
  const temporaryRuntime = new CodexAppServerRuntime({ vaultRoot: VAULT_ROOT, ephemeralThreads: true });
  let temporaryParams;
  temporaryRuntime.client = { request: async (_method, params) => {
    temporaryParams = params;
    return threadResponse("temporary-lookup");
  } };
  await temporaryRuntime.startThread({ baseInstructions: "Translate selection only.", researchEnabled: false });
  assert.strictEqual(temporaryParams.ephemeral, true, "selection translations must not fill the user's saved chat history");
  assert.strictEqual(temporaryParams.config.web_search, "disabled");
  assert.strictEqual(threadStart.params.model, "gpt-5.6-terra");
  assert.strictEqual(
    threadStart.params.config.mcp_servers["global-server"].enabled,
    false
  );
  assert.strictEqual(threadStart.params.config.apps._default.enabled, false);
  assert.strictEqual(threadStart.params.config.web_search, "live");
  assert.strictEqual(
    fakeProcess.messages.filter(
      (message) => message.method === "config/read"
    ).length,
    2,
    "startup and thread preparation should refresh names through config/read"
  );
  assert.strictEqual(
    fakeProcess.messages.some(
      (message) => message.method === "mcpServerStatus/list"
    ),
    false,
    "an Agent click must not repeat MCP status enumeration"
  );

  const turnStart = fakeProcess.messages.find((message) => message.method === "turn/start");
  assert.deepStrictEqual(turnStart.params.sandboxPolicy, READ_ONLY_SANDBOX_POLICY);
  assert.strictEqual(turnStart.params.approvalPolicy, "never");
  assert.deepStrictEqual(turnStart.params.runtimeWorkspaceRoots, [VAULT_ROOT]);
  assert.deepStrictEqual(turnStart.params.environments, []);
  assert.strictEqual(turnStart.params.model, "gpt-5.6-terra");
  assert.strictEqual(turnStart.params.effort, "xhigh");
  assert.deepStrictEqual(
    turnStart.params.input,
    [{ type: "text", text: "请解释这个分段。" }],
    "legacy profile inputs must not explicitly invoke any skill"
  );

  const diagnostics = runtime.getDiagnostics();
  assert.strictEqual(diagnostics.userAgent, "codex-cli/0.144.5");
  assert.strictEqual(diagnostics.disallowedCapabilitiesIsolated, true);
  assert.strictEqual(diagnostics.webSearchMode, "live");
  assert.ok(
    !Object.prototype.hasOwnProperty.call(
      diagnostics,
      "externalCapabilitiesIsolated"
    ),
    "diagnostics must not claim all external capabilities are isolated when Web Search is enabled"
  );
  assert.ok(!JSON.stringify(diagnostics).includes("reader@example.com"));

  await runtime.shutdown();
  assert.strictEqual(fakeProcess.killed, true);
};

const runQuickTranslation = async () => {
  let fakeProcess;
  const happyHandler = createHappyHandler();
  const runtime = new CodexAppServerRuntime({
    vaultRoot: VAULT_ROOT,
    cliPath: CLI_PATH,
    mcpEnabled: true,
    enabledMcpServerNames: ["global-server"],
    spawnProcess: () => {
      fakeProcess = new ScriptedAppServerProcess((message, process) => {
        if (message.method === "thread/resume") {
          process.respond(message, threadResponse(message.params.threadId));
          return;
        }
        happyHandler(message, process);
      });
      return fakeProcess;
    },
    requestTimeoutMs: 200,
  });
  const request = {
    researchEnabled: false,
    baseInstructions: "仅翻译提供的文本，不检索。",
    prompt: "翻译这一段。",
    skillInputs: [{
      type: "skill",
      name: "translate-lacan-seminars",
      path: `${VAULT_ROOT}/.agents/skills/translate-lacan-seminars/SKILL.md`,
    }],
  };
  const result = await runtime.runTurn(request);
  await runtime.restoreThread({ ...request, threadId: result.threadId });
  const followUp = await runtime.runTurn({ ...request, threadId: result.threadId });
  assert.strictEqual(result.status, "completed");
  assert.strictEqual(followUp.status, "completed");
  const threadRequests = fakeProcess.messages.filter((message) => (
    ["thread/start", "thread/resume"].includes(message.method)
  ));
  assert.strictEqual(threadRequests.length, 3, "quick translation must not start an MCP preflight thread");
  for (const { params } of threadRequests) {
    assert.strictEqual(params.config.web_search, "disabled");
    assert.strictEqual(params.config.features.shell_tool, false);
    assert.strictEqual(params.config.mcp_servers["global-server"].enabled, false);
    assert.strictEqual(params.config.apps._default.enabled, false);
    assert.strictEqual(params.sandbox, "read-only");
  }
  assert.strictEqual(fakeProcess.messages.some((message) => message.method === "mcpServerStatus/list"), false);
  assert.ok(fakeProcess.messages.some((message) => message.method === "config/read"), "quick mode must still discover global server names for isolation");
  assert.ok(fakeProcess.messages.some((message) => message.method === "app/list"), "quick mode must retain app isolation verification");
  for (const { params } of fakeProcess.messages.filter((message) => message.method === "turn/start")) {
    assert.deepStrictEqual(params.input, [{ type: "text", text: request.prompt }], "quick translation must not explicitly invoke Skills");
  }
  const defaultConfig = runtime.restrictedThreadConfig();
  assert.strictEqual(defaultConfig.web_search, "live");
  assert.strictEqual(defaultConfig.mcp_servers["global-server"].enabled, false, "MCP must remain disabled in every mode, including legacy enabled settings");
  assert.strictEqual(defaultConfig.features.shell_tool, undefined);
  await runtime.shutdown();
};

const runOriginalSkillRead = async () => {
  let fakeProcess;
  const happyHandler = createHappyHandler();
  const runtime = new CodexAppServerRuntime({
    vaultRoot: VAULT_ROOT,
    cliPath: CLI_PATH,
    mcpEnabled: true,
    enabledMcpServerNames: ["global-server"],
    spawnProcess: () => {
      fakeProcess = new ScriptedAppServerProcess((message, process) => {
        if (message.method === "thread/resume") {
          process.respond(message, threadResponse(message.params.threadId));
          return;
        }
        happyHandler(message, process);
      });
      return fakeProcess;
    },
    requestTimeoutMs: 200,
  });
  const request = {
    researchEnabled: false,
    allowSkillRead: true,
    baseInstructions: "原文翻译，只读，按需读取已发现的 Skill 定义。",
    prompt: "翻译这一段。",
  };
  const initial = await runtime.runTurn(request);
  await runtime.restoreThread({ ...request, threadId: initial.threadId });
  await runtime.runTurn({ ...request, threadId: initial.threadId });
  const threadRequests = fakeProcess.messages.filter((message) => (
    ["thread/start", "thread/resume"].includes(message.method)
  ));
  assert.strictEqual(threadRequests.length, 3);
  for (const { params } of threadRequests) {
    assert.strictEqual(params.config.features.shell_tool, undefined,
      "original conversations must allow read-only Skill instruction loading");
    assert.strictEqual(params.config.web_search, "disabled");
    assert.strictEqual(params.config.mcp_servers["global-server"].enabled, false);
    assert.strictEqual(params.sandbox, "read-only");
    assert.strictEqual(params.approvalPolicy, "never");
    assert.deepStrictEqual(params.runtimeWorkspaceRoots, [VAULT_ROOT]);
  }
  for (const { params } of fakeProcess.messages.filter((message) => message.method === "turn/start")) {
    assert.deepStrictEqual(params.input, [{ type: "text", text: request.prompt }]);
    assert.deepStrictEqual(params.sandboxPolicy, READ_ONLY_SANDBOX_POLICY);
  }
  assert.strictEqual(fakeProcess.messages.some((message) => message.method === "mcpServerStatus/list"), false);
  assert.strictEqual(runtime.restrictedThreadConfig({ researchEnabled: false }).features.shell_tool, false,
    "allowSkillRead must not change quick selection translations");
  await runtime.shutdown();
};

const runItemCompletedFallback = async () => {
  const runtime = new CodexAppServerRuntime({
    vaultRoot: VAULT_ROOT,
    cliPath: CLI_PATH,
    spawnProcess: () => new ScriptedAppServerProcess((message, process) => {
      if (!Object.prototype.hasOwnProperty.call(message, "id")) {
        return;
      }
      switch (message.method) {
        case "initialize":
          process.respond(message, initializeResponse);
          break;
        case "account/read":
          process.respond(message, accountResponse);
          break;
        case "mcpServerStatus/list":
          process.respond(
            message,
            message.params.threadId ? isolatedMcpInventory : globalMcpInventory
          );
          break;
        case "thread/start":
          process.respond(message, threadResponse("thread-item-completed"));
          break;
        case "app/list":
          process.respond(message, { data: [], nextCursor: null });
          break;
        case "turn/start":
          process.respond(message, {
            turn: turn("turn-item-completed", "inProgress"),
          });
          setImmediate(() => {
            process.notify("item/completed", {
              completedAtMs: 1,
              threadId: "thread-item-completed",
              turnId: "turn-item-completed",
              item: {
                id: "item-final",
                type: "agentMessage",
                text: "只在完成事件中出现的回答。",
                phase: "final_answer",
                memoryCitation: null,
              },
            });
            process.notify("turn/completed", {
              threadId: "thread-item-completed",
              turn: turn("turn-item-completed", "completed"),
            });
          });
          break;
        default:
          process.fail(message, -32601, `Unsupported test method: ${message.method}`);
      }
    }),
    requestTimeoutMs: 200,
  });

  const events = [];
  const result = await runtime.runTurn({
    baseInstructions: "只能只读解释。",
    prompt: "请解释这个分段。",
    onEvent: (event) => events.push(event),
  });
  assert.strictEqual(result.text, "只在完成事件中出现的回答。");
  assert.strictEqual(events.at(-2).type, "delta");
  assert.strictEqual(events.at(-2).text, result.text);
  await runtime.shutdown();
};

const runEmptyCompletedFailure = async () => {
  const runtime = new CodexAppServerRuntime({
    vaultRoot: VAULT_ROOT,
    cliPath: CLI_PATH,
    spawnProcess: () => new ScriptedAppServerProcess((message, process) => {
      if (!Object.prototype.hasOwnProperty.call(message, "id")) {
        return;
      }
      switch (message.method) {
        case "initialize":
          process.respond(message, initializeResponse);
          break;
        case "account/read":
          process.respond(message, accountResponse);
          break;
        case "mcpServerStatus/list":
          process.respond(
            message,
            message.params.threadId ? isolatedMcpInventory : globalMcpInventory
          );
          break;
        case "thread/start":
          process.respond(message, threadResponse("thread-empty"));
          break;
        case "app/list":
          process.respond(message, { data: [], nextCursor: null });
          break;
        case "turn/start":
          process.respond(message, { turn: turn("turn-empty", "inProgress") });
          setImmediate(() => {
            process.notify("turn/completed", {
              threadId: "thread-empty",
              turn: turn("turn-empty", "completed"),
            });
          });
          break;
        default:
          process.fail(message, -32601, `Unsupported test method: ${message.method}`);
      }
    }),
    requestTimeoutMs: 200,
  });

  await assert.rejects(
    runtime.runTurn({
      baseInstructions: "只能只读解释。",
      prompt: "请解释这个分段。",
    }),
    (error) => error.code === "EmptyAgentResponse"
  );
  await runtime.shutdown();
};

const runAppIsolationFailure = async () => {
  let fakeProcess;
  const runtime = new CodexAppServerRuntime({
    vaultRoot: VAULT_ROOT,
    cliPath: CLI_PATH,
    spawnProcess: () => {
      fakeProcess = new ScriptedAppServerProcess((message, process) => {
        if (!Object.prototype.hasOwnProperty.call(message, "id")) {
          return;
        }
        switch (message.method) {
          case "initialize":
            process.respond(message, initializeResponse);
            break;
          case "account/read":
            process.respond(message, accountResponse);
            break;
          case "thread/start":
            process.respond(message, threadResponse("thread-app-unsafe"));
            break;
          case "app/list":
            process.respond(message, {
              data: [{
                id: "unsafe-app",
                name: "Unsafe App",
                isAccessible: true,
                isEnabled: true,
                pluginDisplayNames: [],
              }],
              nextCursor: null,
            });
            break;
          default:
            process.fail(message, -32601, "Not expected");
        }
      });
      return fakeProcess;
    },
    requestTimeoutMs: 200,
  });
  await assert.rejects(
    runtime.runTurn({
      baseInstructions: "只读。",
      prompt: "解释。",
    }),
    (error) => error.code === "ExternalToolsAvailable"
  );
  assert.strictEqual(
    fakeProcess.messages.some((message) => message.method === "turn/start"),
    false
  );
  await runtime.shutdown();
};

const runRestore = async () => {
  let fakeProcess;
  const restoredThreadResponse = threadResponse("thread-old");
  restoredThreadResponse.thread.turns = [{
    id: "turn-old",
    items: [{
      id: "item-old",
      type: "agentMessage",
      text: "已恢复的解读。",
      phase: "final_answer",
      memoryCitation: null,
    }],
    status: "completed",
    error: null,
  }];
  const runtime = new CodexAppServerRuntime({
    vaultRoot: VAULT_ROOT,
    cliPath: CLI_PATH,
    spawnProcess: () => {
      fakeProcess = new ScriptedAppServerProcess((message, process) => {
        if (!Object.prototype.hasOwnProperty.call(message, "id")) {
          return;
        }
        switch (message.method) {
          case "initialize":
            process.respond(message, initializeResponse);
            break;
          case "account/read":
            process.respond(message, accountResponse);
            break;
          case "mcpServerStatus/list":
            process.respond(message, isolatedMcpInventory);
            break;
          case "thread/resume":
            process.respond(message, restoredThreadResponse);
            break;
          case "app/list":
            process.respond(message, { data: [], nextCursor: null });
            break;
          default:
            process.fail(message, -32601, "Not expected");
        }
      });
      return fakeProcess;
    },
    requestTimeoutMs: 200,
  });
  const restored = await runtime.restoreThread({
    threadId: "thread-old",
    baseInstructions: "仍然只读。",
  });
  assert.strictEqual(restored.threadId, "thread-old");
  assert.strictEqual(restored.text, "已恢复的解读。");
  assert.strictEqual(restored.status, "completed");
  const resumeMessage = fakeProcess.messages.find(
    (message) => message.method === "thread/resume"
  );
  assert.strictEqual(resumeMessage.params.approvalPolicy, "never");
  assert.strictEqual(resumeMessage.params.sandbox, "read-only");
  assert.deepStrictEqual(resumeMessage.params.runtimeWorkspaceRoots, [VAULT_ROOT]);
  assert.strictEqual(
    fakeProcess.messages.some((message) => message.method === "turn/start"),
    false
  );
  await runtime.shutdown();
};

const runModelDiscovery = async () => {
  let fakeProcess;
  const runtime = new CodexAppServerRuntime({
    vaultRoot: VAULT_ROOT,
    cliPath: CLI_PATH,
    spawnProcess: () => {
      fakeProcess = new ScriptedAppServerProcess((message, process) => {
        if (!Object.prototype.hasOwnProperty.call(message, "id")) {
          return;
        }
        switch (message.method) {
          case "initialize":
            process.respond(message, initializeResponse);
            break;
          case "account/read":
            process.respond(message, accountResponse);
            break;
          case "mcpServerStatus/list":
            process.respond(message, isolatedMcpInventory);
            break;
          case "model/list":
            if (message.params.cursor === "page-2") {
              process.respond(message, {
                data: [{
                  model: "gpt-5.6-terra",
                  displayName: "GPT-5.6-Terra",
                  description: "Balanced model.",
                  hidden: false,
                  isDefault: false,
                  supportedReasoningEfforts: [{
                    reasoningEffort: "medium",
                    description: "Balanced reasoning.",
                  }],
                  defaultReasoningEffort: "medium",
                }],
                nextCursor: null,
              });
            } else {
              process.respond(message, {
                data: [
                  {
                    id: "gpt-5.6-sol",
                    displayName: "GPT-5.6-Sol",
                    description: "Frontier model.",
                    hidden: false,
                    isDefault: true,
                    supportedReasoningEfforts: [{
                      reasoningEffort: "high",
                      description: "More reasoning.",
                    }],
                    defaultReasoningEffort: "high",
                  },
                  {
                    model: "hidden-model",
                    displayName: "Hidden",
                    hidden: true,
                  },
                ],
                nextCursor: "page-2",
              });
            }
            break;
          default:
            process.fail(message, -32601, "Not expected");
        }
      });
      return fakeProcess;
    },
    requestTimeoutMs: 200,
  });

  const models = await runtime.listModels();
  assert.deepStrictEqual(models, [
    {
      model: "gpt-5.6-sol",
      displayName: "GPT-5.6-Sol",
      description: "Frontier model.",
      isDefault: true,
      supportedReasoningEfforts: [{
        value: "high",
        description: "More reasoning.",
      }],
      defaultReasoningEffort: "high",
    },
    {
      model: "gpt-5.6-terra",
      displayName: "GPT-5.6-Terra",
      description: "Balanced model.",
      isDefault: false,
      supportedReasoningEfforts: [{
        value: "medium",
        description: "Balanced reasoning.",
      }],
      defaultReasoningEffort: "medium",
    },
  ]);
  const reasoningCatalog = normalizeCodexModelCatalog([
    {
      model: "gpt-default",
      isDefault: true,
      defaultReasoningEffort: "medium",
      supportedReasoningEfforts: [
        { reasoningEffort: "low", description: "Fast." },
        { reasoningEffort: "medium", description: "Balanced." },
      ],
    },
    {
      model: "gpt-deep",
      isDefault: false,
      defaultReasoningEffort: "high",
      supportedReasoningEfforts: [
        { reasoningEffort: "high", description: "Deep." },
        { reasoningEffort: "xhigh", description: "Deeper." },
        { reasoningEffort: "max", description: "Maximum." },
      ],
    },
  ]);
  assert.deepStrictEqual(
    resolveCodexReasoningProfile(reasoningCatalog, ""),
    {
      model: "gpt-default",
      defaultReasoningEffort: "medium",
      supportedReasoningEfforts: [
        { value: "low", description: "Fast." },
        { value: "medium", description: "Balanced." },
      ],
    }
  );
  assert.deepStrictEqual(
    resolveCodexReasoningProfile(reasoningCatalog, "gpt-deep"),
    {
      model: "gpt-deep",
      defaultReasoningEffort: "high",
      supportedReasoningEfforts: [
        { value: "high", description: "Deep." },
        { value: "xhigh", description: "Deeper." },
        { value: "max", description: "Maximum." },
      ],
    }
  );
  assert.strictEqual(
    coerceCodexReasoningEffort(reasoningCatalog, "gpt-deep", "xhigh"),
    "xhigh"
  );
  assert.strictEqual(
    coerceCodexReasoningEffort(reasoningCatalog, "gpt-deep", "medium"),
    "",
    "model changes should clear an unsupported reasoning effort"
  );
  assert.strictEqual(
    coerceCodexReasoningEffort(reasoningCatalog, "unknown-model", "high"),
    "high",
    "a saved effort should be retained until an unknown model can be refreshed"
  );
  const requests = fakeProcess.messages.filter(
    (message) => message.method === "model/list"
  );
  assert.strictEqual(requests.length, 2);
  assert.deepStrictEqual(requests[0].params, {
    includeHidden: false,
    limit: 100,
  });
  assert.deepStrictEqual(requests[1].params, {
    cursor: "page-2",
    includeHidden: false,
    limit: 100,
  });
  await runtime.shutdown();
};

const runSkillDiscovery = async () => {
  let fakeProcess;
  let spawnOptions;
  const runtime = new CodexAppServerRuntime({
    vaultRoot: VAULT_ROOT,
    cliPath: CLI_PATH,
    environment: {
      PATH: "/agent/bin",
      HOME: "/Users/configured-agent",
      CODEX_HOME: "/Users/configured-agent/.codex-custom",
    },
    spawnProcess: (_binary, _args, options) => {
      spawnOptions = options;
      fakeProcess = new ScriptedAppServerProcess((message, process) => {
        if (!Object.prototype.hasOwnProperty.call(message, "id")) {
          return;
        }
        switch (message.method) {
          case "initialize":
            process.respond(message, initializeResponse);
            break;
          case "account/read":
            process.respond(message, accountResponse);
            break;
          case "mcpServerStatus/list":
            process.respond(message, isolatedMcpInventory);
            break;
          case "skills/list":
            process.respond(message, {
              data: [{
                cwd: VAULT_ROOT,
                skills: [{
                  name: "translate-lacan-seminars",
                  description: "Close reading.",
                  path: `${VAULT_ROOT}/.agents/skills/translate-lacan-seminars/SKILL.md`,
                  scope: "repo",
                  enabled: true,
                }],
                errors: [],
              }, {
                cwd: "/Users/another/project",
                skills: [{
                  name: "foreign-project-skill",
                  description: "Must not leak into this project.",
                  path: "/Users/another/project/.agents/skills/foreign/SKILL.md",
                  scope: "repo",
                  enabled: true,
                }],
              }],
            });
            break;
          default:
            process.fail(message, -32601, "Not expected");
        }
      });
      return fakeProcess;
    },
    requestTimeoutMs: 200,
  });
  const skills = await runtime.listSkills({ forceReload: true });
  assert.strictEqual(spawnOptions.cwd, VAULT_ROOT);
  assert.strictEqual(spawnOptions.env.HOME, "/Users/configured-agent");
  assert.strictEqual(spawnOptions.env.CODEX_HOME, "/Users/configured-agent/.codex-custom");
  assert.deepStrictEqual(skills, [{
    name: "translate-lacan-seminars",
    description: "Close reading.",
    path: `${VAULT_ROOT}/.agents/skills/translate-lacan-seminars/SKILL.md`,
    scope: "repo",
    enabled: true,
  }]);
  const request = fakeProcess.messages.find(
    (message) => message.method === "skills/list"
  );
  assert.deepStrictEqual(request.params, {
    cwds: [VAULT_ROOT],
    forceReload: true,
  });
  await runtime.shutdown();
};

const runSkillDiscoveryRecovery = async () => {
  let fakeProcess;
  let attempts = 0;
  const runtime = new CodexAppServerRuntime({
    vaultRoot: VAULT_ROOT,
    cliPath: CLI_PATH,
    spawnProcess: () => {
      const happyHandler = createHappyHandler();
      fakeProcess = new ScriptedAppServerProcess((message, process) => {
        if (message.method === "skills/list") {
          attempts += 1;
          if (attempts === 1) {
            // A silent server must time out rather than leave discovery pending.
            return;
          }
          if (attempts === 2) {
            process.respond(message, { data: [{ cwd: "/foreign-project", skills: [] }] });
            return;
          }
          process.respond(message, { data: [{ cwd: VAULT_ROOT, skills: [] }] });
          return;
        }
        happyHandler(message, process);
      });
      return fakeProcess;
    },
    requestTimeoutMs: 20,
  });
  await assert.rejects(runtime.listSkills(), (error) => error.code === "SkillDiscoveryFailed");
  await assert.rejects(runtime.listSkills(), (error) => error.code === "AppServerIncompatible");
  assert.deepStrictEqual(await runtime.listSkills({ forceReload: true }), []);
  assert.strictEqual(fakeProcess.messages.filter((message) => message.method === "skills/list").length, 3);
  await runtime.shutdown();
};

const runConcurrentStartupBarrier = async () => {
  let releaseAccountRead;
  const accountReadRequested = new Promise((resolve) => {
    releaseAccountRead = resolve;
  });
  let pendingAccountRequest;
  const runtime = new CodexAppServerRuntime({
    vaultRoot: VAULT_ROOT,
    cliPath: CLI_PATH,
    spawnProcess: () => new ScriptedAppServerProcess((message, process) => {
      if (!Object.prototype.hasOwnProperty.call(message, "id")) {
        return;
      }
      switch (message.method) {
        case "initialize":
          process.respond(message, initializeResponse);
          break;
        case "account/read":
          pendingAccountRequest = { message, process };
          releaseAccountRead();
          break;
        case "mcpServerStatus/list":
          process.respond(message, globalMcpInventory);
          break;
        default:
          process.fail(message, -32601, "Not expected");
      }
    }),
    requestTimeoutMs: 200,
  });
  const firstStartup = runtime.ensureServer();
  await accountReadRequested;
  let secondResolved = false;
  const secondStartup = runtime.ensureServer().then(() => {
    secondResolved = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.strictEqual(
    secondResolved,
    false,
    "all callers must wait for authentication and external capability isolation, not merely for stdio creation"
  );
  pendingAccountRequest.process.respond(
    pendingAccountRequest.message,
    accountResponse
  );
  await Promise.all([firstStartup, secondStartup]);
  await runtime.shutdown();
};

const runConcurrentTurns = async () => {
  let fakeProcess;
  let threadNumber = 0;
  let threadInventoryChecks = 0;
  let pendingThreadStarts = 0;
  const runtime = new CodexAppServerRuntime({
    vaultRoot: VAULT_ROOT,
    cliPath: CLI_PATH,
    spawnProcess: () => {
      fakeProcess = new ScriptedAppServerProcess((message, process) => {
        if (!Object.prototype.hasOwnProperty.call(message, "id")) {
          return;
        }
        switch (message.method) {
          case "initialize":
            process.respond(message, initializeResponse);
            break;
          case "account/read":
            process.respond(message, accountResponse);
            break;
          case "mcpServerStatus/list":
            if (!message.params.threadId) {
              process.respond(message, globalMcpInventory);
              break;
            }
            threadInventoryChecks += 1;
            setImmediate(() => {
              process.respond(
                message,
                threadInventoryChecks > 1
                  || pendingThreadStarts > 0
                  ? globalMcpInventory
                  : isolatedMcpInventory
              );
              threadInventoryChecks -= 1;
            });
            break;
          case "thread/start": {
            threadNumber += 1;
            const currentThreadNumber = threadNumber;
            pendingThreadStarts += 1;
            const respondToThreadStart = () => {
              pendingThreadStarts -= 1;
              process.respond(
                message,
                threadResponse(`thread-concurrent-${currentThreadNumber}`)
              );
            };
            if (currentThreadNumber === 1) {
              setImmediate(respondToThreadStart);
            } else {
              setTimeout(respondToThreadStart, 10);
            }
            break;
          }
          case "app/list":
            process.respond(message, { data: [], nextCursor: null });
            break;
          case "turn/start": {
            const suffix = message.params.threadId.endsWith("-1") ? "1" : "2";
            process.respond(message, {
              turn: turn(`turn-concurrent-${suffix}`, "inProgress"),
            });
            if (suffix === "1") {
              setImmediate(() => {
                process.notify("item/agentMessage/delta", {
                  delta: "回答一",
                  itemId: "item-1",
                  threadId: "thread-concurrent-1",
                  turnId: "turn-concurrent-1",
                });
                process.notify("turn/completed", {
                  threadId: "thread-concurrent-1",
                  turn: turn("turn-concurrent-1", "completed"),
                });
              });
            } else {
              setImmediate(() => {
                process.notify("item/agentMessage/delta", {
                  delta: "回答二",
                  itemId: "item-2",
                  threadId: "thread-concurrent-2",
                  turnId: "turn-concurrent-2",
                });
                process.notify("turn/completed", {
                  threadId: "thread-concurrent-2",
                  turn: turn("turn-concurrent-2", "completed"),
                });
              });
            }
            break;
          }
          case "turn/interrupt":
            process.respond(message, {});
            break;
          default:
            process.fail(message, -32601, "Not expected");
        }
      });
      return fakeProcess;
    },
    requestTimeoutMs: 200,
    turnTimeoutMs: 200,
  });

  const settled = await Promise.allSettled([
    runtime.runTurn({
      baseInstructions: "只读。",
      prompt: "解释第一段。",
    }),
    runtime.runTurn({
      baseInstructions: "只读。",
      prompt: "解释第二段。",
    }),
  ]);
  assert.deepStrictEqual(
    settled.map((result) => result.status),
    ["fulfilled", "fulfilled"],
    "one App Server process should route simultaneous turns independently"
  );
  assert.deepStrictEqual(
    settled.map((result) => result.value.text).sort(),
    ["回答一", "回答二"]
  );
  assert.strictEqual(runtime.getDiagnostics().activeTurnCount, 0);
  await runtime.shutdown();
};

const runAuthFailure = async () => {
  let fakeProcess;
  const runtime = new CodexAppServerRuntime({
    vaultRoot: VAULT_ROOT,
    cliPath: CLI_PATH,
    spawnProcess: () => {
      fakeProcess = new ScriptedAppServerProcess((message, process) => {
        if (message.method === "initialize") {
          process.respond(message, initializeResponse);
        } else if (message.method === "account/read") {
          process.respond(message, {
            account: null,
            requiresOpenaiAuth: true,
          });
        }
      });
      return fakeProcess;
    },
    requestTimeoutMs: 200,
  });
  await assert.rejects(
    runtime.ensureServer(),
    (error) => error.code === "CodexAuthRequired"
  );
  assert.strictEqual(fakeProcess.killed, true);
};

const runSanitizedTurnFailure = async () => {
  let fakeProcess;
  const runtime = new CodexAppServerRuntime({
    vaultRoot: VAULT_ROOT,
    cliPath: CLI_PATH,
    spawnProcess: () => {
      fakeProcess = new ScriptedAppServerProcess((message, process) => {
        if (!Object.prototype.hasOwnProperty.call(message, "id")) {
          return;
        }
        switch (message.method) {
          case "initialize":
            process.respond(message, initializeResponse);
            break;
          case "account/read":
            process.respond(message, accountResponse);
            break;
          case "mcpServerStatus/list":
            process.respond(message, isolatedMcpInventory);
            break;
          case "thread/start":
            process.respond(message, threadResponse("thread-failure"));
            break;
          case "app/list":
            process.respond(message, { data: [], nextCursor: null });
            break;
          case "turn/start":
            process.fail(message, -32000, "SECRET translated paragraph");
            break;
          default:
            process.fail(message, -32601, "Not expected");
        }
      });
      return fakeProcess;
    },
    requestTimeoutMs: 200,
  });
  await assert.rejects(
    runtime.runTurn({
      baseInstructions: "只读。",
      prompt: "解释。",
    }),
    (error) => (
      error.code === "TurnFailed"
      && !error.message.includes("SECRET")
    )
  );
  await runtime.shutdown();
};

const runInterrupt = async () => {
  let fakeProcess;
  let runtimeStartedResolve;
  const runtimeStarted = new Promise((resolve) => {
    runtimeStartedResolve = resolve;
  });
  const runtime = new CodexAppServerRuntime({
    vaultRoot: VAULT_ROOT,
    cliPath: CLI_PATH,
    spawnProcess: () => {
      fakeProcess = new ScriptedAppServerProcess((message, process) => {
        if (!Object.prototype.hasOwnProperty.call(message, "id")) {
          return;
        }
        switch (message.method) {
          case "initialize":
            process.respond(message, initializeResponse);
            break;
          case "account/read":
            process.respond(message, accountResponse);
            break;
          case "mcpServerStatus/list":
            process.respond(message, isolatedMcpInventory);
            break;
          case "thread/start":
            process.respond(message, threadResponse("thread-stop"));
            break;
          case "app/list":
            process.respond(message, { data: [], nextCursor: null });
            break;
          case "turn/start":
            process.respond(message, { turn: turn("turn-stop", "inProgress") });
            break;
          case "turn/interrupt":
            process.respond(message, {});
            setImmediate(() => {
              process.notify("turn/completed", {
                threadId: "thread-stop",
                turn: turn("turn-stop", "interrupted"),
              });
            });
            break;
          default:
            process.fail(message, -32601, "Not expected");
        }
      });
      return fakeProcess;
    },
    requestTimeoutMs: 200,
  });

  const resultPromise = runtime.runTurn({
    baseInstructions: "只读。",
    prompt: "解释。",
    onEvent: (event) => {
      if (event.type === "started") {
        runtimeStartedResolve();
      }
    },
  });
  await runtimeStarted;
  await runtime.interrupt();
  const result = await resultPromise;
  assert.strictEqual(result.status, "interrupted");
  const interruptMessage = fakeProcess.messages.find(
    (message) => message.method === "turn/interrupt"
  );
  assert.deepStrictEqual(interruptMessage.params, {
    threadId: "thread-stop",
    turnId: "turn-stop",
  });
  await runtime.shutdown();
};

const runShutdownActive = async () => {
  let fakeProcess;
  let runtimeStartedResolve;
  const runtimeStarted = new Promise((resolve) => {
    runtimeStartedResolve = resolve;
  });
  const runtime = new CodexAppServerRuntime({
    vaultRoot: VAULT_ROOT,
    cliPath: CLI_PATH,
    spawnProcess: () => {
      fakeProcess = new ScriptedAppServerProcess((message, process) => {
        if (!Object.prototype.hasOwnProperty.call(message, "id")) {
          return;
        }
        switch (message.method) {
          case "initialize":
            process.respond(message, initializeResponse);
            break;
          case "account/read":
            process.respond(message, accountResponse);
            break;
          case "mcpServerStatus/list":
            process.respond(message, isolatedMcpInventory);
            break;
          case "thread/start":
            process.respond(message, threadResponse("thread-shutdown"));
            break;
          case "app/list":
            process.respond(message, { data: [], nextCursor: null });
            break;
          case "turn/start":
            process.respond(message, { turn: turn("turn-shutdown", "inProgress") });
            break;
          case "turn/interrupt":
            process.respond(message, {});
            break;
          default:
            process.fail(message, -32601, "Not expected");
        }
      });
      return fakeProcess;
    },
    requestTimeoutMs: 200,
    turnTimeoutMs: 100,
  });
  const resultPromise = runtime.runTurn({
    baseInstructions: "只读。",
    prompt: "解释。",
    onEvent: (event) => {
      if (event.type === "started") {
        runtimeStartedResolve();
      }
    },
  });
  await runtimeStarted;
  await runtime.shutdown();
  await assert.rejects(
    resultPromise,
    (error) => error.code === "TurnInterrupted"
  );
  assert.strictEqual(fakeProcess.killed, true);
};

const runTurnTimeout = async (interruptBehavior, { concurrent = false } = {}) => {
  let fakeProcess;
  let threadCount = 0;
  const runningTurnIds = new Set();
  const events = [];
  const runtime = new CodexAppServerRuntime({
    vaultRoot: VAULT_ROOT,
    cliPath: CLI_PATH,
    spawnProcess: () => {
      fakeProcess = new ScriptedAppServerProcess((message, process) => {
        if (!Object.prototype.hasOwnProperty.call(message, "id")) return;
        switch (message.method) {
          case "initialize":
            process.respond(message, initializeResponse);
            break;
          case "account/read":
            process.respond(message, accountResponse);
            break;
          case "thread/start":
            threadCount += 1;
            process.respond(message, threadResponse(`thread-timeout-${threadCount}`));
            break;
          case "app/list":
            process.respond(message, { data: [], nextCursor: null });
            break;
          case "turn/start": {
            const suffix = message.params.threadId.split("-").at(-1);
            const turnId = `turn-timeout-${suffix}`;
            runningTurnIds.add(turnId);
            process.respond(message, { turn: turn(turnId, "inProgress") });
            process.notify("item/agentMessage/delta", {
              delta: `partial ${suffix}`,
              threadId: message.params.threadId,
              turnId,
            });
            break;
          }
          case "turn/interrupt":
            if (interruptBehavior === "refused") {
              process.fail(message, -32000, "Cannot interrupt");
              break;
            }
            if (interruptBehavior === "silent") break;
            process.respond(message, {});
            if (interruptBehavior === "ack-only") break;
            if (concurrent) {
              // The other turn completes normally while the timed-out turn stops.
              runningTurnIds.delete("turn-timeout-2");
              process.notify("turn/completed", {
                threadId: "thread-timeout-2",
                turn: turn("turn-timeout-2", "completed"),
              });
            }
            setImmediate(() => {
              runningTurnIds.delete(message.params.turnId);
              process.notify("turn/completed", {
                threadId: message.params.threadId,
                turn: turn(message.params.turnId, "interrupted"),
              });
            });
            break;
          default:
            process.fail(message, -32601, "Not expected");
        }
      });
      const kill = fakeProcess.kill.bind(fakeProcess);
      fakeProcess.kill = () => {
        runningTurnIds.clear();
        kill();
      };
      return fakeProcess;
    },
    requestTimeoutMs: 30,
    turnTimeoutMs: 20,
  });

  const first = runtime.runTurn({
    prompt: "Time out this turn.",
    onEvent: (event) => events.push(event),
  });
  const promises = [first];
  if (concurrent) promises.push(runtime.runTurn({ prompt: "Keep the other turn running." }));
  const settled = await Promise.allSettled(promises);
  assert.strictEqual(settled[0].status, "rejected");
  assert.strictEqual(settled[0].reason.code, "TurnTimeout");
  const interrupt = fakeProcess.messages.find((message) => message.method === "turn/interrupt");
  assert.ok(interrupt, "a timeout must interrupt the actual Agent turn before ending local tracking");
  assert.deepStrictEqual(interrupt.params, {
    threadId: "thread-timeout-1",
    turnId: "turn-timeout-1",
  });
  assert.strictEqual(runningTurnIds.size, 0, "no Agent turn may remain orphaned after a timeout");
  assert.strictEqual(runtime.getDiagnostics().activeTurnCount, 0);
  assert.strictEqual(events.at(-1).type, "failed");
  assert.strictEqual(events.at(-1).code, "TurnTimeout");
  assert.strictEqual(events.at(-1).text, "partial 1");
  assert.strictEqual(fakeProcess.killed, interruptBehavior !== "completed",
    "close the shared runtime only when cancellation cannot be confirmed");
  if (concurrent && interruptBehavior === "completed") {
    assert.strictEqual(settled[1].status, "fulfilled");
    assert.strictEqual(settled[1].value.text, "partial 2");
    assert.strictEqual(settled[1].value.status, "completed");
  }
  await runtime.shutdown();
};

const run = async () => {
  await runTurnTimeout("completed");
  await runTurnTimeout("completed", { concurrent: true });
  await runTurnTimeout("refused");
  await runTurnTimeout("silent");
  await runTurnTimeout("ack-only");
  await runHappyPath();
  await runQuickTranslation();
  await runOriginalSkillRead();
  await runItemCompletedFallback();
  await runEmptyCompletedFailure();
  await runAppIsolationFailure();
  await runRestore();
  await runModelDiscovery();
  await runSkillDiscovery();
  await runSkillDiscoveryRecovery();
  await runConcurrentStartupBarrier();
  await runConcurrentTurns();
  await runAuthFailure();
  await runSanitizedTurnFailure();
  await runInterrupt();
  await runShutdownActive();
};

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
