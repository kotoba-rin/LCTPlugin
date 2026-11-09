const assert = require("assert");
const { buildDisabledMcpServerConfig, normalizeServerNames } = require("../segment-ai/mcp-capability-registry");

assert.deepStrictEqual(buildDisabledMcpServerConfig(["server-b", "server-a", "server-a", ""]), {
  "server-a": { enabled: false }, "server-b": { enabled: false },
});
assert.deepStrictEqual(normalizeServerNames([" server-with-spaces ", "server", " ", null]), [
  " server-with-spaces ", "server",
]);
assert.deepStrictEqual(buildDisabledMcpServerConfig([" server-with-spaces "]), {
  " server-with-spaces ": { enabled: false },
}, "native configuration names must be disabled without changing their bytes");
const unusual = buildDisabledMcpServerConfig(["__proto__", "constructor", "a.b"]);
assert.strictEqual(Object.getPrototypeOf(unusual), Object.prototype);
for (const name of ["__proto__", "constructor", "a.b"]) {
  assert.strictEqual(Object.hasOwn(unusual, name), true);
  assert.deepStrictEqual(unusual[name], { enabled: false });
}
assert.deepStrictEqual(buildDisabledMcpServerConfig(null), {});
assert.strictEqual(require("../segment-ai/mcp-capability-registry").McpCapabilityRegistry, undefined);
console.log("External capability disabling helper tests passed.");
