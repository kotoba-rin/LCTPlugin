const { digest, readBytes } = require("./transactions");
const { isTextPath } = require("./base-cache");
const { decodeText, mergeText, detectEol, comparisonBlocks } = require("./text-merge");
const { validateContentPath, HASH_RE } = require("./validation");

const buildComparison = ({ path, kind, baseHash, baseBytes, localBytes, upstreamBytes }) => {
  const baseText = decodeText(baseBytes);
  const localText = decodeText(localBytes);
  const upstreamText = decodeText(upstreamBytes);
  const canResolveText = isTextPath(path) && (localBytes === null || localText !== null) && (upstreamBytes === null || upstreamText !== null);
  const missingBase = baseBytes === null;
  const merge = canResolveText && !missingBase && localBytes !== null && upstreamBytes !== null
    ? mergeText(baseBytes, localBytes, upstreamBytes) : null;
  const eol = detectEol(localText ?? upstreamText ?? baseText);
  return { path, kind, baseHash: baseHash || null, localHash: digest(localBytes), upstreamHash: digest(upstreamBytes),
    baseText, localText, upstreamText, canResolveText, missingBase, eol, mergeable: Boolean(merge?.mergeable), clean: Boolean(merge?.clean),
    mergedText: merge?.clean ? decodeText(merge.content) : null,
    reason: merge?.reason || (missingBase ? "missing_base" : !canResolveText ? "non_text" : "file_deleted"),
    blocks: canResolveText ? merge?.blocks || comparisonBlocks(baseText, localText, upstreamText) : [] };
};

const readComparison = async (engine, state, path) => {
  validateContentPath(path);
  const conflict = state.conflicts?.find((entry) => entry.path === path);
  if (!conflict) throw new Error("这个文件已没有待处理冲突，请刷新同步报告。");
  const baseHash = conflict.baseHash || state.files[path] || null;
  // Historical conflict records remain resolvable without keeping old bodies.
  const baseBytes = null;
  const localBytes = await readBytes(engine.storage, path);
  let upstreamBytes = null;
  if (conflict.upstreamHash !== null) {
    if (!HASH_RE.test(conflict.upstreamHash || "")) throw new Error("冲突的上游校验记录无效，请重新同步。");
    const expectedPath = engine.incomingPath(conflict.upstreamVersion || state.version, { path, sha256: conflict.upstreamHash });
    if (conflict.incomingPath !== expectedPath) throw new Error("冲突的上游副本路径无效，请重新同步。");
    upstreamBytes = await readBytes(engine.storage, expectedPath);
    if (digest(upstreamBytes) !== conflict.upstreamHash) throw new Error("上游冲突副本缺失或已修改，请重新同步。");
  }
  return { comparison: buildComparison({ path, kind: conflict.kind, baseHash, baseBytes, localBytes, upstreamBytes }),
    conflict, localBytes, upstreamBytes, baseBytes };
};

module.exports = { buildComparison, readComparison };
