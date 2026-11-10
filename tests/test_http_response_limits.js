const assert = require("assert");
const { EventEmitter } = require("events");
const { createPluginRequest } = require("../src/plugin-http-request");
const { createProjectTransport } = require("../src/project-sync-obsidian");

function harness() {
  const requests = [];
  const electron = {
    session: { fromPartition: () => ({ setProxy: async () => {}, closeAllConnections: async () => {} }) },
    net: { request() {
      const native = new EventEmitter();
      native.write = () => {};
      native.end = () => {};
      native.abort = () => { native.aborted = true; native.emit("abort"); };
      native.respond = (headers = {}, chunks = [], end = true) => {
        const response = new EventEmitter();
        Object.assign(response, { statusCode: 200, headers });
        native.response = response;
        native.emit("response", response);
        for (const chunk of chunks) response.emit("data", Buffer.from(chunk));
        if (end) response.emit("end");
      };
      requests.push(native);
      return native;
    } },
  };
  const request = createPluginRequest({
    requestUrl: () => assert.fail("proxy request cannot fall back to the host"),
    getSettings: () => ({ pluginHttpProxyEnabled: true, pluginHttpProxyUrl: "http://localhost:7890" }),
    getElectron: () => electron,
  });
  return { request, requests };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));

async function run() {
  const { request, requests } = harness();
  try {
    for (const [headers, chunks] of [
      [{}, ["ab", "cd", "e"]],
      [{ "content-length": "2" }, ["abc", "de"]],
      [{ "Content-Length": "99999999999999999999" }, []],
    ]) {
      const pending = request("https://example.org/file", { maxBytes: 4 });
      const rejected = assert.rejects(pending, /超出/);
      await tick();
      const native = requests.at(-1);
      native.respond(headers, chunks);
      await rejected;
      assert.strictEqual(native.aborted, true, "oversized response is aborted at the receiver");
      assert.strictEqual(native.response.listenerCount("data"), 0, "stop retaining chunks after rejection");
    }
    const unicode = request("https://example.org/unicode", { maxBytes: 4 });
    await tick();
    requests.at(-1).respond({}, ["é", "é"]);
    const response = await unicode;
    assert.strictEqual(response.text, "éé");
    assert.strictEqual(typeof Object.getOwnPropertyDescriptor(response, "arrayBuffer").get, "function");
    assert.deepStrictEqual([...new Uint8Array(response.arrayBuffer)], [195, 169, 195, 169]);
    assert.strictEqual(response.arrayBuffer, response.arrayBuffer, "binary conversion is cached");
    const empty = request("https://example.org/empty", { maxBytes: 0 });
    await tick(); requests.at(-1).respond({}, []);
    assert.strictEqual((await empty).arrayBuffer.byteLength, 0);

    const preAborted = new AbortController();
    preAborted.abort();
    const count = requests.length;
    await assert.rejects(request("https://example.org/unused", { signal: preAborted.signal }), { name: "AbortError" });
    assert.strictEqual(requests.length, count);
    for (const maxBytes of [-1, Infinity, NaN, 1.5, 256 * 1024 * 1024 + 1]) {
      await assert.rejects(request("https://example.org/unused", { maxBytes }), /限制无效/);
    }

    const transport = createProjectTransport(request);
    const controller = new AbortController();
    const cancelled = transport("https://example.org/stream", { signal: controller.signal, maxBytes: 3 });
    const cancelCheck = assert.rejects(cancelled, { name: "AbortError" });
    await tick();
    const native = requests.at(-1);
    native.respond({}, ["a"], false);
    controller.abort();
    await cancelCheck;
    assert.strictEqual(native.aborted, true, "sync cancellation reaches the native request");
    const retry = transport("https://example.org/retry", { maxBytes: 3 });
    const retryCheck = assert.rejects(retry, /超出/);
    await tick();
    assert.notStrictEqual(requests.at(-1), native, "cancelled native request releases the shared queue");
    requests.at(-1).respond({}, ["abcd"]);
    await retryCheck;
  } finally { await request.dispose(); }
  console.log("HTTP streaming budgets, cancellation, UTF-8 and lazy response tests passed");
}
run().catch((error) => { console.error(error); process.exitCode = 1; });
