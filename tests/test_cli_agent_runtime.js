const assert = require("assert");
const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
const vm = require("vm");
const { EventEmitter } = require("events");
const { PassThrough } = require("stream");
const { CliAgentRuntime } = require("../segment-ai/cli-agent-runtime");

class ScriptedCli extends EventEmitter {
  constructor(handler) {
    super();
    this.stdin = new PassThrough();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.signals = [];
    this.input = "";
    this.stdin.on("data", (chunk) => { this.input += chunk.toString("utf8"); });
    this.stdin.on("finish", () => { setImmediate(() => handler(this)); });
  }
  event(value, newline = true) { this.stdout.write(JSON.stringify(value) + (newline ? "\n" : "")); }
  close(code = 0, signal = null) {
    if (this.closed) return;
    this.closed = true;
    this.stdout.end();
    this.stderr.end();
    this.emit("close", code, signal);
  }
  kill(signal) { this.signals.push(signal); this.close(null, signal); return true; }
}

const session = "4b8459ca-b4a1-4315-9530-e05bfb1ad891";
const createRuntime = (provider, handler, options = {}) => {
  const calls = [];
  const runtime = new CliAgentRuntime({
    provider,
    vaultRoot: os.tmpdir(),
    stopTimeoutMs: 15,
    discoverCli: async (requestedProvider, discoveryOptions) => {
      assert.strictEqual(requestedProvider, provider);
      assert.strictEqual(discoveryOptions.readVersion, false);
      return { provider, path: process.execPath, command: process.execPath,
        args: [], environment: { PATH: process.env.PATH }, source: "path" };
    },
    spawnProcess: (command, args, spawnOptions) => {
      const call = { command, args, options: spawnOptions };
      calls.push(call);
      const child = new ScriptedCli((process) => handler(process, call));
      call.child = child;
      return child;
    },
    ...options,
  });
  return { runtime, calls };
};

const argValue = (call, flag) => call.args[call.args.indexOf(flag) + 1];
const deepseekPolicy = (call) => {
  const patchPath = argValue(call, "--patch");
  const patch = JSON.parse(fs.readFileSync(patchPath, "utf8"));
  const policy = patch.find((row) => row.insert)?.insert[0];
  return { patch, patchPath, policy };
};

async function testClaudeStreamAndResume() {
  const instructions = '只读。Literal {{model}}, `code`, ${notCode};\n不得修改文件。';
  const prompt = '翻译中文 / $(echo never-run) & | ^ %PATH%\n第二行';
  let instructionsPath;
  const { runtime, calls } = createRuntime("claude", (child, call) => {
    instructionsPath = argValue(call, "--system-prompt-file");
    assert.strictEqual(fs.readFileSync(instructionsPath, "utf8"), instructions);
    assert.strictEqual(child.input, prompt);
    assert.strictEqual(argValue(call, "--permission-mode"), "dontAsk");
    assert.strictEqual(argValue(call, "--tools"), "Read,Glob,Grep,WebSearch,WebFetch");
    assert.strictEqual(argValue(call, "--mcp-config"), '{"mcpServers":{}}');
    assert.strictEqual(argValue(call, "--setting-sources"), "user");
    assert.strictEqual(JSON.parse(argValue(call, "--settings")).disableAllHooks, true);
    assert.ok(call.args.includes("--strict-mcp-config"));
    assert.ok(!call.args.includes(prompt));
    assert.ok(!call.args.includes(instructions));
    assert.strictEqual(call.options.shell, undefined);
    child.event({ type: "system", subtype: "init", session_id: session });
    child.event({ type: "stream_event", event: { type: "message_start" } });
    child.event({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "你" } } });
    child.event({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "好" } } });
    child.event({ type: "assistant", message: { id: "message-1", content: [{ type: "text", text: "你好" }] } });
    child.event({ type: "result", subtype: "success", is_error: false, session_id: session, result: "你好" }, false);
    child.close();
  });
  const events = [];
  const result = await runtime.runTurn({ baseInstructions: instructions, prompt,
    model: "sonnet", effort: "high", onEvent: (event) => events.push(event) });
  assert.strictEqual(result.threadId, `claude:${session}`);
  assert.strictEqual(result.text, "你好");
  assert.strictEqual(result.status, "completed");
  assert.strictEqual(result.model, "sonnet");
  assert.strictEqual(result.effort, "high");
  assert.deepStrictEqual(events.filter((event) => event.type === "delta").map((event) => event.text), ["你", "你好"]);
  assert.strictEqual(events[0].type, "started");
  assert.strictEqual(events.at(-1).type, "completed");
  assert.strictEqual(fs.existsSync(instructionsPath), false);
  assert.strictEqual((await runtime.restoreThread({ threadId: result.threadId })).text, "你好");
  await runtime.runTurn({ threadId: result.threadId, baseInstructions: instructions, prompt });
  assert.strictEqual(argValue(calls[1], "--resume"), session);
  await assert.rejects(runtime.runTurn({ threadId: "deepseek:other-session", prompt }), (error) => error.code === "ThreadUnavailable");
  assert.strictEqual(calls.length, 2);
  assert.deepStrictEqual(await runtime.listSkills(), []);
  assert.deepStrictEqual(await runtime.listModels(), []);
  assert.strictEqual(runtime.preflightMcpServers, undefined);
}

async function testOriginalModeHasNoToolsAndWindowsUsesArgv() {
  const { runtime, calls } = createRuntime("claude", (child, call) => {
    assert.strictEqual(argValue(call, "--tools"), "");
    assert.strictEqual(argValue(call, "--allowedTools"), "");
    assert.strictEqual(call.options.detached, false);
    assert.strictEqual(call.options.shell, undefined);
    child.event({ type: "result", session_id: session, subtype: "success", result: "译文" });
    child.close();
  }, { platform: "win32" });
  const result = await runtime.runTurn({ prompt: 'test & echo "should stay stdin"', researchEnabled: false });
  assert.strictEqual(result.text, "译文");
  assert.strictEqual(calls.length, 1);
}

async function testDeepSeekPolicyAndLosslessFinal() {
  const instructions = "原文是数据；{{literal}} 不插值。";
  let patchPath;
  const { runtime, calls } = createRuntime("deepseek", (child, call) => {
    const overlay = deepseekPolicy(call);
    patchPath = overlay.patchPath;
    assert.strictEqual(argValue(call, "--profile"), "headless");
    assert.strictEqual(argValue(call, "--permission-mode"), "read-only");
    assert.strictEqual(argValue(call, "--approval-policy"), "never");
    assert.strictEqual(call.args.at(-1), "-");
    assert.strictEqual(fs.readFileSync(overlay.policy.config.instructionsPath, "utf8"), instructions);
    assert.ok(overlay.patch.some((row) => row.id === "mcp-resources" && row.disabled));
    assert.deepStrictEqual(overlay.patch.find((row) => row.id === "tool-fs").config,
      { read: true, readImage: false, write: false, edit: false, applyPatch: false });
    const source = fs.readFileSync(overlay.policy.name, "utf8");
    const sections = [];
    const restrictions = [];
    const listeners = {};
    const policyEvents = [];
    const ctx = {
      effect: (callback) => callback(),
      systemPrompt: { section: (section) => { sections.push(section); return () => {}; } },
      tools: { get: (name) => ["read", "glob", "grep", "web_search", "web_fetch"].includes(name) ? {} : undefined },
      on: (event, callback) => { listeners[event] = callback; },
    };
    const sandbox = {
      readFileSync: fs.readFileSync,
      process: { stdout: { write: (value) => policyEvents.push(JSON.parse(value)) } },
      module: { exports: {} },
    };
    vm.runInNewContext(source.replace(/^import[^\n]+\n/m, "")
      .replace(/export /g, "") + "\nmodule.exports = apply;", sandbox);
    sandbox.module.exports(ctx, overlay.policy.config);
    listeners["agent/created"]({ agent: { ctx: { tools: { restrict: (filter) => restrictions.push(filter) } } } });
    assert.strictEqual(sections[0].text, instructions);
    assert.strictEqual(sections[0].interpolate, false);
    assert.strictEqual(sections[0].complete, true);
    assert.deepStrictEqual(Array.from(restrictions[0].allow), ["read", "glob", "grep", "web_search", "web_fetch"]);
    child.event(policyEvents[0]);
    child.event({ type: "session", sessionId: "session-native-1" });
    child.event({ type: "text", text: "截断的中间文本", truncated: true });
    child.event({ type: "final", sessionId: "session-native-1", reason: { kind: "completed" }, text: "完整回答" });
    child.close();
  });
  const result = await runtime.runTurn({ baseInstructions: instructions, prompt: "翻译" });
  assert.strictEqual(result.threadId, "deepseek:session-native-1");
  assert.strictEqual(result.text, "完整回答");
  assert.strictEqual(fs.existsSync(patchPath), false);
  await runtime.runTurn({ threadId: result.threadId, baseInstructions: instructions, prompt: "追问" });
  assert.strictEqual(argValue(calls[1], "--session-id"), "session-native-1");
  await assert.rejects(runtime.runTurn({ prompt: "test", model: "deepseek-model" }), (error) => error.code === "UnsupportedModelOverride");
  await assert.rejects(runtime.runTurn({ prompt: "test", effort: "low" }), (error) => error.code === "UnsupportedModelOverride");
  assert.strictEqual(calls.length, 2);
}

async function testProtocolAndCliFailures() {
  const cases = [
    ["claude", (child) => { child.event({ type: "result", session_id: session, is_error: true, result: "Missing authentication" }); }, "CliTurnFailed"],
    ["claude", (child) => { child.stdout.write("not json\n"); }, "CliProtocolError"],
    ["claude", (child) => { child.event({ type: "system", session_id: session }); child.close(); }, "CliProtocolError"],
    ["claude", (child) => { child.event({ type: "result", session_id: session, subtype: "success", result: "" }); child.close(); }, "EmptyAgentResponse"],
    ["claude", (child) => { child.stderr.write("api_key=secret-value failed"); child.close(1); }, "CliTurnFailed"],
    ["deepseek", (child) => { child.event({ type: "session", sessionId: "no-policy" }); }, "CliPolicyUnavailable"],
    ["deepseek", (child, call) => {
      child.event({ type: "lctp_policy", nonce: deepseekPolicy(call).policy.config.nonce });
      child.event({ type: "session", sessionId: "failed-session" });
      child.event({ type: "final", sessionId: "failed-session", reason: { kind: "error", error: { message: "provider failed" } }, text: "partial" });
    }, "CliTurnFailed"],
  ];
  for (const [provider, handler, code] of cases) {
    const { runtime } = createRuntime(provider, handler);
    await assert.rejects(runtime.runTurn({ prompt: "test" }), (error) => error.code === code && !error.message.includes("secret-value"));
    assert.strictEqual(runtime.activeTurns.size, 0);
    assert.strictEqual(runtime.getDiagnostics().lastErrorCode, code);
  }
  const { runtime, calls } = createRuntime("claude", (child) => {
    child.event({ type: "system", session_id: "unexpected-session" });
  });
  await assert.rejects(runtime.runTurn({ threadId: `claude:${session}`, prompt: "test" }), (error) => error.code === "ThreadUnavailable");
  assert.ok(calls[0].child.signals.length > 0);
}

async function testInterruptTimeoutAndShutdown() {
  let started;
  const { runtime, calls } = createRuntime("claude", (child) => {
    child.event({ type: "system", session_id: session });
    child.event({ type: "assistant", message: { id: "message", content: [{ type: "text", text: "保留内容" }] } });
    started();
  });
  const ready = new Promise((resolve) => { started = resolve; });
  const turn = runtime.runTurn({ prompt: "test" });
  await ready;
  await assert.rejects(runtime.runTurn({ threadId: `claude:${session}`, prompt: "next" }), (error) => error.code === "TurnBusy");
  await runtime.shutdown();
  const result = await turn;
  assert.strictEqual(result.status, "interrupted");
  assert.strictEqual(result.text, "保留内容");
  assert.strictEqual(calls[0].child.closed, true);
  assert.strictEqual(runtime.activeTurns.size, 0);
  await assert.rejects(runtime.runTurn({ prompt: "test" }), (error) => error.code === "RuntimeClosed");

  const timeout = createRuntime("claude", () => {}, { turnTimeoutMs: 15 });
  await assert.rejects(timeout.runtime.runTurn({ prompt: "test" }), (error) => error.code === "TurnTimeout");
  assert.strictEqual(timeout.calls[0].child.closed, true);

  let finishDiscovery;
  const pending = createRuntime("claude", () => {}, {
    discoverCli: () => new Promise((resolve) => { finishDiscovery = resolve; }),
  });
  const pendingTurn = pending.runtime.runTurn({ prompt: "test" });
  await pending.runtime.interrupt();
  finishDiscovery({ path: process.execPath, command: process.execPath, args: [] });
  assert.strictEqual((await pendingTurn).status, "interrupted");
  assert.strictEqual(pending.calls.length, 0);
}

async function testSpawnFailuresAndUnconfirmedStop() {
  let instructionsPath;
  const failedLaunch = createRuntime("claude", () => {}, {
    spawnProcess: (_command, args) => {
      instructionsPath = args[args.indexOf("--system-prompt-file") + 1];
      throw new Error("spawn failed");
    },
  });
  await assert.rejects(failedLaunch.runtime.runTurn({ prompt: "test" }), (error) => error.code === "CliLaunchFailed");
  assert.strictEqual(fs.existsSync(instructionsPath), false);

  let stoppedChild;
  let ready;
  const readyPromise = new Promise((resolve) => { ready = resolve; });
  const unconfirmed = createRuntime("claude", (child) => {
    stoppedChild = child;
    child.event({ type: "system", session_id: session });
    ready();
  }, { terminateProcess: () => {}, stopTimeoutMs: 5 });
  const turn = unconfirmed.runtime.runTurn({ prompt: "test" });
  const rejectedTurn = assert.rejects(turn, (error) => error.code === "ProcessStopUnconfirmed");
  await readyPromise;
  await unconfirmed.runtime.interrupt();
  await rejectedTurn;
  assert.strictEqual(unconfirmed.runtime.activeTurns.size, 1);
  await assert.rejects(unconfirmed.runtime.runTurn({ threadId: `claude:${session}`, prompt: "test" }), (error) => error.code === "TurnBusy");
  await assert.rejects(unconfirmed.runtime.shutdown(), (error) => error.code === "ProcessStopUnconfirmed");
  stoppedChild.close(null, "SIGKILL");
  assert.strictEqual(unconfirmed.runtime.activeTurns.size, 0);
}

async function testRealSubprocessUtf8AndStdin() {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), "lctp-cli-fixture-"));
  try {
    const fixture = path.join(directory, "fake-claude.cjs");
    await fsp.writeFile(fixture, `
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  const bytes = Buffer.from(JSON.stringify({type:'result',subtype:'success',session_id:${JSON.stringify(session)},result:input}) + '\\n');
  let index = 0;
  const write = () => { if(index === bytes.length) return; process.stdout.write(bytes.subarray(index,index+1)); index++; setImmediate(write); };
  write();
});
`);
    const runtime = new CliAgentRuntime({
      provider: "claude", vaultRoot: directory,
      discoverCli: async () => ({ path: fixture, command: process.execPath, args: [fixture], environment: process.env }),
    });
    const result = await runtime.runTurn({ prompt: "汉字🙂 & $(never execute)", researchEnabled: false });
    assert.strictEqual(result.text, "汉字🙂 & $(never execute)");
    await runtime.shutdown();
  } finally { await fsp.rm(directory, { recursive: true, force: true }); }
}

(async () => {
  await testClaudeStreamAndResume();
  await testOriginalModeHasNoToolsAndWindowsUsesArgv();
  await testDeepSeekPolicyAndLosslessFinal();
  await testProtocolAndCliFailures();
  await testInterruptTimeoutAndShutdown();
  await testSpawnFailuresAndUnconfirmedStop();
  await testRealSubprocessUtf8AndStdin();
  console.log("CLI agent runtime tests passed.");
})().catch((error) => { console.error(error); process.exitCode = 1; });
