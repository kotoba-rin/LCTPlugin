const { sha256, HASH_RE } = require("./validation");
const { readBytes, digest } = require("./transactions");

const basePathFor = (stateDir, hash) => {
  if (!HASH_RE.test(hash || "")) throw new Error("无效的文库基线校验值。");
  return `${stateDir}/bases/${hash}.bin`;
};
const readBase = async (storage, stateDir, hash) => {
  if (!hash) return null;
  const bytes = await readBytes(storage, basePathFor(stateDir, hash));
  return digest(bytes) === hash ? bytes : null;
};
const cacheBase = async (storage, stateDir, hash, bytes) => {
  if (bytes === null || sha256(bytes) !== hash) throw new Error("文库基线原文校验失败。");
  if (await readBase(storage, stateDir, hash) === null) await storage.write(basePathFor(stateDir, hash), bytes);
};
const isTextPath = (path) => /\.(?:md|txt|csv)$/i.test(path) || path === "LICENSE";

module.exports = { basePathFor, readBase, cacheBase, isTextPath };
