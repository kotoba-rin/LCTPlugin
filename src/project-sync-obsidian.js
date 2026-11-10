const { createHash, randomBytes } = require("crypto");
const fs = require("fs");
const nodePath = require("path");
const { isTextPath } = require("./project-sync/base-cache");

const digest = (bytes) => bytes === null ? null : createHash("sha256").update(bytes).digest("hex");
const arrayBuffer = (bytes) => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
const abortError = () => Object.assign(new Error("文库同步已取消。"), { name: "AbortError" });
const requestTails = new WeakMap();

const createProjectTransport = (requestUrl) => async (url, { signal, maxBytes = 256 * 1024 * 1024 } = {}) => {
  if (signal?.aborted) throw abortError();
  const timeoutMs = maxBytes > 10 * 1024 * 1024 ? 300000 : 45000;
  let timer;
  let onAbort;
  let stopped = false;
  const requestController = new AbortController();
  try {
    const stop = new Promise((_, reject) => {
      timer = setTimeout(() => {
        stopped = true;
        reject(new Error("下载文库超时，请检查网络后重试。"));
        requestController.abort();
      }, timeoutMs);
      onAbort = () => { stopped = true; reject(abortError()); requestController.abort(); };
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
    // Obsidian requests can outlive cancellation or timeout. Hold the shared
    // queue until the actual request settles, even if its caller stops waiting.
    const request = (requestTails.get(requestUrl) || Promise.resolve()).then(() => {
      if (stopped || signal?.aborted) throw abortError();
      return requestUrl({ url, method: "GET", headers: { "Cache-Control": "no-cache" }, throw: false },
        { signal: requestController.signal, maxBytes });
    });
    const tail = request.then(() => {}, () => {});
    requestTails.set(requestUrl, tail);
    void tail.then(() => { if (requestTails.get(requestUrl) === tail) requestTails.delete(requestUrl); });
    const response = await Promise.race([request, stop]);
    if (signal?.aborted) throw abortError();
    if (response.status !== 200) throw new Error(`文库服务返回 HTTP ${response.status}。`);
    const declared = Object.entries(response.headers || {}).find(([key]) => key.toLowerCase() === "content-length")?.[1];
    if (Number(declared) > maxBytes) throw new Error("文库下载超出允许的大小。");
    const bytes = new Uint8Array(response.arrayBuffer);
    if (bytes.byteLength > maxBytes) throw new Error("文库下载超出允许的大小。");
    return bytes;
  } finally {
    clearTimeout(timer);
    if (onAbort) signal?.removeEventListener("abort", onAbort);
  }
};

const createVaultSyncStorage = (vault, { getEditorTexts = () => [], isWriteBlocked = () => false } = {}) => {
  const adapter = vault.adapter;
  const basePath = adapter.getBasePath?.();
  const configDir = vault.configDir || ".obsidian";
  const stateRoot = `${configDir}/plugins/lacan-translation-helper/project-sync/`;
  const internal = (path) => path.startsWith(stateRoot);
  const validate = (path) => {
    if (typeof path !== "string" || !path || /[\\:\x00-\x1f]/.test(path)
      || path.startsWith("/") || path.split("/").some((part) => !part || part === "." || part === "..")) {
      throw new Error("不安全的文库文件路径。");
    }
    if (path.startsWith(`${configDir}/`) && !internal(path)) throw new Error("同步不能修改 Obsidian 配置。");
    if (basePath) {
      // Obsidian supports a linked development plugin directory. Trust that
      // installed plugin location for its private state, never content paths.
      let current = internal(path) ? nodePath.join(basePath, stateRoot) : basePath;
      const parts = internal(path) ? ["", ...path.slice(stateRoot.length).split("/")] : path.split("/");
      for (const part of parts) {
        current = nodePath.join(current, part);
        try {
          if (fs.lstatSync(current).isSymbolicLink()) throw new Error("同步路径包含符号链接，已停止以保护本地文件。");
        } catch (error) {
          if (error.code === "ENOENT") break;
          throw error;
        }
      }
    }
    return path;
  };
  const ensureParents = async (path) => {
    const parts = path.split("/");
    parts.pop();
    let parent = "";
    for (const part of parts) {
      parent = parent ? `${parent}/${part}` : part;
      if (!await adapter.exists(parent)) await adapter.mkdir(parent);
    }
  };
  const storage = {
    hasUnsavedChanges(path, expectedHash) {
      validate(path);
      return !internal(path) && (isWriteBlocked(path)
        || getEditorTexts(path).some((text) => digest(Buffer.from(text, "utf8")) !== expectedHash));
    },
    async read(path) {
      validate(path);
      if (!await adapter.exists(path)) return null;
      try { return new Uint8Array(await adapter.readBinary(path)); }
      catch (error) {
        if (["ENOENT", "ENOTDIR"].includes(error.code) && !await adapter.exists(path)) return null;
        throw error;
      }
    },
    async write(path, bytes) {
      validate(path);
      await ensureParents(path);
      if (internal(path) && path.endsWith(".json")) {
        if (!basePath && typeof adapter.rename !== "function") throw new Error("当前文库不支持安全保存同步状态。");
        const temporary = `${path}.tmp-${randomBytes(6).toString("hex")}`;
        try {
          await adapter.writeBinary(temporary, arrayBuffer(bytes));
          validate(path);
          // FileSystemAdapter.rename rejects existing destinations. Native
          // same-directory rename atomically replaces only our private JSON.
          if (basePath) await fs.promises.rename(nodePath.join(basePath, temporary), nodePath.join(basePath, path));
          else await adapter.rename(temporary, path);
        } finally {
          try { if (await adapter.exists(temporary)) await adapter.remove(temporary); }
          catch { /* A leftover temporary file is never read as committed state. */ }
        }
        return;
      }
      const file = vault.getAbstractFileByPath?.(path);
      if (!internal(path) && file && vault.modifyBinary) {
        await vault.modifyBinary(file, arrayBuffer(bytes));
      } else if (!internal(path) && !await adapter.exists(path) && vault.createBinary) {
        await vault.createBinary(path, arrayBuffer(bytes));
      } else {
        await adapter.writeBinary(path, arrayBuffer(bytes));
      }
    },
    async remove(path, guard = () => true) {
      validate(path);
      if (!await adapter.exists(path)) return;
      const file = vault.getAbstractFileByPath?.(path);
      if (!guard()) return false;
      if (!internal(path) && file && vault.trash) await vault.trash(file, true);
      else await adapter.remove(path);
      return true;
    },
    async removeLegacyBaseCache() {
      const directory = `${stateRoot}bases`;
      const prefix = `${directory}/`;
      validate(directory);
      if (!await adapter.exists(directory)) return 0;
      const listing = await adapter.list(directory);
      if (!Array.isArray(listing?.files)) throw new Error("旧正文缓存目录格式无效。");
      const obsolete = [];
      for (const path of listing.files) {
        if (typeof path !== "string" || !path.startsWith(prefix) || path.slice(prefix.length).includes("/")) {
          throw new Error("旧正文缓存包含不安全的文件路径。");
        }
        if (/^[a-f0-9]{64}\.bin$/.test(path.slice(prefix.length))) {
          validate(path);
          obsolete.push(path);
        }
      }
      let removed = 0;
      for (const path of obsolete) if (await storage.remove(path)) removed += 1;
      return removed;
    },
    async compareAndWrite(path, expectedHash, bytes) {
      validate(path);
      const editorsUnchanged = () => !isWriteBlocked(path)
        && getEditorTexts(path).every((text) => digest(Buffer.from(text, "utf8")) === expectedHash);
      if (!internal(path) && !editorsUnchanged()) return false;
      const file = vault.getAbstractFileByPath?.(path);
      if (!internal(path) && file && isTextPath(path) && bytes !== null && expectedHash !== null && vault.process) {
        let accepted = false;
        const replacement = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
        await vault.process(file, (text) => {
          if (!editorsUnchanged() || digest(Buffer.from(text, "utf8")) !== expectedHash) return text;
          accepted = true;
          return replacement;
        });
        return accepted;
      }
      if (digest(await storage.read(path)) !== expectedHash) return false;
      if (!internal(path) && !editorsUnchanged()) return false;
      if (bytes === null && expectedHash === null) return true;
      if (bytes === null) {
        // Do not remove a document that is open for typing, even if its
        // current editor contents happen to match the last saved baseline.
        const canRemove = () => internal(path) || (editorsUnchanged() && getEditorTexts(path).length === 0);
        if (!await storage.remove(path, canRemove)) return false;
      }
      else if (expectedHash === null && !internal(path) && vault.createBinary) {
        await ensureParents(path);
        try { await vault.createBinary(path, arrayBuffer(bytes)); }
        catch (error) {
          const alreadyExists = error.code === "EEXIST"
            || (!error.code && /^(?:File|Folder|Destination) already exists(?:[.!]|:.*)?$/i.test(error.message || ""));
          if (alreadyExists && await adapter.exists(path)) return false;
          throw error;
        }
      } else await storage.write(path, bytes);
      return true;
    },
  };
  return storage;
};

module.exports = { createProjectTransport, createVaultSyncStorage };
