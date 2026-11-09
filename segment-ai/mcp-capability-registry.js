// Internal isolation only. An empty TOML table does not remove inherited server
// entries, so every configured name needs an explicit enabled:false override.
const normalizeServerNames = (serverNames) => Array.from(new Set(
  (Array.isArray(serverNames) ? serverNames : [])
    .map((name) => String(name || ""))
    .filter((name) => name.trim().length > 0)
)).sort();

const buildDisabledMcpServerConfig = (serverNames) => Object.fromEntries(
  normalizeServerNames(serverNames).map((name) => [name, { enabled: false }])
);

module.exports = { buildDisabledMcpServerConfig, normalizeServerNames };
