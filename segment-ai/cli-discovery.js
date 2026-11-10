const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile: defaultExecFile } = require("child_process");

const PROVIDERS = Object.freeze({
  codex: { label: "Codex CLI", binary: "codex", package: "@openai/codex" },
  claude: { label: "Claude Code", binary: "claude", package: "@anthropic-ai/claude-code" },
  deepseek: { label: "DeepSeek Harness", binary: "dsh", package: "@deepseek-ai/dsh" },
});

class CliDiscoveryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "CliDiscoveryError";
    this.code = code;
  }
}

const normalizeProvider = (provider) => {
  const id = { "claude-code": "claude", "deepseek-harness": "deepseek", dsh: "deepseek" }[provider] || provider;
  if (!PROVIDERS[id]) throw new CliDiscoveryError("UnknownProvider", `未知 CLI 提供商：${provider}`);
  return id;
};

const environmentValue = (environment, name) => {
  const key = Object.keys(environment).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key ? environment[key] : undefined;
};

const unquote = (value) => value.replace(/^(["'])(.*)\1$/, "$2");
const splitPath = (value, platform) => String(value || "").split(platform === "win32" ? ";" : ":")
  .map((entry) => unquote(entry.trim())).filter(Boolean);
const uniquePaths = (entries, platform) => {
  const seen = new Set();
  return entries.filter((entry) => {
    if (!entry) return false;
    const key = platform === "win32" ? entry.toLowerCase() : entry;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

const fileExists = (candidate, fileSystem, executable = false, platform = process.platform) => {
  try {
    if (!fileSystem.statSync(candidate).isFile()) return false;
    fileSystem.accessSync(candidate, executable && platform !== "win32" ? fs.constants.X_OK : fs.constants.R_OK);
    return true;
  } catch (_error) {
    return false;
  }
};

const readDirectories = (directory, fileSystem) => {
  try { return fileSystem.readdirSync(directory).filter((entry) => !entry.startsWith(".")); }
  catch (_error) { return []; }
};

const normalizeConfiguredPath = (value, home, platform, environment) => {
  let raw = unquote(String(value || "").trim());
  if (platform === "win32") {
    raw = raw.replace(/%([^%]+)%/g, (match, name) => environmentValue(environment, name) || match);
  }
  if (/^~(?:[\\/]|$)/.test(raw)) return (platform === "win32" ? path.win32 : path.posix).join(home, raw.slice(2));
  return raw;
};

const commonDirectoriesFor = (home, environment, platform, fileSystem) => {
  const paths = platform === "win32" ? path.win32 : path.posix;
  const join = (...segments) => paths.join(...segments);
  const npmPrefix = environmentValue(environment, "npm_config_prefix");
  const entries = [
    join(home, ".local", "bin"), join(home, ".claude", "local"),
    join(home, ".npm-global", "bin"), join(home, ".volta", "bin"),
    join(home, ".asdf", "shims"), join(home, ".local", "share", "mise", "shims"),
    environment.NVM_BIN, environment.VOLTA_HOME && join(environment.VOLTA_HOME, "bin"),
    environment.PNPM_HOME, environment.NVM_SYMLINK,
    npmPrefix && (platform === "win32" ? npmPrefix : join(npmPrefix, "bin")),
  ];
  if (platform === "win32") {
    const local = environment.LOCALAPPDATA || join(home, "AppData", "Local");
    entries.push(
      join(environment.APPDATA || join(home, "AppData", "Roaming"), "npm"),
      join(local, "pnpm"), join(local, "Microsoft", "WinGet", "Links"),
      join(local, "Programs", "OpenAI", "Codex", "bin"),
      join(environment.ProgramFiles || "C:\\Program Files", "nodejs"),
      join(local, "Programs", "nodejs"),
    );
    const runtimeRoot = join(local, "OpenAI", "Codex", "bin");
    entries.push(...readDirectories(runtimeRoot, fileSystem).sort().reverse().map((version) => join(runtimeRoot, version)));
  } else {
    entries.push("/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/opt/local/bin", join(home, "Library", "pnpm"));
    const nvmVersions = join(environment.NVM_DIR || join(home, ".nvm"), "versions", "node");
    entries.push(...readDirectories(nvmVersions, fileSystem).filter((version) => /^v\d/.test(version))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true })).map((version) => join(nvmVersions, version, "bin")));
    const asdfVersions = join(environment.ASDF_DATA_DIR || join(home, ".asdf"), "installs", "nodejs");
    entries.push(...readDirectories(asdfVersions, fileSystem).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
      .map((version) => join(asdfVersions, version, "bin")));
  }
  return uniquePaths(entries, platform);
};

const runProbe = (execFile, command, args, options, timeoutMs) => new Promise((resolve, reject) => {
  let settled = false;
  let child;
  const finish = (error, stdout = "", stderr = "") => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (error) reject(error);
    else resolve(`${stdout || ""}${stderr ? `\n${stderr}` : ""}`);
  };
  const timer = setTimeout(() => {
    try { child?.kill("SIGKILL"); } catch (_error) { /* The process may have exited already. */ }
    const error = new Error("CLI 检测超时");
    error.code = "CliProbeTimeout";
    finish(error);
  }, timeoutMs);
  try {
    child = execFile(command, args, {
      ...options, shell: false, encoding: "utf8", timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 256 * 1024,
    }, finish);
  } catch (error) { finish(error); }
});

const packageEntry = (packageRoot, definition, fileSystem, paths) => {
  try {
    const metadata = JSON.parse(fileSystem.readFileSync(paths.join(packageRoot, "package.json"), "utf8"));
    if (metadata.name !== definition.package) return null;
    const relative = typeof metadata.bin === "string" ? metadata.bin : metadata.bin?.[definition.binary];
    if (typeof relative !== "string") return null;
    const candidate = paths.resolve(packageRoot, relative);
    const relation = paths.relative(packageRoot, candidate);
    if (relation.startsWith("..") || paths.isAbsolute(relation)) return null;
    return fileExists(candidate, fileSystem) ? candidate : null;
  } catch (_error) { return null; }
};

const nearbyPackageEntry = (directory, definition, fileSystem, paths) => {
  const roots = [paths.join(directory, "node_modules", definition.package)];
  if (paths.basename(directory).toLowerCase() === "bin") {
    roots.push(paths.join(paths.dirname(directory), "lib", "node_modules", definition.package));
    roots.push(paths.join(paths.dirname(directory), "node_modules", definition.package));
  }
  for (const root of roots) {
    const entry = packageEntry(root, definition, fileSystem, paths);
    if (entry) return entry;
  }
  return null;
};

const windowsShimEntry = (candidate, fileSystem, paths) => {
  try {
    const contents = fileSystem.readFileSync(candidate.replace(/\.ps1$/i, ".cmd"), "utf8");
    for (const line of contents.split(/\r?\n/)) {
      // npm and pnpm shims invoke Node with a quoted entry and forward %*.
      const match = line.match(/"%(?:~dp0|dp0%)[\\/]?([^"\r\n]+\.(?:[cm]?js))"\s+%\*\s*$/i);
      if (match && /(?:node|%_prog%)/i.test(line.slice(0, match.index))) {
        const target = paths.resolve(paths.dirname(candidate), match[1]);
        if (fileExists(target, fileSystem)) return target;
      }
    }
  } catch (_error) { /* It may not be an npm shim. */ }
  return null;
};

const desktopInstallations = (provider, home, environment, platform, applicationDirectories) => {
  const paths = platform === "win32" ? path.win32 : path.posix;
  const roots = applicationDirectories || (platform === "darwin" ? [paths.join(home, "Applications"), "/Applications"] : []);
  if (provider === "codex" && platform === "darwin") {
    return roots.flatMap((root) => [
      paths.join(root, "Codex.app", "Contents", "Resources", "codex"),
      paths.join(root, "Codex.app", "Contents", "MacOS", "codex"),
      paths.join(root, "ChatGPT.app", "Contents", "Resources", "codex"),
      paths.join(root, "ChatGPT.app", "Contents", "Resources", "codex-cli", "CodexCLI.app", "Contents", "MacOS", "codex"),
    ]);
  }
  if (provider === "deepseek") {
    if (platform === "darwin") return roots.map((root) => paths.join(root, "DeepSeek Harness.app", "Contents", "Resources", "runtime", "cli", "bin", "dsh"));
    if (platform === "win32") return [paths.join(environment.LOCALAPPDATA || paths.join(home, "AppData", "Local"), "Programs", "DeepSeek Harness", "resources", "runtime", "cli", "bin", "dsh.cmd")];
  }
  return [];
};

const deepseekDesktopLaunch = (candidate, definition, context) => {
  const { platform, paths, fileSystem } = context;
  const canonical = (() => { try { return fileSystem.realpathSync(candidate); } catch (_error) { return candidate; } })();
  const match = platform === "win32"
    ? canonical.match(/^(.*?)(?:[\\/]resources[\\/]runtime[\\/]cli[\\/]bin[\\/]dsh\.cmd|[\\/]DeepSeek Harness\.exe)$/i)
    : canonical.match(/^(.*\.app)(?:\/Contents\/Resources\/runtime\/cli\/bin\/dsh)?$/);
  if (!match) return null;
  const resources = platform === "win32" ? paths.join(match[1], "resources") : paths.join(match[1], "Contents", "Resources");
  const command = platform === "win32" ? paths.join(match[1], "DeepSeek Harness.exe") : paths.join(match[1], "Contents", "MacOS", "DeepSeek Harness");
  const entry = packageEntry(paths.join(resources, "app.asar", "dsh", "node_modules", definition.package), definition, fileSystem, paths);
  if (!entry || !fileExists(command, fileSystem, true, platform)) return null;
  return { command, args: ["--expose-internals", entry], environment: { ...context.environment, ELECTRON_RUN_AS_NODE: "1" } };
};

const launchFor = (candidate, definition, context) => {
  const { platform, paths, fileSystem, directories } = context;
  if (definition.binary === "dsh") {
    const desktop = deepseekDesktopLaunch(candidate, definition, context);
    if (desktop) return desktop;
  }
  let entry = candidate;
  if (platform === "win32" && /\.(?:cmd|bat|ps1)$/i.test(entry)) {
    if (!fileExists(entry, fileSystem)) return null;
    entry = windowsShimEntry(entry, fileSystem, paths) || nearbyPackageEntry(paths.dirname(entry), definition, fileSystem, paths);
    if (!entry) throw new CliDiscoveryError("UnsupportedCliWrapper", "无法解析此 Windows CLI 包装脚本，请选择该工具的 .exe 或 Node.js 入口（.js/.cjs/.mjs）。");
  }
  let resolved = entry;
  try { resolved = fileSystem.realpathSync(entry); } catch (_error) { /* Keep the user-visible path. */ }
  const isNodeEntry = /\.[cm]?js$/i.test(resolved);
  if (!fileExists(resolved, fileSystem, !isNodeEntry, platform)) return null;
  if (!isNodeEntry) return { command: entry, args: [], environment: context.environment };
  const nodeName = platform === "win32" ? "node.exe" : "node";
  const node = [paths.join(paths.dirname(entry), nodeName), ...directories.map((directory) => paths.join(directory, nodeName))]
    .find((file) => fileExists(file, fileSystem, true, platform));
  const command = node || process.execPath;
  const environment = { ...context.environment };
  // Obsidian's process.execPath points at Electron, which otherwise opens a second GUI.
  if (!node && process.versions.electron) environment.ELECTRON_RUN_AS_NODE = "1";
  return { command, args: [resolved], environment };
};

const buildEnvironment = (source, directories, cliPath, platform) => {
  const paths = platform === "win32" ? path.win32 : path.posix;
  const key = Object.keys(source).find((name) => name.toLowerCase() === "path") || "PATH";
  return { ...source, [key]: uniquePaths([paths.dirname(cliPath), ...directories], platform).join(platform === "win32" ? ";" : ":") };
};

const buildCliInvocation = (cli, args = []) => ({ command: cli.command, args: [...(cli.args || []), ...args] });

async function discoverCli(provider, options = {}) {
  const id = normalizeProvider(provider);
  const definition = PROVIDERS[id];
  const platform = options.platform || process.platform;
  const paths = platform === "win32" ? path.win32 : path.posix;
  const environment = options.environment || process.env;
  const home = options.homeDirectory || (platform === "win32" ? environment.USERPROFILE || environment.HOME : environment.HOME || environment.USERPROFILE) || os.homedir();
  const fileSystem = options.fileSystem || fs;
  const execFile = options.execFile || defaultExecFile;
  const custom = normalizeConfiguredPath(options.configuredPath, home, platform, environment);
  if (custom && !paths.isAbsolute(custom)) throw new CliDiscoveryError("InvalidCliPath", `${definition.label} 路径必须是绝对路径。`);
  const inherited = splitPath(environmentValue(environment, "PATH"), platform).filter((entry) => paths.isAbsolute(entry));
  const common = options.commonDirectories || commonDirectoriesFor(home, environment, platform, fileSystem);
  const candidatesFor = (directories, source) => directories.flatMap((directory) => {
    const names = platform === "win32" ? [`${definition.binary}.exe`, `${definition.binary}.cmd`] : [definition.binary];
    const candidates = names.map((name) => ({ path: paths.join(directory, name), source }));
    const entry = nearbyPackageEntry(directory, definition, fileSystem, paths);
    if (entry) candidates.push({ path: entry, source });
    return candidates;
  });
  let chosen;
  const choose = (candidates) => {
    for (const candidate of candidates) {
      try {
        const context = { platform, paths, fileSystem, directories: uniquePaths([...inherited, ...common], platform), environment };
        const launch = launchFor(candidate.path, definition, context);
        if (launch) return { ...candidate, ...launch };
      } catch (error) { if (custom) throw error; }
    }
    return null;
  };
  if (custom) {
    chosen = choose([{ path: custom, source: "custom" }]);
    if (!chosen) throw new CliDiscoveryError("CliNotFound", `设置中的 ${definition.label} 路径无效，请选择可执行文件或 Node.js 入口的绝对路径。`);
  } else {
    chosen = choose(candidatesFor(inherited, "path"));
    if (!chosen) chosen = choose(candidatesFor(common, "common"));
    if (!chosen) chosen = choose(desktopInstallations(id, home, environment, platform, options.applicationDirectories).map((candidate) => ({ path: candidate, source: "application" })));
    if (!chosen) throw new CliDiscoveryError("CliNotFound", `未找到本地 ${definition.label}。请安装该 CLI，或在插件设置中填写其绝对路径。`);
  }
  const directories = uniquePaths([...inherited, ...common], platform);
  chosen.environment = buildEnvironment(chosen.environment, directories, chosen.path, platform);
  chosen.provider = id;
  chosen.version = null;
  if (options.readVersion !== false) {
    try {
      const invocation = buildCliInvocation(chosen, ["--version"]);
      const output = await runProbe(execFile, invocation.command, invocation.args,
        { env: chosen.environment, windowsHide: true, cwd: home }, options.versionTimeoutMs || 3000);
      chosen.version = output.match(/(?:^|[^\w.])v?(\d+\.\d+(?:\.\d+)?(?:[-+][\w.-]+)?)(?![\w.])/m)?.[1] || null;
    } catch (error) { chosen.versionError = error.code === "CliProbeTimeout" ? "版本检测超时" : "无法读取 CLI 版本"; }
  }
  return chosen;
}

module.exports = { PROVIDERS, CliDiscoveryError, discoverCli, buildCliInvocation };
