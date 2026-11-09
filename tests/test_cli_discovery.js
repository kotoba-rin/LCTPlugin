const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { discoverCli, buildCliInvocation } = require("../segment-ai/cli-discovery");

const makeFile = (file, contents = "#!/bin/sh\necho tool 1.2.3\n", mode = 0o755) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents, { mode });
  return file;
};
const root = fs.mkdtempSync(path.join(os.tmpdir(), "lctp-cli-discovery-"));
const baseOptions = { homeDirectory: root, environment: { HOME: root, PATH: "" }, commonDirectories: [], applicationDirectories: [], loginShell: false };

const virtualWindowsFS = (entries) => ({
  statSync(file) { if (!(file in entries)) throw new Error("ENOENT"); return { isFile: () => true }; },
  accessSync(file) { if (!(file in entries)) throw new Error("ENOENT"); },
  realpathSync(file) { if (!(file in entries)) throw new Error("ENOENT"); return file; },
  readdirSync() { return []; },
  readFileSync(file) { if (!(file in entries)) throw new Error("ENOENT"); return entries[file]; },
});

(async () => {
  try {
    const autoDir = path.join(root, "path-bin");
    const autoCli = makeFile(path.join(autoDir, "codex"));
    const explicitCli = makeFile(path.join(root, "custom codex"), "#!/bin/sh\necho codex-cli 0.153.0\n");
    const custom = await discoverCli("codex", { ...baseOptions, environment: { PATH: autoDir }, configuredPath: explicitCli });
    assert.strictEqual(custom.path, explicitCli);
    assert.strictEqual(custom.source, "custom");
    assert.strictEqual(custom.version, "0.153.0");
    const nativeNode = await discoverCli("codex", { ...baseOptions, configuredPath: process.execPath });
    assert.strictEqual(nativeNode.version, process.versions.node, "native v-prefixed versions retain their major number");
    assert.strictEqual(custom.environment.PATH.split(":")[0], root);
    assert.deepStrictEqual(buildCliInvocation(custom, ["app-server"]), { command: explicitCli, args: ["app-server"] });
    await assert.rejects(discoverCli("codex", { ...baseOptions, configuredPath: "codex" }), (error) => error.code === "InvalidCliPath");
    await assert.rejects(discoverCli("codex", { ...baseOptions, environment: { PATH: autoDir }, configuredPath: path.join(root, "missing") }), (error) => error.code === "CliNotFound");
    const foundPath = await discoverCli("codex", { ...baseOptions, environment: { PATH: autoDir } });
    assert.strictEqual(foundPath.path, autoCli);
    assert.strictEqual(foundPath.source, "path");

    // GUI apps have no user-installed PATH entries; native installer directories still work.
    const claude = makeFile(path.join(root, ".local", "bin", "claude"));
    const gui = await discoverCli("claude", { homeDirectory: root, environment: { HOME: root, PATH: "" }, loginShell: false, applicationDirectories: [] });
    assert.strictEqual(gui.path, claude);
    assert.strictEqual(gui.source, "common");

    const shellDirectory = path.join(root, "from-shell");
    const shellCli = makeFile(path.join(shellDirectory, "dsh"));
    const shellCalls = [];
    const viaShell = await discoverCli("deepseek", {
      ...baseOptions, loginShell: true, environment: { HOME: root, PATH: "", SHELL: "/bin/zsh" },
      execFile(command, args, options, callback) {
        shellCalls.push({ command, args, options });
        callback(null, `profile banner\n__LCTPLUGIN_LOGIN_PATH__${shellDirectory}\n__LCTPLUGIN_LOGIN_PATH__`, "");
      }, readVersion: false,
    });
    assert.strictEqual(viaShell.path, shellCli);
    assert.strictEqual(viaShell.source, "login-shell");
    assert.strictEqual(shellCalls[0].command, "/bin/zsh");
    assert.deepStrictEqual(shellCalls[0].args.slice(0, 3), ["-i", "-l", "-c"]);
    assert(!shellCalls[0].args[3].includes(shellDirectory), "CLI path never enters shell command syntax");
    assert(viaShell.environment.PATH.includes(shellDirectory));

    let killedShell = false;
    const afterShellTimeout = await discoverCli("claude", {
      homeDirectory: root, environment: { HOME: root, PATH: "", SHELL: "/bin/zsh" }, shellTimeoutMs: 10,
      execFile: () => ({ kill() { killedShell = true; } }), readVersion: false, applicationDirectories: [],
    });
    assert.strictEqual(afterShellTimeout.path, claude);
    assert(killedShell, "a hung login shell is killed before common-directory fallback");

    // Readable Node entry points need not have a Unix executable bit.
    const entry = fs.realpathSync(makeFile(path.join(root, "scripts with spaces", "cli-wrapper.cjs"), "console.log('Claude Code 2.1.92')\n", 0o644));
    const nodeWrapper = await discoverCli("claude-code", { ...baseOptions, configuredPath: entry });
    assert.strictEqual(nodeWrapper.command, process.execPath);
    assert.deepStrictEqual(nodeWrapper.args, [entry]);
    assert.strictEqual(nodeWrapper.version, "2.1.92");
    assert.deepStrictEqual(buildCliInvocation(nodeWrapper, ["-p"]), { command: process.execPath, args: [entry, "-p"] });

    const symlink = path.join(root, "linked-cli");
    fs.symlinkSync(entry, symlink);
    const linked = await discoverCli("claude", { ...baseOptions, configuredPath: symlink, readVersion: false });
    assert.deepStrictEqual(linked.args, [entry], "extensionless npm symlinks resolve their JavaScript target");

    let killedVersion = false;
    const timedOut = await discoverCli("codex", {
      ...baseOptions, configuredPath: explicitCli, versionTimeoutMs: 10,
      execFile: () => ({ kill() { killedVersion = true; } }),
    });
    assert.strictEqual(timedOut.path, explicitCli);
    assert.strictEqual(timedOut.version, null);
    assert.strictEqual(timedOut.versionError, "版本检测超时");
    assert(killedVersion, "a hung --version cannot hold settings discovery open");
    await assert.rejects(discoverCli("deepseek", baseOptions), (error) => error.code === "CliNotFound");

    // Codex shipped with the Mac app is a usable fallback when no global command exists.
    const appRoot = path.join(root, "Apps");
    const appCodex = makeFile(path.join(appRoot, "ChatGPT.app", "Contents", "Resources", "codex-cli", "CodexCLI.app", "Contents", "MacOS", "codex"));
    const app = await discoverCli("codex", { ...baseOptions, platform: "darwin", applicationDirectories: [appRoot] });
    assert.strictEqual(app.path, appCodex);
    assert.strictEqual(app.source, "application");

    // NVM installs remain discoverable when the shell cannot be started.
    const nvmRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lctp-nvm-"));
    try {
      const nvmCli = makeFile(path.join(nvmRoot, ".nvm", "versions", "node", "v24.1.0", "bin", "dsh"));
      const nvm = await discoverCli("dsh", { homeDirectory: nvmRoot, environment: { HOME: nvmRoot, PATH: "" }, loginShell: false, applicationDirectories: [] });
      assert.strictEqual(nvm.path, nvmCli);
    } finally { fs.rmSync(nvmRoot, { recursive: true, force: true }); }

    // Windows npm shims locate the underlying script; cmd.exe never sees user text.
    const winHome = "C:\\Users\\Reader";
    const winBin = `${winHome}\\AppData\\Roaming\\npm`;
    const winEntry = `${winBin}\\node_modules\\@anthropic-ai\\claude-code\\cli-wrapper.cjs`;
    const winCli = `${winBin}\\claude.cmd`;
    const nodeExe = "C:\\Program Files\\nodejs\\node.exe";
    const winFS = virtualWindowsFS({
      [winCli]: '@"%~dp0\\node.exe" "%~dp0\\node_modules\\@anthropic-ai\\claude-code\\cli-wrapper.cjs" %*',
      [winEntry]: "", [nodeExe]: "",
    });
    const winOptions = {
      platform: "win32", fileSystem: winFS, homeDirectory: winHome, readVersion: false,
      environment: { USERPROFILE: winHome, Path: `${winBin};C:\\Program Files\\nodejs` }, commonDirectories: [], applicationDirectories: [],
    };
    const win = await discoverCli("claude", winOptions);
    assert.strictEqual(win.path, winCli);
    const expandedWin = await discoverCli("claude", { ...winOptions, environment: { ...winOptions.environment, APPDATA: `${winHome}\\AppData\\Roaming` }, configuredPath: '"%APPDATA%\\npm\\claude.cmd"' });
    assert.strictEqual(expandedWin.path, winCli, "Windows environment variables expand after surrounding quotes are removed");
    assert.strictEqual(win.command, nodeExe);
    assert.deepStrictEqual(win.args, [winEntry]);
    const hostileText = 'text & echo BAD | more %PATH% !value!\nnext';
    assert.deepStrictEqual(buildCliInvocation(win, [hostileText]).args, [winEntry, hostileText]);
    assert(!Object.hasOwn(win.environment, "PATH"), "Windows preserves existing Path key casing");
    assert(win.environment.Path.includes(winBin));
    const unsafeWrapper = `${winBin}\\unsafe.cmd`;
    await assert.rejects(discoverCli("claude", {
      ...winOptions, configuredPath: unsafeWrapper, fileSystem: virtualWindowsFS({ [unsafeWrapper]: "echo custom wrapper" }),
    }), (error) => error.code === "UnsupportedCliWrapper");

    // A Windows DeepSeek Desktop locator requires its bundled Electron runtime.
    const desktopRoot = `${winHome}\\AppData\\Local\\Programs\\DeepSeek Harness`;
    const desktopLocator = `${desktopRoot}\\resources\\runtime\\cli\\bin\\dsh.cmd`;
    const desktopPackage = `${desktopRoot}\\resources\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh`;
    const desktopEntry = `${desktopPackage}\\lib\\bin.js`;
    const desktopExe = `${desktopRoot}\\DeepSeek Harness.exe`;
    const desktop = await discoverCli("deepseek", {
      ...winOptions, environment: { USERPROFILE: winHome, Path: "" },
      fileSystem: virtualWindowsFS({
        [desktopLocator]: "", [desktopExe]: "", [desktopEntry]: "",
        [`${desktopPackage}\\package.json`]: JSON.stringify({ name: "@deepseek-ai/dsh", bin: { dsh: "lib/bin.js" } }),
      }),
    });
    assert.strictEqual(desktop.command, desktopExe);
    assert.deepStrictEqual(desktop.args, ["--expose-internals", desktopEntry]);
    assert.strictEqual(desktop.environment.ELECTRON_RUN_AS_NODE, "1");
    assert.strictEqual(desktop.source, "application");
    console.log("CLI discovery tests passed.");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
