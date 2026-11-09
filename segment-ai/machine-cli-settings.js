const os = require("os");
const { PROVIDER_DEFINITIONS, normalizeProvider } = require("./provider-settings");

const isRecord = (value) => Boolean(value && typeof value === "object" && !Array.isArray(value));
const own = (record, key) => Object.prototype.hasOwnProperty.call(record, key);
const pathText = (value) => typeof value === "string" ? value.trim() : "";

const machineContext = ({
  platform = process.platform,
  hostname = os.hostname(),
  homeDirectory = os.homedir(),
} = {}) => ({ platform, homeDirectory, key: `${platform}:${hostname}` });

const isWindowsAbsolute = (value) => /^[a-z]:[\\/]/i.test(value)
  || /^(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+/.test(value);

const legacyPath = (settings, provider, context) => {
  const definition = PROVIDER_DEFINITIONS.find(({ id }) => id === provider);
  const original = pathText(settings[definition.pathSetting]);
  let candidate = original;
  if (/^["']/.test(candidate)) {
    if (candidate.length < 2 || candidate.at(-1) !== candidate[0]) return "";
    candidate = candidate.slice(1, -1);
  }
  const windowsAbsolute = isWindowsAbsolute(candidate);
  const tildePath = /^~[\\/].+/.test(candidate);
  const compatible = context.platform === "win32"
    ? windowsAbsolute || (tildePath && isWindowsAbsolute(String(context.homeDirectory)))
    : !windowsAbsolute && (
      candidate.startsWith("/") || /^~\/.+/.test(candidate)
    );
  return compatible ? original : "";
};

const requireSettings = (settings) => {
  if (!isRecord(settings)) throw new TypeError("Machine CLI settings must be an object.");
};

// Once a machine map exists, legacy paths may have come from a synced device.
// Only its initial migration may import those fields; a new host starts empty.
const migrateMachineCliPaths = (settings, options = {}) => {
  requireSettings(settings);
  if (isRecord(settings.segmentAiCliPathsByMachine)) return settings;
  const context = machineContext(options);
  settings.segmentAiCliPathsByMachine = {
    [context.key]: Object.fromEntries(PROVIDER_DEFINITIONS.map(({ id }) => [
      id, legacyPath(settings, id, context),
    ])),
  };
  return settings;
};

const getMachineCliPath = (settings, provider, options = {}) => {
  requireSettings(settings);
  const id = normalizeProvider(provider);
  const context = machineContext(options);
  const map = settings.segmentAiCliPathsByMachine;
  if (!isRecord(map)) return legacyPath(settings, id, context);
  const paths = own(map, context.key) && isRecord(map[context.key]) ? map[context.key] : {};
  return own(paths, id) ? pathText(paths[id]) : "";
};

const setMachineCliPath = (settings, provider, value, options = {}) => {
  requireSettings(settings);
  const id = normalizeProvider(provider);
  const context = machineContext(options);
  const configuredPath = pathText(value);
  migrateMachineCliPaths(settings, options);
  const map = settings.segmentAiCliPathsByMachine;
  if (!own(map, context.key) || !isRecord(map[context.key])) map[context.key] = {};
  map[context.key][id] = configuredPath;
  const definition = PROVIDER_DEFINITIONS.find((entry) => entry.id === id);
  settings[definition.pathSetting] = configuredPath;
  return configuredPath;
};

module.exports = { getMachineCliPath, setMachineCliPath, migrateMachineCliPaths };
