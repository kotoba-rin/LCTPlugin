const { readBytes, digest, readState } = require("./transactions");
const { decodeText } = require("./text-merge");
const { referencedAssets, createAssetIndex } = require("./catalog");
const { checkCancelled } = require("./downloads");
const { isKnowledgePath } = require("./validation");

const labels = { not_synced: "未同步", synced: "已同步", update: "有更新", missing_assets: "附件待补齐", modified: "本地已修改" };

const getKnowledgeEntryStatuses = async (engine, catalog, { signal } = {}) => {
  checkCancelled(signal);
  const state = await readState(engine.storage, `${engine.stateDir}/state.json`);
  const files = catalog.files || catalog.knowledgeEntries || [];
  const remote = new Map(files.map((file) => [file.path, file]));
  const assetIndex = createAssetIndex(files);
  const memo = new Map();
  const inspect = (path) => {
    if (!memo.has(path)) memo.set(path, (async () => {
      checkCancelled(signal);
      const bytes = await readBytes(engine.storage, path);
      const hash = digest(bytes);
      const unsaved = Boolean(await engine.storage.hasUnsavedChanges?.(path, hash));
      checkCancelled(signal);
      const baseline = state.files[path];
      const expected = remote.get(path)?.sha256;
      // Attachment contents are only needed for hashing; retaining them in the
      // per-scan memo would keep every image/PDF alive until the scan ends.
      return { bytes: isKnowledgePath(path) ? bytes : null, hash, unsaved, expected, modified: unsaved || (hash !== null
        && (baseline ? hash !== baseline : Boolean(expected && hash !== expected))) };
    })());
    return memo.get(path);
  };
  const result = {};
  for (const entry of catalog.knowledgeEntries || []) {
    checkCancelled(signal);
    const body = await inspect(entry.path);
    const missingAssets = [];
    const modifiedPaths = body.modified ? [entry.path] : [];
    const updatedPaths = body.hash !== null && body.expected && body.hash !== body.expected ? [entry.path] : [];
    const assets = body.bytes === null ? [] : referencedAssets(decodeText(body.bytes), entry.path, files, assetIndex);
    body.bytes = null;
    if (assets.length) {
      for (const path of assets) {
        const asset = await inspect(path);
        if (asset.modified) modifiedPaths.push(path);
        else if (asset.hash === null) missingAssets.push(path);
        else if (asset.expected && asset.hash !== asset.expected) updatedPaths.push(path);
      }
    }
    const needsCatalogRefresh = !body.expected;
    const status = modifiedPaths.length ? "modified" : body.hash === null ? "not_synced"
      : missingAssets.length ? "missing_assets" : updatedPaths.length ? "update" : needsCatalogRefresh ? "unknown" : "synced";
    result[entry.path] = { status, label: status === "unknown" ? "目录待刷新" : labels[status],
      missingAssets, modifiedPaths, updatedPaths, ...(needsCatalogRefresh ? { needsCatalogRefresh: true } : {}) };
  }
  const publishedPaths = new Set((catalog.knowledgeEntries || []).map((entry) => entry.path));
  for (const path of Object.keys(state.files)) {
    if (!isKnowledgePath(path) || publishedPaths.has(path)) continue;
    const local = await inspect(path);
    if (local.hash !== null) result[path] = { status: "removed", label: "上游已移除", ...(local.modified ? { modifiedPaths: [path] } : {}) };
  }
  checkCancelled(signal);
  return result;
};

module.exports = { getKnowledgeEntryStatuses };
