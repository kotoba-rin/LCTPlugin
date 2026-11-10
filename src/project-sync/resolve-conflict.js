const { HASH_RE, validateContentPath } = require("./validation");
const { readState, recoverTransaction, digest } = require("./transactions");
const { cacheBase } = require("./base-cache");
const { readComparison } = require("./conflict-comparison");
const { decodeText, preserveEol } = require("./text-merge");

const resolveConflict = async (engine, path, { expectedLocalHash, expectedUpstreamHash, content } = {}) => {
  validateContentPath(path);
  if (![expectedLocalHash, expectedUpstreamHash].every((value) => value === null || HASH_RE.test(value || ""))) throw new Error("保存冲突结果必须提供当前比较的校验值。");
  if (content !== null && typeof content !== "string") throw new Error("合并结果必须是完整文本或删除选择。");
  await recoverTransaction(engine.storage, engine.stateDir, (event) => engine.onProgress?.(event));
  const state = await readState(engine.storage, `${engine.stateDir}/state.json`);
  const { comparison, conflict, upstreamBytes } = await readComparison(engine, state, path);
  if (comparison.localHash !== expectedLocalHash || comparison.upstreamHash !== expectedUpstreamHash) throw new Error("文件或上游版本已变化，请重新打开比较后再保存。");
  if (!comparison.canResolveText) throw new Error("二进制附件不能作为文本保存，请保留本地文件并手动处理附件。");
  const afterBytes = content === null ? null : Buffer.from(preserveEol(content, comparison.eol), "utf8");
  if (afterBytes !== null && (afterBytes.length > 64 * 1024 * 1024 || decodeText(afterBytes) !== preserveEol(content, comparison.eol))) throw new Error("合并结果不是有效 UTF-8 文本或超出大小限制。");
  if (upstreamBytes !== null) await cacheBase(engine.storage, engine.stateDir, comparison.upstreamHash, upstreamBytes);
  const plan = { path, action: "resolve", kind: conflict.kind, beforeHash: expectedLocalHash, afterHash: digest(afterBytes), afterBytes,
    baseline: comparison.baseHash, incomingPath: conflict.incomingPath, upstreamVersion: conflict.upstreamVersion || state.version,
    file: upstreamBytes === null ? null : { path, sha256: comparison.upstreamHash, size: upstreamBytes.length } };
  const result = await engine.applyPlans([plan], state, { version: state.version, source_revision: state.source_revision, manifest_sha256: state.manifest_sha256 }, undefined,
    { preservedConflicts: (state.conflicts || []).filter((entry) => entry.path !== path), strict: true });
  return { ...result, downloadedFiles: 0, usedArchive: false, resolvedPath: path };
};

module.exports = { resolveConflict };
