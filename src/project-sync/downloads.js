const { Unzip, UnzipInflate } = require("fflate");
const { asBytes, sha256, validateContentPath, MAX_ARCHIVE_BYTES } = require("./validation");

const checkCancelled = (signal) => {
  if (signal?.aborted) {
    const error = new Error("文库同步已取消。");
    error.name = "AbortError";
    throw error;
  }
};
const fetchBytes = async (transport, url, { signal, maxBytes }) => {
  checkCancelled(signal);
  const result = asBytes(await transport(url, { signal, maxBytes }));
  checkCancelled(signal);
  if (result.byteLength > maxBytes) throw new Error("文库下载超出大小限制。");
  return result;
};
const verifyFile = (bytes, file) => {
  if (bytes.byteLength !== file.size || sha256(bytes) !== file.sha256) throw new Error(`文件校验失败：${file.path}`);
  return bytes;
};
const unpackArchive = async (bytes, files, signal) => {
  checkCancelled(signal);
  bytes = asBytes(bytes);
  if (bytes.byteLength > MAX_ARCHIVE_BYTES) throw new Error("完整文库下载包超出大小限制。");
  const expected = new Map(files.map((file) => [file.path, file]));
  const totalExpected = files.reduce((total, file) => {
    validateContentPath(file.path);
    if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > 64 * 1024 * 1024) throw new Error("下载包的文件大小超出限制。");
    return total + file.size;
  }, 0);
  if (expected.size !== files.length || totalExpected > 512 * 1024 * 1024) throw new Error("完整文库解压大小超出限制。");
  const seen = new Set();
  const completed = new Set();
  const active = new Set();
  const result = Object.create(null);
  let totalOutput = 0;
  const stream = new Unzip((entry) => {
    checkCancelled(signal);
    validateContentPath(entry.name);
    const file = expected.get(entry.name);
    if (!file || seen.has(entry.name) || (entry.originalSize !== undefined && entry.originalSize !== file.size)
      || (entry.size !== undefined && entry.size > bytes.byteLength)) throw new Error(`下载包中的文件不符合清单：${entry.name}`);
    seen.add(entry.name);
    active.add(entry);
    const output = new Uint8Array(file.size);
    let written = 0;
    entry.ondata = (error, chunk, final) => {
      checkCancelled(signal);
      if (error) throw error;
      if (written + chunk.byteLength > file.size || totalOutput + chunk.byteLength > totalExpected) throw new Error(`下载包解压大小超出清单：${file.path}`);
      output.set(chunk, written);
      written += chunk.byteLength;
      totalOutput += chunk.byteLength;
      if (final) {
        if (written !== file.size) throw new Error(`下载包文件长度错误：${file.path}`);
        result[file.path] = verifyFile(output, file);
        completed.add(file.path);
        active.delete(entry);
      }
    };
    entry.start();
  });
  // Electron's embedded Node can expose worker_threads while disallowing
  // Worker construction. Only register the synchronous streaming decoder;
  // yielding between input chunks keeps Obsidian responsive without workers.
  stream.register(UnzipInflate);
  try {
    const chunkSize = 64 * 1024;
    for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
      checkCancelled(signal);
      const end = Math.min(offset + chunkSize, bytes.byteLength);
      stream.push(bytes.subarray(offset, end), end === bytes.byteLength);
      if (end < bytes.byteLength) await new Promise((resolve) => setTimeout(resolve, 0));
    }
    checkCancelled(signal);
    if (seen.size !== expected.size || completed.size !== expected.size || totalOutput !== totalExpected) throw new Error("完整下载包缺少清单中的文件。");
    return result;
  } finally {
    for (const entry of active) entry.terminate();
  }
};

const downloadArchive = async (transport, latest, files, signal) => {
  const archive = await fetchBytes(transport, latest.archive_url, { signal, maxBytes: Math.min(MAX_ARCHIVE_BYTES, latest.archive_size) });
  if (archive.byteLength !== latest.archive_size || sha256(archive) !== latest.archive_sha256) throw new Error("完整文库下载包校验失败。");
  return unpackArchive(archive, files, signal);
};

module.exports = { checkCancelled, fetchBytes, verifyFile, unpackArchive, downloadArchive };
