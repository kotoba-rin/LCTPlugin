const assert = require("assert");
const { EventEmitter } = require("events");
const { createPluginRequest } = require("../src/plugin-http-request");

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};
const tick = () => new Promise((resolve) => setImmediate(resolve));

const createMock = () => {
  const sessions = [];
  const requests = [];
  let handle = (request) => request.respond(200, { "Content-Type": "application/json" }, ['{"ok":', 'true}']);
  const electron = {
    session: {
      get defaultSession() { assert.fail("plugin proxy must never access the default session"); },
      fromPartition(partition, options) {
        const session = {
          partition, options, proxies: [], closed: 0,
          async setProxy(config) { this.proxies.push(config); await this.pending?.promise; if (this.proxyError) throw this.proxyError; },
          async closeAllConnections() { this.closed += 1; },
        };
        sessions.push(session);
        return session;
      },
    },
    net: {
      request(options) {
        const request = new EventEmitter();
        request.options = options;
        request.writes = [];
        request.aborted = false;
        request.write = (body) => { request.writes.push(body); };
        request.end = () => queueMicrotask(() => handle(request));
        request.abort = () => { request.aborted = true; request.emit("abort"); };
        request.respond = (statusCode, headers, chunks) => {
          const response = new EventEmitter();
          response.statusCode = statusCode;
          response.headers = headers;
          request.response = response;
          request.emit("response", response);
          for (const chunk of chunks) response.emit("data", Buffer.from(chunk));
          response.emit("end");
          request.emit("close");
        };
        requests.push(request);
        return request;
      },
    },
  };
  return { electron, sessions, requests, setHandler: (value) => { handle = value; } };
};

const run = async () => {
  const originalEnvironment = { ...process.env };
  let settings = { pluginHttpProxyEnabled: false, pluginHttpProxyUrl: "invalid" };
  const delegated = [];
  const directResult = { status: 201 };
  const mock = createMock();
  let electronCalls = 0;
  const request = createPluginRequest({
    requestUrl: (input) => { delegated.push(input); return Promise.resolve(directResult); },
    getSettings: () => settings,
    getElectron: () => { electronCalls += 1; return mock.electron; },
  });
  const directOptions = { url: "https://example.org/direct", headers: { Authorization: "Bearer test" }, throw: false };
  assert.strictEqual(await request(directOptions), directResult);
  assert.strictEqual(delegated[0], directOptions, "disabled proxy delegates the exact original options");
  await request("https://example.org/string");
  assert.strictEqual(delegated[1], "https://example.org/string");
  assert.strictEqual(electronCalls, 0, "disabled mode must never load Electron or validate a stale proxy value");

  settings = { pluginHttpProxyEnabled: true, pluginHttpProxyUrl: " http://127.0.0.1:7890 " };
  const result = await request({
    url: "https://example.org/lookup", method: "POST", contentType: "application/json",
    headers: { Authorization: "Bearer test" }, body: '{"word":"être"}',
  });
  assert.strictEqual(result.status, 200);
  assert.strictEqual(result.headers["content-type"], "application/json");
  assert.deepStrictEqual(result.json, { ok: true });
  assert.strictEqual(result.json, result.json, "JSON response is parsed once on demand");
  assert.strictEqual(result.text, '{"ok":true}');
  assert.strictEqual(Buffer.from(result.arrayBuffer).toString(), result.text);
  assert.strictEqual(mock.sessions.length, 1);
  assert.ok(mock.sessions[0].partition.length > 0 && !mock.sessions[0].partition.startsWith("persist:"));
  assert.deepStrictEqual(mock.sessions[0].options, { cache: false });
  assert.deepStrictEqual(mock.sessions[0].proxies, [{ mode: "fixed_servers", proxyRules: "http://127.0.0.1:7890", proxyBypassRules: "<-loopback>" }]);
  assert.strictEqual(mock.requests[0].options.session, mock.sessions[0]);
  assert.strictEqual(mock.requests[0].options.redirect, "follow");
  assert.strictEqual(mock.requests[0].options.useSessionCookies, false);
  assert.strictEqual(mock.requests[0].options.headers["Content-Type"], "application/json");
  assert.deepStrictEqual(mock.requests[0].writes, ['{"word":"être"}']);

  mock.setHandler((native) => native.respond(200, { "Set-Cookie": ["a=1", "b=2"] }, [Buffer.from([0, 255, 1])]));
  const backing = Uint8Array.from([99, 5, 6, 99]);
  const binary = await request({ url: "http://example.org/upload", body: backing.subarray(1, 3), contentType: "unused", headers: { "content-type": "application/octet-stream" } });
  assert.deepStrictEqual([...new Uint8Array(binary.arrayBuffer)], [0, 255, 1]);
  assert.strictEqual(binary.headers["set-cookie"], "a=1, b=2");
  assert.throws(() => binary.json, SyntaxError, "binary content must not be eagerly parsed as JSON");
  assert.deepStrictEqual([...mock.requests[1].writes[0]], [5, 6]);
  assert.deepStrictEqual(mock.requests[1].options.headers, { "content-type": "application/octet-stream" });
  assert.strictEqual(mock.sessions.length, 1, "unchanged proxy reuses its configured session");

  settings.pluginHttpProxyUrl = "https://proxy.example:443";
  await request("http://example.org");
  assert.strictEqual(mock.sessions.length, 2);
  assert.notStrictEqual(mock.sessions[0].partition, mock.sessions[1].partition);
  assert.strictEqual(mock.sessions[1].proxies[0].proxyRules, "https://proxy.example:443");
  assert.strictEqual(mock.sessions[0].proxies.length, 1, "config changes never mutate the session of an earlier request");
  settings.pluginHttpProxyUrl = "http://127.0.0.1:7890";
  await request("https://example.org");
  assert.strictEqual(mock.requests.at(-1).options.session, mock.sessions[0]);

  const count = mock.requests.length;
  for (const invalid of ["", "proxy:7890", "socks5://127.0.0.1:7890", "http://user:secret@host:7890", "http://host:7890/a", "http://host:7890/a/..", "http://host:7890/?token=secret", "http://host:7890/?", "http://host:7890/#secret", "http://host:7890/#", "http://host:99999", "http://host:abc"]) {
    settings.pluginHttpProxyUrl = invalid;
    await assert.rejects(() => request("https://example.org"), /代理/);
  }
  assert.strictEqual(mock.requests.length, count, "invalid proxy settings must not fall back to a direct request");
  assert.strictEqual(delegated.length, 2);
  settings.pluginHttpProxyUrl = "http://proxy.example";
  mock.setHandler((native) => native.respond(503, {}, ["unavailable"]));
  await assert.rejects(() => request("https://example.org"), { status: 503 });
  const failedHttp = await request({ url: "https://example.org", throw: false });
  assert.strictEqual(failedHttp.status, 503);
  assert.strictEqual(failedHttp.text, "unavailable");
  assert.strictEqual(mock.sessions.at(-1).proxies[0].proxyRules, "http://proxy.example:80");
  mock.setHandler((native) => native.emit("error", new Error("proxy unreachable")));
  await assert.rejects(() => request("https://example.org"), /proxy unreachable/);
  assert.strictEqual(mock.requests.at(-1).aborted, true);
  mock.setHandler((native) => {
    const response = new EventEmitter();
    native.emit("response", response);
    response.emit("error", new Error("response interrupted"));
  });
  await assert.rejects(() => request("https://example.org"), /response interrupted/);
  mock.setHandler((native) => {
    native.emit("close");
    queueMicrotask(() => native.respond(200, {}, ["bridge response"]));
  });
  assert.strictEqual((await request("https://example.org")).text, "bridge response", "Electron remote can deliver request close before response callbacks");
  mock.setHandler((native) => native.emit("login", { isProxy: true }, () => {}));
  await assert.rejects(() => request("https://example.org"), /认证/);

  const raceMock = createMock();
  const originalFromPartition = raceMock.electron.session.fromPartition;
  const firstProxyReady = deferred();
  raceMock.electron.session.fromPartition = (...args) => {
    const session = originalFromPartition(...args);
    if (raceMock.sessions.length === 1) session.pending = firstProxyReady;
    return session;
  };
  let raceSettings = { pluginHttpProxyEnabled: true, pluginHttpProxyUrl: "http://first.example:7890" };
  const racing = createPluginRequest({ requestUrl: () => assert.fail("no direct fallback"), getSettings: () => raceSettings, getElectron: () => raceMock.electron });
  const first = racing("https://example.org/first");
  await tick();
  raceSettings = { pluginHttpProxyEnabled: true, pluginHttpProxyUrl: "http://second.example:7890" };
  await racing("https://example.org/second");
  firstProxyReady.resolve();
  await first;
  assert.strictEqual(raceMock.requests[0].options.session.proxies[0].proxyRules, "http://second.example:7890");
  assert.strictEqual(raceMock.requests[1].options.session.proxies[0].proxyRules, "http://first.example:7890");

  const errorMock = createMock();
  errorMock.electron.net.request = () => { throw new Error("synchronous request failure"); };
  const errorRequest = createPluginRequest({ requestUrl: () => assert.fail("no direct fallback"), getSettings: () => raceSettings, getElectron: () => errorMock.electron });
  await assert.rejects(() => errorRequest("https://example.org"), /synchronous request failure/);
  errorMock.electron.session.fromPartition = () => { throw new Error("session failure"); };
  raceSettings.pluginHttpProxyUrl = "http://third.example:7890";
  await assert.rejects(() => errorRequest("https://example.org"), /session failure/);

  const setupMock = createMock();
  let rejectProxy = true;
  const setupSession = setupMock.electron.session.fromPartition;
  setupMock.electron.session.fromPartition = (...args) => {
    const session = setupSession(...args);
    if (rejectProxy) session.proxyError = new Error("proxy setup failed");
    return session;
  };
  const setupRequest = createPluginRequest({ requestUrl: () => assert.fail("no direct fallback"), getSettings: () => raceSettings, getElectron: () => setupMock.electron });
  await assert.rejects(() => setupRequest("https://example.org"), /proxy setup failed/);
  assert.strictEqual(setupMock.requests.length, 0);
  rejectProxy = false;
  await setupRequest("https://example.org");
  assert.strictEqual(setupMock.sessions.length, 2, "failed session setup must be retryable");

  const slowSetup = deferred();
  const slowMock = createMock();
  const slowSession = slowMock.electron.session.fromPartition;
  slowMock.electron.session.fromPartition = (...args) => {
    const session = slowSession(...args);
    session.pending = slowSetup;
    return session;
  };
  const slowRequest = createPluginRequest({ requestUrl: () => assert.fail("no direct fallback"), getSettings: () => raceSettings, getElectron: () => slowMock.electron, requestTimeoutMs: 10 });
  await assert.rejects(() => slowRequest("https://example.org"), /超时/);
  slowSetup.resolve();
  await tick();
  assert.strictEqual(slowMock.requests.length, 0, "timed-out session initialization must not later issue the request");

  const timeoutMock = createMock();
  timeoutMock.setHandler((native) => native.emit("close"));
  const timeoutRequest = createPluginRequest({ requestUrl: () => assert.fail("no direct fallback"), getSettings: () => raceSettings, getElectron: () => timeoutMock.electron, requestTimeoutMs: 10 });
  await assert.rejects(() => timeoutRequest("https://example.org"), /超时/);
  assert.strictEqual(timeoutMock.requests[0].aborted, true);
  const hanging = timeoutRequest("https://example.org");
  await tick();
  const cancelled = assert.rejects(() => hanging, /取消/);
  await timeoutRequest.dispose();
  await cancelled;
  assert.ok(timeoutMock.sessions.every((session) => session.closed > 0));
  await assert.rejects(() => timeoutRequest("https://example.org"), /已关闭/);
  await request.dispose();
  await racing.dispose();
  await errorRequest.dispose();
  await setupRequest.dispose();
  await slowRequest.dispose();
  assert.ok(Object.keys(process.env).length === Object.keys(originalEnvironment).length
    && Object.entries(originalEnvironment).every(([key, value]) => process.env[key] === value), "proxy settings never mutate the process environment");
  console.log("Plugin HTTP proxy request tests passed");
};

run().catch((error) => { console.error(error); process.exitCode = 1; });
