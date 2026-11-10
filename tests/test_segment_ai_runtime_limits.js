const assert = require("assert");
const { EventEmitter } = require("events");
const { PassThrough } = require("stream");
const { JsonLineRpcClient } = require("../segment-ai/json-line-rpc");
const { CodexAppServerRuntime } = require("../segment-ai/codex-app-server-runtime");

class FakeProcess extends EventEmitter {
  constructor(handler = () => {}) {
    super();
    this.stdin = new PassThrough();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.killed = false;
    this.messages = [];
    let buffer = "";
    this.stdin.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let newline;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const message = JSON.parse(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        this.messages.push(message);
        handler(message, this);
      }
    });
  }
  send(value) { this.stdout.write(`${JSON.stringify(value)}\n`); }
  respond(request, result) { this.send({ id: request.id, result }); }
  notify(method, params) { this.send({ method, params }); }
  kill() { this.killed = true; this.emit("exit", 0, null); }
}

async function testRpcMessageLimits() {
  for (const terminated of [false, true]) {
    const child = new FakeProcess();
    const client = new JsonLineRpcClient(child, { maxMessageBytes: 32, requestTimeoutMs: 20 });
    const pending = client.request("pending");
    const rejected = assert.rejects(pending, (error) => error.code === "AppServerOutputLimit");
    child.stdout.write(`{"data":"${"漢".repeat(9)}${terminated ? '"}\n' : ""}`);
    await rejected;
    assert.strictEqual(child.killed, true);
    assert.strictEqual(client.closed, true);
  }
  const child = new FakeProcess();
  const client = new JsonLineRpcClient(child, { maxMessageBytes: 48 });
  const messages = [];
  client.on("notification", (value) => messages.push(value));
  child.stdout.write(Array.from({ length: 20 }, () => '{"method":"ok"}\n').join(""));
  assert.strictEqual(messages.length, 20, "the limit applies per message, not per stdout chunk");
  client.close();
}

async function testRpcStdinFailureAndStderrDrain() {
  const child = new FakeProcess();
  const client = new JsonLineRpcClient(child);
  const pending = client.request("pending");
  const rejected = assert.rejects(pending, (error) => error.code === "AppServerInputFailed");
  child.stdin.emit("error", Object.assign(new Error("closed pipe"), { code: "EPIPE" }));
  await rejected;
  assert.strictEqual(child.killed, true);
  child.stdin.emit("error", new Error("late write failure"));

  const drainingChild = new FakeProcess();
  const drainingClient = new JsonLineRpcClient(drainingChild);
  drainingChild.stderr.write(Buffer.alloc(128 * 1024));
  assert.strictEqual(drainingChild.stderr.readableLength, 0, "stderr must be drained continuously");
  drainingClient.close();
  assert.strictEqual(drainingChild.stderr.listenerCount("data"), 0);
}

const root = process.cwd();
const threadResponse = {
  thread: { id: "thread-1" }, approvalPolicy: "never", cwd: root,
  runtimeWorkspaceRoots: [root], sandbox: { type: "readOnly", networkAccess: false },
};
const makeRuntime = (turnHandler, options = {}) => {
  let child;
  const runtime = new CodexAppServerRuntime({
    vaultRoot: root, requestTimeoutMs: 20, turnTimeoutMs: 200,
    discoverCli: async () => ({ path: process.execPath, command: process.execPath, args: [], environment: {} }),
    spawnProcess: () => {
      child = new FakeProcess((message, process) => {
        switch (message.method) {
          case "initialize": process.respond(message, { userAgent: "test", platformOs: "test" }); break;
          case "account/read": process.respond(message, { requiresOpenaiAuth: false }); break;
          case "config/read": process.respond(message, { config: { mcp_servers: {} } }); break;
          case "thread/start": process.respond(message, threadResponse); break;
          case "app/list": process.respond(message, { data: [] }); break;
          case "turn/start": turnHandler(message, process); break;
          case "turn/interrupt":
            process.respond(message, {});
            if (!options.ignoreInterrupt) process.notify("turn/completed", {
              threadId: "thread-1", turn: { id: "turn-1", status: "interrupted" },
            });
            break;
        }
      });
      return child;
    },
    ...options,
  });
  return { runtime, child: () => child };
};

async function testTurnOutputLimits() {
  for (const completed of [false, true]) {
    const fixture = makeRuntime((request, child) => {
      child.respond(request, { turn: { id: "turn-1" } });
      setImmediate(() => {
        child.notify("item/agentMessage/delta", { threadId: "thread-1", turnId: "turn-1", delta: "漢" });
        child.notify(completed ? "item/completed" : "item/agentMessage/delta", {
          threadId: "thread-1", turnId: "turn-1",
          ...(completed ? { item: { type: "agentMessage", text: "漢字語" } } : { delta: "字語" }),
        });
      });
    }, { maxTurnOutputBytes: 6 });
    const events = [];
    await assert.rejects(fixture.runtime.runTurn({ prompt: "test", onEvent: (event) => events.push(event) }),
      (error) => error.code === "CliOutputLimit");
    assert.strictEqual(events.at(-1).text, "漢", "retain only the last response within the byte limit");
    assert.ok(fixture.child().messages.some((message) => message.method === "turn/interrupt"));
    assert.strictEqual(fixture.child().killed, false, "a confirmed stop keeps the shared runtime available");
    await fixture.runtime.shutdown();
  }
  const fixture = makeRuntime((request, child) => {
    child.respond(request, { turn: { id: "turn-1" } });
    setImmediate(() => child.notify("item/agentMessage/delta", { threadId: "thread-1", turnId: "turn-1", delta: "漢字語" }));
  }, { maxTurnOutputBytes: 6, ignoreInterrupt: true });
  await assert.rejects(fixture.runtime.runTurn({ prompt: "test" }), (error) => error.code === "CliOutputLimit");
  assert.strictEqual(fixture.child().killed, true, "an unconfirmed stop must close the shared runtime");
}

async function testEarlyEventOrderingAndLifetime() {
  const fixture = makeRuntime((request, child) => {
    child.notify("item/agentMessage/delta", { threadId: "thread-1", turnId: "turn-1", delta: "先" });
    child.notify("turn/completed", { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } });
    child.respond(request, { turn: { id: "turn-1" } });
  });
  assert.strictEqual((await fixture.runtime.runTurn({ prompt: "test" })).text, "先");
  fixture.child().notify("item/agentMessage/delta", { threadId: "thread-1", turnId: "orphan", delta: "late" });
  assert.strictEqual(fixture.runtime.earlyTurnEvents.size, 0, "late events outside a pending turn start must be discarded");
  await fixture.runtime.shutdown();

  const overflowing = makeRuntime((_request, child) => {
    for (let index = 0; index < 3; index += 1) child.notify("item/agentMessage/delta", {
      threadId: "thread-1", turnId: `turn-${index}`, delta: "early",
    });
  }, { maxEarlyTurnEvents: 2 });
  await assert.rejects(overflowing.runtime.runTurn({ prompt: "test" }), (error) => error.code === "EarlyTurnEventLimit");
  assert.strictEqual(overflowing.child().killed, true);
  assert.strictEqual(overflowing.runtime.earlyTurnEvents.size, 0);

  const byteOverflow = makeRuntime((_request, child) => {
    child.notify("item/agentMessage/delta", { threadId: "thread-1", turnId: "turn-1", delta: "漢".repeat(30) });
  }, { maxEarlyTurnEventBytes: 128 });
  await assert.rejects(byteOverflow.runtime.runTurn({ prompt: "test" }), (error) => error.code === "EarlyTurnEventLimit");
  assert.strictEqual(byteOverflow.child().killed, true);

  const exited = makeRuntime((_request, child) => {
    child.notify("item/agentMessage/delta", { threadId: "thread-1", turnId: "unknown", delta: "never replayed" });
    child.kill();
  });
  await assert.rejects(exited.runtime.runTurn({ prompt: "test" }));
  assert.strictEqual(exited.runtime.earlyTurnEvents.size, 0, "process exit releases pending early events");

  const failed = makeRuntime((_request, child) => {
    child.notify("item/agentMessage/delta", { threadId: "thread-1", turnId: "unknown", delta: "never replayed" });
  });
  await assert.rejects(failed.runtime.runTurn({ prompt: "test" }));
  assert.strictEqual(failed.runtime.earlyTurnEvents.size, 0, "a failed turn start releases its early events");
  await failed.runtime.shutdown();
}

(async () => {
  await testRpcMessageLimits();
  await testRpcStdinFailureAndStderrDrain();
  await testTurnOutputLimits();
  await testEarlyEventOrderingAndLifetime();
  console.log("Segment AI runtime limits tests passed.");
})().catch((error) => { console.error(error); process.exitCode = 1; });
