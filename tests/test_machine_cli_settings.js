const assert = require("assert");
const {
  getMachineCliPath,
  setMachineCliPath,
  migrateMachineCliPaths,
} = require("../segment-ai/machine-cli-settings");

const mac = { platform: "darwin", hostname: "studio", homeDirectory: "/Users/example" };
const otherMac = { ...mac, hostname: "laptop" };
const windows = { platform: "win32", hostname: "desktop", homeDirectory: "C:\\Users\\example" };
const linux = { platform: "linux", hostname: "server", homeDirectory: "/home/example" };

const settings = {
  segmentAiCodexPath: " /opt/homebrew/bin/codex ",
  segmentAiClaudePath: "\"/Users/example/.local/bin/claude\"",
  segmentAiDeepseekPath: "~/.local/bin/dsh",
};
assert.strictEqual(getMachineCliPath(settings, "codex", mac), "/opt/homebrew/bin/codex");
assert.strictEqual(settings.segmentAiCliPathsByMachine, undefined, "a compatibility read must not mutate settings");
assert.strictEqual(migrateMachineCliPaths(settings, mac), settings);
assert.deepStrictEqual(settings.segmentAiCliPathsByMachine, {
  "darwin:studio": {
    codex: "/opt/homebrew/bin/codex",
    claude: "\"/Users/example/.local/bin/claude\"",
    deepseek: "~/.local/bin/dsh",
  },
});
assert.strictEqual(getMachineCliPath(settings, "codex", otherMac), "");
assert.strictEqual(getMachineCliPath(settings, "codex", windows), "");
assert.strictEqual(getMachineCliPath(settings, "codex", linux), "");
migrateMachineCliPaths(settings, otherMac);
assert.strictEqual(getMachineCliPath(settings, "codex", otherMac), "", "a new host must not import another host's legacy field");
assert.strictEqual(getMachineCliPath(settings, "claude", mac), "\"/Users/example/.local/bin/claude\"");

assert.strictEqual(setMachineCliPath(settings, "codex", " C:\\Tools\\codex.cmd ", windows), "C:\\Tools\\codex.cmd");
assert.strictEqual(settings.segmentAiCodexPath, "C:\\Tools\\codex.cmd");
assert.strictEqual(getMachineCliPath(settings, "codex", mac), "/opt/homebrew/bin/codex", "legacy compatibility fields must not override established host settings");
assert.strictEqual(getMachineCliPath(settings, "codex", windows), "C:\\Tools\\codex.cmd");
setMachineCliPath(settings, "codex", "", mac);
assert.strictEqual(getMachineCliPath(settings, "codex", mac), "", "empty means auto-detect, without fallback to legacy paths");
assert.strictEqual(getMachineCliPath(settings, "codex", windows), "C:\\Tools\\codex.cmd");
const reloaded = JSON.parse(JSON.stringify(settings));
assert.strictEqual(getMachineCliPath(reloaded, "codex", mac), "");
assert.strictEqual(getMachineCliPath(reloaded, "codex", windows), "C:\\Tools\\codex.cmd");

for (const candidate of ["\"C:\\Program Files\\Codex\\codex.exe\"", "'C:/Tools/codex.cmd'", "\\\\nas\\tools\\codex.cmd", "//nas/tools/codex.cmd"]) {
  const legacy = { segmentAiCodexPath: candidate };
  assert.strictEqual(getMachineCliPath(legacy, "codex", mac), "");
  assert.strictEqual(getMachineCliPath(legacy, "codex", linux), "");
  assert.strictEqual(getMachineCliPath(legacy, "codex", windows), candidate);
  migrateMachineCliPaths(legacy, windows);
  assert.strictEqual(getMachineCliPath(legacy, "codex", windows), candidate);
}
for (const candidate of ["/usr/local/bin/codex", "\"/opt/Codex App/codex\"", "~/bin/codex"]) {
  const legacy = { segmentAiCodexPath: candidate };
  assert.strictEqual(getMachineCliPath(legacy, "codex", linux), candidate);
  assert.strictEqual(getMachineCliPath(legacy, "codex", mac), candidate);
}
assert.strictEqual(getMachineCliPath({ segmentAiCodexPath: "/usr/local/bin/codex" }, "codex", windows), "");
assert.strictEqual(getMachineCliPath({ segmentAiCodexPath: "~/bin/codex" }, "codex", windows), "~/bin/codex");
assert.strictEqual(getMachineCliPath({ segmentAiCodexPath: "~\\bin\\codex.cmd" }, "codex", windows), "~\\bin\\codex.cmd");

for (const candidate of ["codex", "./codex", "C:codex.exe", "\\codex.exe", "\"/unclosed", "~/", ""]) {
  const legacy = { segmentAiCodexPath: candidate };
  assert.strictEqual(getMachineCliPath(legacy, "codex", mac), "");
  assert.strictEqual(getMachineCliPath(legacy, "codex", windows), "");
}

const establishedEmptyMap = {
  segmentAiCodexPath: "/legacy/codex",
  segmentAiCliPathsByMachine: {},
};
assert.strictEqual(getMachineCliPath(establishedEmptyMap, "codex", mac), "");
migrateMachineCliPaths(establishedEmptyMap, mac);
assert.deepStrictEqual(establishedEmptyMap.segmentAiCliPathsByMachine, {});

for (const malformed of [null, [], "bad", 7]) {
  const legacy = { segmentAiCliPathsByMachine: malformed, segmentAiCodexPath: "/legacy/codex" };
  migrateMachineCliPaths(legacy, mac);
  assert.strictEqual(getMachineCliPath(legacy, "codex", mac), "/legacy/codex");
}
const malformedEntries = {
  segmentAiCodexPath: "/legacy/codex",
  segmentAiCliPathsByMachine: { "darwin:studio": { codex: {}, claude: 42 }, "win32:desktop": [] },
};
assert.strictEqual(getMachineCliPath(malformedEntries, "codex", mac), "");
assert.strictEqual(getMachineCliPath(malformedEntries, "claude", mac), "");
assert.strictEqual(getMachineCliPath(malformedEntries, "codex", windows), "");
setMachineCliPath(malformedEntries, "deepseek", "/custom/dsh", windows);
assert.strictEqual(getMachineCliPath(malformedEntries, "deepseek", windows), "/custom/dsh");
assert.strictEqual(getMachineCliPath(malformedEntries, "deepseek", mac), "");
