const assert = require("assert");
const { EventEmitter } = require("events");
const { PassThrough } = require("stream");
const { CodexAppServerRuntime } = require("../segment-ai/codex-app-server-runtime");

const VAULT_ROOT = process.cwd();
const configuredServers = { "formerly-allowed": { enabled: true }, "blocked": { enabled: true } };

class ScriptedAppServer extends EventEmitter {
  constructor(handler) {
    super();
    this.stdin = new PassThrough();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.messages = [];
    let buffer = "";
    this.stdin.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let newline;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        const message = JSON.parse(line);
        this.messages.push(message);
        if (Object.hasOwn(message, "id")) handler(message, this);
      }
    });
  }
  respond(request, result) { this.stdout.write(JSON.stringify({ id: request.id, result }) + "\n"); }
  notify(method, params) { this.stdout.write(JSON.stringify({ method, params }) + "\n"); }
  kill() { this.emit("exit", 0, null); }
}

const threadResponse = (id) => ({
  approvalPolicy: "never", cwd: VAULT_ROOT, runtimeWorkspaceRoots: [],
  sandbox: { type: "readOnly", networkAccess: false },
  thread: { id, turns: [] },
});

function createRuntime({ legacy = {}, notifyStartup = false } = {}) {
  let child;
  let configReads = 0;
  let turnNumber = 0;
  const runtime = new CodexAppServerRuntime({
    vaultRoot: VAULT_ROOT, cliPath: process.execPath, requestTimeoutMs: 200,
    ...legacy,
    spawnProcess: () => {
      child = new ScriptedAppServer((request, process) => {
        switch (request.method) {
          case "initialize": process.respond(request, { userAgent: "codex-cli/test", platformOs: "macos" }); break;
          case "account/read": process.respond(request, { requiresOpenaiAuth: false }); break;
          case "config/read": {
            configReads += 1;
            const servers = { ...configuredServers, ...(configReads > 2 ? { "newly-configured": { enabled: true } } : {}) };
            process.respond(request, { config: { mcp_servers: servers } }); break;
          }
          case "thread/start":
          case "thread/resume": {
            const threadId = request.params.threadId || "test-thread";
            if (notifyStartup) process.notify("mcpServer/startupStatus/updated", {
              threadId, name: "unknown-new-server", status: "starting",
            });
            process.respond(request, threadResponse(threadId)); break;
          }
          case "app/list": process.respond(request, { data: [], nextCursor: null }); break;
          case "turn/start": {
            const id = `turn-${++turnNumber}`;
            process.respond(request, { turn: { id, status: "inProgress" } });
            setImmediate(() => {
              process.notify("item/agentMessage/delta", { threadId: request.params.threadId, turnId: id, delta: "answer" });
              process.notify("turn/completed", { threadId: request.params.threadId, turn: { id, status: "completed" } });
            }); break;
          }
          default: throw new Error(`Unexpected RPC: ${request.method}`);
        }
      });
      return child;
    },
  });
  return { runtime, get child() { return child; } };
}

async function testLegacyOptionsCannotEnableMcp() {
  const maliciousRegistry = new Proxy({}, { get() { throw new Error("Legacy registry must never be consulted"); } });
  const fixture = createRuntime({ legacy: {
    mcpEnabled: true, enabledMcpServerNames: ["formerly-allowed"], mcpCapabilityRegistry: maliciousRegistry,
  } });
  const { runtime } = fixture;
  assert.strictEqual(runtime.preflightMcpServers, undefined);
  assert.strictEqual(runtime.listMcpInventory, undefined);
  assert.strictEqual(runtime.mcpCapabilityRegistry, undefined);
  await runtime.ensureServer();
  assert.ok(!fixture.child.messages.some((request) => request.method === "thread/start"),
    "startup must never create a server probe thread");
  const result = await runtime.runTurn({ prompt: "read", researchEnabled: true });
  await runtime.restoreThread({ threadId: result.threadId });
  await runtime.runTurn({ threadId: result.threadId, prompt: "follow up", researchEnabled: false });
  const threadRequests = fixture.child.messages.filter((request) => ["thread/start", "thread/resume"].includes(request.method));
  assert.strictEqual(threadRequests.length, 3);
  for (const request of threadRequests) {
    assert.ok(Object.keys(request.params.config.mcp_servers).length >= 2);
    assert.ok(Object.values(request.params.config.mcp_servers).every((server) => server.enabled === false));
  }
  assert.strictEqual(threadRequests.at(-1).params.config.mcp_servers["newly-configured"].enabled, false,
    "a service added after startup must be disabled before the next resume");
  assert.ok(!fixture.child.messages.some((request) => /^mcp|^tools\//i.test(request.method)),
    "isolation reads only configuration names and must not enumerate/connect external servers");
  const diagnostics = runtime.getDiagnostics();
  for (const removed of ["mcpPolicy", "mcpBackgroundCheck", "mcpConfigDiscovery"]) {
    assert.strictEqual(Object.hasOwn(diagnostics, removed), false);
  }
  await runtime.shutdown();
}

async function testStartupViolationsStopBeforeTurn() {
  const fixture = createRuntime({ notifyStartup: true });
  await assert.rejects(fixture.runtime.runTurn({ prompt: "read" }), (error) => error.code === "ExternalToolsAvailable");
  assert.ok(!fixture.child.messages.some((request) => request.method === "turn/start"));
  await assert.rejects(fixture.runtime.runTurn({ prompt: "retry" }), (error) => error.code === "ExternalToolsAvailable");
  await fixture.runtime.shutdown();
}

(async () => {
  await testLegacyOptionsCannotEnableMcp();
  await testStartupViolationsStopBeforeTurn();
  console.log("Runtime external capability isolation tests passed.");
})().catch((error) => { console.error(error); process.exitCode = 1; });
