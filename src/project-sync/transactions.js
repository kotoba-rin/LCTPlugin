const { randomBytes } = require("crypto");
const { asBytes, sha256, encodeJson, parseJson, validateContentPath, validateVersion, HASH_RE } = require("./validation");
const { checkCancelled } = require("./downloads");

const readBytes = async (storage, path) => {
  const value = await storage.read(path);
  return value == null ? null : asBytes(value);
};
const digest = (bytes) => bytes == null ? null : sha256(bytes);
const readHash = async (storage, path) => digest(await readBytes(storage, path));
const localChangesError = (path, reason = "changed_during_sync") => Object.assign(new Error("文件已发生变化，识别到用户修改，已跳过同步。"), {
  code: "LOCAL_CHANGES_DETECTED", path, reason,
});
const assertUnchanged = async (storage, path, expectedHash) => {
  if (await storage.hasUnsavedChanges?.(path, expectedHash)) throw localChangesError(path, "unsaved_changes");
  if (await readHash(storage, path) !== expectedHash) throw localChangesError(path);
};
const backupPathFor = (stateDir, id, path) => `${stateDir}/transactions/${id}/backup/${sha256(Buffer.from(path))}.bin`;
const compareAndWrite = async (storage, path, expectedHash, data) => {
  if (storage.compareAndWrite) return storage.compareAndWrite(path, expectedHash, data);
  if (await readHash(storage, path) !== expectedHash) return false;
  if (data == null) await storage.remove(path);
  else await storage.write(path, data);
  return true;
};
const removeIfPresent = async (storage, path) => {
  if (await storage.read(path) != null) await storage.remove(path);
};
const emptyState = () => ({ schema_version: 2, version: null, manifest_sha256: null, files: {}, conflicts: [], local_deletions: {} });
const validateState = (state) => {
  if (!state || ![1, 2].includes(state.schema_version) || !state.files || Array.isArray(state.files)) throw new Error("同步基线损坏；为保护本地文件，已停止同步。");
  if (state.version != null) validateVersion(state.version);
  for (const [path, hash] of Object.entries(state.files)) {
    validateContentPath(path);
    if (!HASH_RE.test(hash)) throw new Error("同步基线包含无效校验值，已停止同步。");
  }
  if (state.local_deletions && (typeof state.local_deletions !== "object" || Array.isArray(state.local_deletions))) throw new Error("本地删除记录损坏。");
  for (const [path, hash] of Object.entries(state.local_deletions || {})) {
    validateContentPath(path);
    if (!HASH_RE.test(hash) || hash !== state.files[path]) throw new Error("本地删除基线记录损坏。");
  }
  if (state.conflicts !== undefined && !Array.isArray(state.conflicts)) throw new Error("冲突记录损坏。");
  return state;
};
const readState = async (storage, path) => {
  const data = await readBytes(storage, path);
  return data == null ? emptyState() : validateState(parseJson(data, "本地同步基线"));
};
const validateJournal = (journal, stateDir) => {
  if (journal?.schema_version !== 1 || !Array.isArray(journal.entries) || !/^[a-zA-Z0-9-]+$/.test(journal.id || "")) throw new Error("同步恢复记录损坏，已停止同步。");
  if (journal.phase !== undefined && journal.phase !== "cleanup") throw new Error("同步恢复记录阶段无效。");
  validateState(journal.previous_state);
  for (const entry of journal.entries) {
    validateContentPath(entry.path);
    for (const value of [entry.beforeHash, entry.afterHash]) {
      if (value !== null && !HASH_RE.test(value || "")) throw new Error("同步恢复校验记录损坏。");
    }
    if (entry.backupPath !== backupPathFor(stateDir, journal.id, entry.path)) throw new Error("同步恢复备份路径无效。");
  }
  return journal;
};
const cleanupTransaction = async (storage, stateDir, journal) => {
  for (const entry of journal.entries) {
    await removeIfPresent(storage, entry.backupPath);
  }
  await removeIfPresent(storage, `${stateDir}/journal.json`);
};
const restorePreviousState = async (storage, stateDir, state) => {
  await storage.write(`${stateDir}/state.json`, encodeJson(state));
  await storage.write(`${stateDir}/conflicts.json`, encodeJson({ version: state.version,
    generated_at: state.synced_at || null, conflicts: state.conflicts || [] }));
};
const rollbackTransaction = async (storage, stateDir, journal) => {
  const preserved = new Set();
  const backups = [];
  for (const entry of [...journal.entries].reverse()) {
    if (entry.skipped) continue;
    const currentHash = await readHash(storage, entry.path);
    if (currentHash === entry.beforeHash) continue;
    const before = entry.beforeHash === null ? null : await readBytes(storage, entry.backupPath);
    const validBackup = digest(before) === entry.beforeHash;
    if (currentHash === entry.afterHash) {
      if (!validBackup) throw new Error(`同步恢复备份损坏：${entry.path}`);
      if (await compareAndWrite(storage, entry.path, entry.afterHash, before)) continue;
    }
    preserved.add(entry.path);
    if (before !== null && validBackup) backups.push(entry);
  }
  await restorePreviousState(storage, stateDir, journal.previous_state);
  if (preserved.size) {
    await storage.write(`${stateDir}/recovery-conflicts.json`, encodeJson({ paths: [...preserved], transaction_id: journal.id,
      backups, recovered_at: new Date().toISOString() }));
  }
  // Mark rollback complete before deleting backups, so a retry only cleans up.
  const cleanup = { ...journal, phase: "cleanup", entries: journal.entries.filter((entry) => !preserved.has(entry.path)) };
  await storage.write(`${stateDir}/journal.json`, encodeJson(cleanup));
  await cleanupTransaction(storage, stateDir, cleanup);
};
const recoverTransaction = async (storage, stateDir, onProgress) => {
  const journalPath = `${stateDir}/journal.json`;
  const data = await readBytes(storage, journalPath);
  if (!data) return;
  const journal = validateJournal(parseJson(data, "同步恢复记录"), stateDir);
  onProgress?.({ phase: "recovering", completed: 0, total: journal.entries.length });
  if (journal.phase === "cleanup") return cleanupTransaction(storage, stateDir, journal);
  let current = null;
  try { current = await readState(storage, `${stateDir}/state.json`); } catch { /* The journal restores an interrupted state write. */ }
  if (current?.last_transaction !== journal.id) {
    return rollbackTransaction(storage, stateDir, journal);
  }
  await cleanupTransaction(storage, stateDir, journal);
};

const prepareTransaction = async (storage, stateDir, plans, state, latest, signal, { rejectChanged = false } = {}) => {
  const id = `${Date.now()}-${randomBytes(6).toString("hex")}`;
  const entries = [];
  for (const plan of plans.filter((entry) => entry.action !== "skip")) {
    checkCancelled(signal);
    if (rejectChanged) await assertUnchanged(storage, plan.path, plan.beforeHash);
  }
  for (const plan of plans.filter((entry) => ["add", "update", "merge", "resolve", "delete"].includes(entry.action))) {
    checkCancelled(signal);
    const before = await readBytes(storage, plan.path);
    if (digest(before) !== plan.beforeHash) {
      if (rejectChanged) throw localChangesError(plan.path);
      plan.action = "conflict";
      plan.kind = "changed_during_sync";
      continue;
    }
    const backupPath = backupPathFor(stateDir, id, plan.path);
    if (before !== null) await storage.write(backupPath, before);
    entries.push({ path: plan.path, beforeHash: plan.beforeHash, afterHash: Object.hasOwn(plan, "afterHash") ? plan.afterHash : plan.file?.sha256 || null, backupPath });
  }
  const journal = { schema_version: 1, id, version: latest.version, previous_state: state, entries };
  checkCancelled(signal);
  await storage.write(`${stateDir}/journal.json`, encodeJson(journal));
  return journal;
};

module.exports = { readBytes, digest, readHash, localChangesError, assertUnchanged, backupPathFor, compareAndWrite, removeIfPresent, emptyState, validateState, readState, rollbackTransaction, cleanupTransaction, recoverTransaction, prepareTransaction };
