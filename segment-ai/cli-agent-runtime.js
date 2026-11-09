const { spawn } = require("child_process");
const { randomUUID } = require("crypto");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { discoverCli, buildCliInvocation } = require("./cli-discovery");

const PROVIDER_NAMES = { claude: "Claude Code", deepseek: "DeepSeek Harness" };
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

class CliAgentRuntimeError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "CliAgentRuntimeError";
    this.code = code;
    Object.assign(this, details);
  }
}

// This is a native dsh plugin, loaded from a private invocation overlay. Keeping
// instructions in a separate data file preserves literal {{...}} and JS text.
const DEEPSEEK_POLICY_PLUGIN = `
import { readFileSync } from 'node:fs';
export const name = 'lctp-read-only-policy';
export const inject = ['systemPrompt', 'tools'];
export function apply(ctx, config) {
  const instructions = readFileSync(config.instructionsPath, 'utf8');
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'lctp:instructions', order: 0, text: instructions,
    interpolate: false, complete: true,
  }));
  ctx.on('agent/created', ({ agent }) => {
    if (typeof agent.ctx.tools.restrict !== 'function') {
      throw new Error('This dsh version does not support the required read-only tool restriction.');
    }
    const allow = config.allowedTools.filter(name => ctx.tools.get(name) !== undefined);
    agent.ctx.tools.restrict({ allow });
    process.stdout.write(JSON.stringify({ type: 'lctp_policy', nonce: config.nonce }) + '\\n');
  });
}
`;

class CliAgentRuntime {
  constructor({
    provider,
    vaultRoot,
    cliPath = "",
    defaultModel = "",
    defaultReasoningEffort = "",
    environment = process.env,
    platform = process.platform,
    spawnProcess = spawn,
    discoverCli: discover = discoverCli,
    turnTimeoutMs = 10 * 60 * 1000,
    stopTimeoutMs = 1500,
    terminateProcess = terminateProcessTree,
  } = {}) {
    if (!PROVIDER_NAMES[provider] || !path.isAbsolute(String(vaultRoot || ""))) {
      throw new TypeError("CliAgentRuntime requires a supported provider and absolute vaultRoot.");
    }
    this.provider = provider;
    this.vaultRoot = path.resolve(vaultRoot);
    this.configuredCliPath = String(cliPath || "").trim();
    this.defaultModel = String(defaultModel || "").trim();
    this.defaultReasoningEffort = String(defaultReasoningEffort || "").trim();
    this.environment = environment;
    this.platform = platform;
    this.spawnProcess = spawnProcess;
    this.discoverCli = discover;
    this.turnTimeoutMs = turnTimeoutMs;
    this.stopTimeoutMs = stopTimeoutMs;
    this.terminateProcess = terminateProcess;
    this.activeTurns = new Map();
    this.completedThreads = new Map();
    this.closed = false;
    this.diagnostics = {
      provider,
      cliPath: null,
      version: null,
      userAgent: null,
      initialized: false,
      authenticated: false,
      disallowedCapabilitiesIsolated: false,
      modelDiscoverySupported: false,
      skillDiscoverySupported: false,
      lastErrorCode: null,
    };
  }

  async ensureServer() {
    if (this.closed) throw this.error("RuntimeClosed", "本地 Agent 已关闭，请重新启用 AI 功能。");
    const cli = await this.discoverCli(this.provider, {
      configuredPath: this.configuredCliPath,
      environment: this.environment,
      platform: this.platform,
      readVersion: false,
    });
    this.diagnostics.cliPath = cli.path;
    this.diagnostics.version = cli.version || null;
    this.diagnostics.userAgent = `${PROVIDER_NAMES[this.provider]}${cli.version ? ` ${cli.version}` : ""}`;
    this.diagnostics.initialized = true;
    return cli;
  }

  async listModels() {
    await this.ensureServer();
    return [];
  }

  async listSkills() { return []; }

  onSkillsChanged() { return () => {}; }

  async restoreThread({ threadId } = {}) {
    this.nativeSessionId(threadId);
    const cached = this.completedThreads.get(threadId);
    // Headless CLIs expose resume on the next task, but no read-only history RPC.
    // Controllers keep persisted messages; never run a paid task to read history.
    return cached ? { ...cached } : { threadId, text: "", status: "unknown" };
  }

  nativeSessionId(threadId) {
    const value = String(threadId || "");
    const prefix = `${this.provider}:`;
    if (!value.startsWith(prefix) || !value.slice(prefix.length).trim()
      || value.includes("\0") || value.length > 1024) {
      throw this.error("ThreadUnavailable", "这个会话属于其他 CLI，或会话标识无效，请新建解读。");
    }
    return value.slice(prefix.length);
  }

  async runTurn({
    threadId = "", baseInstructions = "", prompt, model, effort,
    researchEnabled = true, allowSkillRead = false, onEvent = () => {},
  } = {}) {
    const task = String(prompt || "");
    if (!task.trim()) throw this.error("EmptyPrompt", "没有可发送的解读请求。");
    const nativeId = threadId ? this.nativeSessionId(threadId) : "";
    if (threadId && [...this.activeTurns.values()].some((turn) => turn.threadId === threadId)) {
      throw this.error("TurnBusy", "这个会话仍在生成，请等待或停止后继续。");
    }
    const selectedModel = String(model || this.defaultModel || "").trim();
    const selectedEffort = String(effort || this.defaultReasoningEffort || "").trim();
    if (this.provider === "deepseek" && (selectedModel || selectedEffort)) {
      throw this.error("UnsupportedModelOverride", "DeepSeek Harness 使用本机 headless profile 的模型与推理设置；请在该 CLI 中配置。");
    }
    const active = {
      turnId: randomUUID(), threadId: String(threadId || ""), nativeId,
      text: "", messages: new Map(), streamText: "", onEvent,
      interrupted: false, failure: null, terminal: false, started: false,
      child: null, closed: false, settled: false,
    };
    active.exited = new Promise((resolve) => { active.resolveExit = resolve; });
    active.finished = new Promise((resolve) => { active.resolveFinished = resolve; });
    this.activeTurns.set(active.turnId, active);
    let artifacts;
    try {
      const cli = await this.ensureServer();
      if (active.interrupted || this.closed) return this.result(active, "interrupted");
      artifacts = await createInvocationArtifacts({
        provider: this.provider,
        baseInstructions: String(baseInstructions || ""),
        researchEnabled,
        allowSkillRead,
      });
      if (active.interrupted || this.closed) return this.result(active, "interrupted");
      const args = this.provider === "claude"
        ? buildClaudeArgs({ nativeId, selectedModel, selectedEffort, artifacts, researchEnabled, allowSkillRead })
        : ["--profile", "headless", "--patch", artifacts.patchPath, "--json",
          "--permission-mode", "read-only", "--approval-policy", "never",
          ...(nativeId ? ["--session-id", nativeId] : []), "-"];
      const invocation = buildCliInvocation(cli, args);
      active.policyNonce = artifacts.nonce;
      const result = await this.execute(active, invocation, cli.environment || this.environment, task);
      if (result.threadId) this.completedThreads.set(result.threadId, result);
      return { ...result, model: selectedModel, effort: selectedEffort };
    } catch (error) {
      this.diagnostics.lastErrorCode = error.code || "CliTurnFailed";
      throw error;
    } finally {
      // Retain an unconfirmed process so a second resume cannot claim its session.
      if (!active.child || active.closed) this.activeTurns.delete(active.turnId);
      if (!active.child || active.closed) active.resolveExit();
      try {
        if (artifacts && (!active.child || active.closed)) await artifacts.dispose();
        else if (artifacts) active.disposeArtifacts = artifacts.dispose;
      } finally { active.resolveFinished(); }
    }
  }

  execute(active, invocation, environment, task) {
    return new Promise((resolve, reject) => {
      let buffer = "";
      let stderr = "";
      const finish = (error, result) => {
        if (active.settled) return;
        active.settled = true;
        clearTimeout(active.timeout);
        clearTimeout(active.killTimeout);
        clearTimeout(active.stopDeadline);
        if (error) reject(error);
        else resolve(result);
      };
      const consume = (line) => {
        if (!line.trim() || active.failure) return;
        let event;
        try { event = JSON.parse(line); }
        catch {
          this.stopWithFailure(active, this.error("CliProtocolError", `${PROVIDER_NAMES[this.provider]} 没有返回有效的 JSON 事件，请检查 CLI 版本。`));
          return;
        }
        try {
          if (this.provider === "claude") this.consumeClaudeEvent(active, event);
          else this.consumeDeepSeekEvent(active, event);
        } catch (error) { this.stopWithFailure(active, error); }
      };
      active.finish = finish;
      try {
        active.child = this.spawnProcess(invocation.command, invocation.args, {
          cwd: this.vaultRoot,
          env: { ...environment },
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
          detached: this.platform !== "win32",
          ...(invocation.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
        });
      } catch (cause) {
        active.closed = true;
        finish(this.error("CliLaunchFailed", `无法启动 ${PROVIDER_NAMES[this.provider]}，请检查 CLI 路径。`, { cause }));
        return;
      }
      active.timeout = setTimeout(() => this.stopWithFailure(active,
        this.error("TurnTimeout", "本地 Agent 响应超时，已请求停止。")), this.turnTimeoutMs);
      active.child.stdout.setEncoding("utf8");
      active.child.stderr.setEncoding("utf8");
      active.child.stdout.on("data", (chunk) => {
        buffer += chunk;
        if (Buffer.byteLength(buffer, "utf8") > MAX_OUTPUT_BYTES) {
          this.stopWithFailure(active, this.error("CliOutputLimit", "CLI 返回的单个事件过大，已停止本次解读。"));
          buffer = "";
          return;
        }
        let newline;
        while ((newline = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          consume(line);
        }
      });
      active.child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-4096); });
      active.child.stdin.on("error", (cause) => {
        if (cause.code !== "EPIPE" && !active.interrupted) this.stopWithFailure(active,
          this.error("CliInputFailed", "无法把请求发送给本地 CLI。", { cause }));
      });
      active.child.on("error", (cause) => {
        active.closed = true;
        active.resolveExit();
        finish(this.error("CliLaunchFailed", `无法启动 ${PROVIDER_NAMES[this.provider]}，请检查路径与本机安装。`, { cause }));
      });
      active.child.on("close", (code, signal) => {
        active.closed = true;
        active.resolveExit();
        clearTimeout(active.killTimeout);
        clearTimeout(active.stopDeadline);
        if (buffer.trim()) consume(buffer);
        this.activeTurns.delete(active.turnId);
        if (active.disposeArtifacts) void active.disposeArtifacts();
        if (active.failure) return finish(active.failure);
        if (active.interrupted) return finish(null, this.result(active, "interrupted"));
        if (code !== 0) return finish(this.error("CliTurnFailed",
          `${PROVIDER_NAMES[this.provider]} 执行失败${signal ? `（${signal}）` : `（退出码 ${code}）`}。${cleanDiagnostic(stderr)}`));
        if (!active.terminal || !active.started) return finish(this.error("CliProtocolError",
          "CLI 已退出，但没有返回完整的会话和完成事件，请检查 CLI 版本。"));
        if (!active.text.trim()) return finish(this.error("EmptyAgentResponse", "本地 Agent 已结束，但没有返回可显示的回答。"));
        this.diagnostics.authenticated = true;
        this.emit(active, { type: "completed", status: "completed" });
        finish(null, this.result(active, "completed"));
      });
      active.child.stdin.end(task, "utf8");
    });
  }

  startSession(active, id) {
    if (typeof id !== "string" || !id.trim() || id.length > 1000 || id.includes("\0")) {
      throw this.error("CliProtocolError", "CLI 未返回有效的会话标识。");
    }
    if (active.nativeId && active.nativeId !== id) {
      throw this.error("ThreadUnavailable", "CLI 恢复了不同的会话，已停止请求；请新建解读。");
    }
    active.nativeId = id;
    active.threadId = `${this.provider}:${id}`;
    if (!active.started) {
      active.started = true;
      this.emit(active, { type: "started" });
    }
  }

  updateText(active, text) {
    if (typeof text !== "string" || text === active.text) return;
    if (Buffer.byteLength(text, "utf8") > MAX_OUTPUT_BYTES) {
      throw this.error("CliOutputLimit", "CLI 回答过大，已停止本次解读。");
    }
    active.text = text;
    if (active.started) this.emit(active, { type: "delta", text });
  }

  consumeClaudeEvent(active, event) {
    if (event.session_id) {
      this.startSession(active, event.session_id);
      this.diagnostics.disallowedCapabilitiesIsolated = true;
    }
    if (event.type === "stream_event") {
      if (event.event?.type === "message_start") active.streamText = "";
      if (event.event?.type === "content_block_delta" && event.event.delta?.type === "text_delta") {
        active.streamText += String(event.event.delta.text || "");
        this.updateText(active, [...active.messages.values(), active.streamText].filter(Boolean).join("\n\n"));
      }
    } else if (event.type === "assistant") {
      const text = extractClaudeText(event.message?.content);
      if (text) {
        active.messages.set(event.message?.id || String(active.messages.size), text);
        active.streamText = "";
        this.updateText(active, [...active.messages.values()].join("\n\n"));
      }
    } else if (event.type === "result") {
      if (event.is_error === true || (event.subtype && event.subtype !== "success")) {
        throw this.error("CliTurnFailed", cleanDiagnostic(event.result || event.errors?.join("\n") || "Claude Code 未能完成回答。"));
      }
      if (typeof event.result === "string") this.updateText(active, event.result);
      active.terminal = true;
    } else if (event.type === "error") {
      throw this.error("CliTurnFailed", cleanDiagnostic(event.message || event.error?.message || "Claude Code 执行失败。"));
    }
  }

  consumeDeepSeekEvent(active, event) {
    if (event.type === "lctp_policy") {
      if (event.nonce === active.policyNonce) {
        active.policyConfirmed = true;
        this.diagnostics.disallowedCapabilitiesIsolated = true;
      }
      return;
    }
    if (event.type === "session") {
      if (!active.policyConfirmed) throw this.error("CliPolicyUnavailable", "DeepSeek Harness 未确认只读工具限制，已停止请求。请检查 CLI 版本。");
      this.startSession(active, event.sessionId);
    } else if (event.type === "text") {
      this.updateText(active, active.text + String(event.text || ""));
    } else if (event.type === "final") {
      this.startSession(active, event.sessionId);
      if (!active.policyConfirmed) throw this.error("CliPolicyUnavailable", "DeepSeek Harness 未确认只读工具限制。");
      if (event.reason?.kind !== "completed") {
        throw this.error("CliTurnFailed", cleanDiagnostic(event.reason?.error?.message || `DeepSeek Harness 未完成回答（${event.reason?.kind || "无完成原因"}）。`));
      }
      this.updateText(active, event.text);
      active.terminal = true;
    } else if (event.type === "error") {
      throw this.error("CliTurnFailed", cleanDiagnostic(event.message || "DeepSeek Harness 执行失败。"));
    }
  }

  emit(active, event) {
    try { active.onEvent({ threadId: active.threadId, turnId: active.turnId, ...event }); }
    catch { this.diagnostics.eventCallbackFailed = true; }
  }

  result(active, status) {
    return { threadId: active.threadId, turnId: active.turnId, text: active.text, status };
  }

  stopWithFailure(active, error) {
    active.failure ||= error;
    this.requestStop(active);
  }

  requestStop(active) {
    if (!active.child || active.closed || active.stopping) return;
    active.stopping = true;
    this.terminateProcess(active.child, "SIGTERM", this.platform);
    if (active.closed) return;
    active.killTimeout = setTimeout(() => {
      this.terminateProcess(active.child, "SIGKILL", this.platform);
    }, this.stopTimeoutMs);
    active.stopDeadline = setTimeout(() => {
      active.finish(this.error("ProcessStopUnconfirmed", "CLI 未确认退出，暂时不能恢复这个会话。请在终端检查该进程。"));
    }, this.stopTimeoutMs * 2);
  }

  async interrupt({ threadId = "", turnId = "" } = {}) {
    const active = [...this.activeTurns.values()].filter((turn) => (
      (!threadId || turn.threadId === threadId) && (!turnId || turn.turnId === turnId)
    ));
    for (const turn of active) {
      turn.interrupted = true;
      this.requestStop(turn);
    }
    return active.length > 0;
  }

  async shutdown() {
    this.closed = true;
    const active = [...this.activeTurns.values()];
    await this.interrupt();
    if (active.length === 0) return;
    let deadline;
    try {
      await Promise.race([
        Promise.all(active.map((turn) => turn.finished)),
        new Promise((_, reject) => {
          deadline = setTimeout(() => reject(this.error("ProcessStopUnconfirmed",
            "CLI 尚未确认退出，请检查本地进程后再切换提供商。")), this.stopTimeoutMs * 2 + 500);
        }),
      ]);
      if (active.some((turn) => turn.child && !turn.closed)) {
        throw this.error("ProcessStopUnconfirmed", "CLI 尚未确认退出，请检查本地进程后再切换提供商。");
      }
    } finally { clearTimeout(deadline); }
  }

  async dispose() { return this.shutdown(); }

  getDiagnostics() {
    return JSON.parse(JSON.stringify({ ...this.diagnostics, activeTurnCount: this.activeTurns.size }));
  }

  error(code, message, details) { return new CliAgentRuntimeError(code, message, details); }
}

function buildClaudeArgs({ nativeId, selectedModel, selectedEffort, artifacts, researchEnabled, allowSkillRead }) {
  const tools = [
    ...(researchEnabled || allowSkillRead ? ["Read", "Glob", "Grep"] : []),
    ...(researchEnabled ? ["WebSearch", "WebFetch"] : []),
  ].join(",");
  return [
    "--print", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
    "--input-format", "text", "--permission-mode", "dontAsk",
    "--tools", tools, "--allowedTools", tools,
    "--disallowedTools", "mcp__*", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
    // Native user settings own API routes and credentials. Exclude project/local
    // settings while overriding hooks and MCP for this read-only invocation.
    "--setting-sources", "user", "--settings", '{"disableAllHooks":true}',
    "--disable-slash-commands", "--no-chrome", "--system-prompt-file", artifacts.instructionsPath,
    ...(nativeId ? ["--resume", nativeId] : []),
    ...(selectedModel ? ["--model", selectedModel] : []),
    ...(selectedEffort ? ["--effort", selectedEffort] : []),
  ];
}

async function createInvocationArtifacts({ provider, baseInstructions, researchEnabled, allowSkillRead }) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "lctp-cli-"));
  const dispose = () => fs.rm(directory, { recursive: true, force: true });
  try {
    await fs.chmod(directory, 0o700);
    const instructionsPath = path.join(directory, "instructions.txt");
    await fs.writeFile(instructionsPath, baseInstructions || "你是只读翻译助手。不得创建、修改或删除文件。", { mode: 0o600 });
    if (provider === "claude") return { instructionsPath, dispose };
    const pluginPath = path.join(directory, "read-only-policy.mjs");
    const patchPath = path.join(directory, "invocation.patch.json");
    const nonce = randomUUID();
    const allowedTools = [
      ...(researchEnabled || allowSkillRead ? ["read", "glob", "grep"] : []),
      ...(researchEnabled ? ["web_search", "web_fetch"] : []),
    ];
    const disabled = [
      "tool-bash", "tool-pwsh", "tool-jobs", "tool-agent-team", "tool-subagent-control",
      "tool-subagent", "tool-subagent-fork", "tool-workflow", "tool-todo", "tool-goal",
      "tool-plugin-manager", "plugin-manager", "skill-filesystem", "tool-skill",
      "agent-instructions", "mcp-resources", "session-title-llm",
      ...(!researchEnabled ? ["tool-web", "web-deepseek-api", "web-search-deepseek", "web-fetch-http"] : []),
    ];
    const patch = [
      ...disabled.map((id) => ({ id, disabled: true })),
      { id: "tool-fs", config: { read: true, readImage: false, write: false, edit: false, applyPatch: false } },
      { insert: [{ id: "lctp-read-only-policy", name: pluginPath,
        config: { instructionsPath, allowedTools, nonce } }] },
    ];
    await fs.writeFile(pluginPath, DEEPSEEK_POLICY_PLUGIN, { mode: 0o600 });
    await fs.writeFile(patchPath, JSON.stringify(patch), { mode: 0o600 });
    return { instructionsPath, patchPath, nonce, dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
}

function extractClaudeText(content) {
  if (typeof content === "string") return content;
  return (Array.isArray(content) ? content : [])
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text).join("");
}

function cleanDiagnostic(value) {
  return String(value || "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/(Bearer\s+)[^\s]+/gi, "$1[redacted]")
    .replace(/((?:api[_-]?key|auth[_-]?token)\s*[=:]\s*)[^\s,;]+/gi, "$1[redacted]")
    .trim().slice(0, 1800);
}

function terminateProcessTree(child, signal, platform) {
  if (platform === "win32" && Number.isInteger(child.pid) && child.pid > 0) {
    try {
      const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", ...(signal === "SIGKILL" ? ["/F"] : [])], {
        stdio: "ignore", windowsHide: true,
      });
      killer.on("error", () => { try { child.kill(signal); } catch {} });
      return;
    } catch {}
  }
  if (platform !== "win32" && Number.isInteger(child.pid) && child.pid > 0) {
    try { process.kill(-child.pid, signal); return; } catch {}
  }
  try { child.kill(signal); } catch {}
}

module.exports = { CliAgentRuntime, CliAgentRuntimeError };
