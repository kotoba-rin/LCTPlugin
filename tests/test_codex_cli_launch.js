const assert = require('assert');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const { CodexAppServerRuntime } = require('../segment-ai/codex-app-server-runtime');

function processStub() {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => { child.emit('exit', 0); return true; };
  let buffer = '';
  child.stdin.on('data', chunk => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      if (!line) continue;
      const request = JSON.parse(line);
      if (!Object.hasOwn(request, 'id')) continue;
      const result = request.method === 'initialize'
        ? { userAgent: 'codex-cli/test', platformOs: 'windows' }
        : request.method === 'account/read' ? { requiresOpenaiAuth: false }
          : { config: { mcp_servers: {} } };
      child.stdout.write(JSON.stringify({ id: request.id, result }) + '\n');
    }
  });
  return child;
}

(async () => {
  const calls = [];
  const installation = {
    path: '/npm/codex', command: '/node/runtime', args: ['/npm/codex.js'],
    source: 'common', version: '1.2.3', environment: { PATH: '/node:/npm', ELECTRON_RUN_AS_NODE: '1' },
  };
  const runtime = new CodexAppServerRuntime({
    vaultRoot: '/vault',
    discoverCli: async (provider, options) => {
      assert.strictEqual(provider, 'codex');
      assert.strictEqual(options.readVersion, false);
      return installation;
    },
    spawnProcess: (...args) => { calls.push(args); return processStub(); },
  });
  await runtime.ensureServer();
  assert.strictEqual(calls[0][0], installation.command);
  assert.strictEqual(calls[0][1][0], '/npm/codex.js');
  assert(calls[0][1].includes('app-server'));
  assert.strictEqual(calls[0][2].env, installation.environment);
  assert.strictEqual(calls[0][2].windowsHide, true);
  assert.strictEqual(calls[0][2].shell, false, 'CLI launch explicitly bypasses shell command parsing');
  assert.strictEqual(runtime.getDiagnostics().cliPath, '/npm/codex');
  await runtime.shutdown();

  let finishDiscovery;
  const cancelled = new CodexAppServerRuntime({
    vaultRoot: '/vault',
    discoverCli: () => new Promise(resolve => { finishDiscovery = resolve; }),
    spawnProcess: () => assert.fail('cancelled discovery must not spawn an orphan CLI'),
  });
  const startup = cancelled.ensureServer();
  await cancelled.shutdown();
  finishDiscovery(installation);
  await assert.rejects(startup, error => error.code === 'TurnInterrupted');
  console.log('Codex CLI launch tests passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
