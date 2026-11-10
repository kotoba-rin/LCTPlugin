const { createHash } = require("crypto");

const DEFAULT_PROJECT_ENDPOINT = "https://kotoba-rin.com/wp-json/lctp/v1/project";
const CONTENT_ROOTS = new Set(["texts", "知识库", "术语表", "assets"]);
const ROOT_FILES = new Set(["README.md", "LICENSE", "LICENSE.md", "NOTICE.md"]);
const EXTENSIONS = new Set(["md", "jpeg", "jpg", "png", "gif", "svg", "webp", "avif", "bmp", "tif", "tiff", "emf", "wmf", "pdf", "csv", "txt"]);
const HASH_RE = /^[a-f0-9]{64}$/;
const VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const MAX_FILES = 25000;
const MAX_TOTAL_BYTES = 512 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;
const MAX_FILE_BYTES = 64 * 1024 * 1024;

const asBytes = (value) => {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  throw new Error("同步下载没有返回二进制文件。");
};
const sha256 = (value) => createHash("sha256").update(asBytes(value)).digest("hex");
const encodeJson = (value) => Buffer.from(JSON.stringify(value, null, 2));
const parseJson = (value, label) => {
  try { return JSON.parse(Buffer.from(asBytes(value)).toString("utf8")); }
  catch { throw new Error(`${label}不是有效的 JSON。`); }
};
const validateVersion = (value) => {
  if (typeof value !== "string" || !VERSION_RE.test(value)) throw new Error("无效的文库版本号。");
  return value;
};
const validateContentPath = (value) => {
  if (typeof value !== "string" || !value || value.length > 700 || value.includes("\\") || value.normalize("NFC") !== value) throw new Error("无效的文库文件路径。");
  const parts = value.split("/");
  for (const part of parts) {
    if (!part || part.startsWith(".") || /[<>:"|?*\x00-\x1f]/.test(part) || /[ .]$/.test(part)
      || /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(part)) {
      throw new Error(`不安全的文库文件路径：${value}`);
    }
  }
  if (parts.length === 1 && ROOT_FILES.has(value)) return value;
  if (parts.length < 2 || !CONTENT_ROOTS.has(parts[0]) || !EXTENSIONS.has(value.split(".").pop().toLowerCase())) {
    throw new Error(`同步清单包含未授权文件：${value}`);
  }
  return value;
};
const validateUrl = (value, endpointUrl) => {
  if (typeof value !== "string" || !value.trim()) throw new Error("缺少文库下载地址。");
  let endpoint;
  let url;
  try { endpoint = new URL(endpointUrl); url = new URL(value, endpointUrl); }
  catch { throw new Error("无效的文库下载地址。"); }
  const localHttp = url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((!localHttp && url.protocol !== "https:") || url.origin !== endpoint.origin || url.username || url.password || url.hash) {
    throw new Error("文库下载地址必须与同步接口同源，并使用 HTTPS。");
  }
  return url.href;
};
const isKnowledgePath = (path) => typeof path === "string" && /^知识库\/.+\.md$/i.test(path)
  && !/(?:^|\/)README\.md$/i.test(path);
const validateKnowledgeEntries = (value, files) => {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > MAX_FILES) throw new Error("知识库目录格式或数量无效。");
  const published = new Map(files.map((file) => [file.path, file]));
  const seen = new Set();
  const field = (text, limit, required = false) => {
    if (typeof text !== "string" || [...text].length > limit || (required && !text.trim()) || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text)) {
      throw new Error("知识库目录字段无效或超出长度限制。");
    }
    return text;
  };
  const list = (items, count, length) => {
    if (!Array.isArray(items) || items.length > count) throw new Error("知识库目录列表无效或超出数量限制。");
    return [...new Set(items.map((item) => field(item, length, true)))];
  };
  return value.map((entry) => {
    const path = validateContentPath(entry?.path);
    if (!isKnowledgePath(path) || !published.has(path) || published.get(path).size === 0 || seen.has(path)) throw new Error(`知识库目录路径无效或重复：${path}`);
    seen.add(path);
    return { path, title: field(entry.title, 300, true), tags: list(entry.tags, 64, 160), excerpt: field(entry.excerpt, 120),
      ...(entry.aliases === undefined ? {} : { aliases: list(entry.aliases, 32, 300) }) };
  });
};
const validateLatest = (value, endpointUrl) => {
  if (value?.schema_version !== 1 || !HASH_RE.test(value.manifest_sha256 || "")) throw new Error("不支持的文库版本清单。");
  validateVersion(value.version);
  if (!Number.isSafeInteger(value.file_count) || value.file_count < 1 || value.file_count > MAX_FILES) throw new Error("文库文件数量超出限制。");
  const latest = { ...value, manifest_url: validateUrl(value.manifest_url, endpointUrl) };
  if (value.archive_url) {
    if (!HASH_RE.test(value.archive_sha256 || "") || !Number.isSafeInteger(value.archive_size) || value.archive_size < 1 || value.archive_size > MAX_ARCHIVE_BYTES) {
      throw new Error("完整文库下载包超出限制或缺少校验值。");
    }
    latest.archive_url = validateUrl(value.archive_url, endpointUrl);
  }
  return latest;
};
const validateManifest = (value, latest, endpointUrl) => {
  if (value?.schema_version !== 1 || value.version !== latest.version || !Array.isArray(value.files) || value.files.length !== latest.file_count) {
    throw new Error("文库文件清单与发布版本不一致。");
  }
  let total = 0;
  const names = new Map();
  const files = value.files.map((file) => {
    const path = validateContentPath(file?.path);
    const key = path.normalize("NFC").toLocaleLowerCase("en-US");
    if (names.has(key)) throw new Error(`文库路径重复或在 Windows 上冲突：${path}`);
    names.set(key, path);
    if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > MAX_FILE_BYTES || !HASH_RE.test(file.sha256 || "")) throw new Error(`文件校验信息无效：${path}`);
    total += file.size;
    if (total > MAX_TOTAL_BYTES) throw new Error("文库解压大小超出限制。");
    return { path, size: file.size, sha256: file.sha256, url: validateUrl(file.url, endpointUrl) };
  });
  const directorySpellings = new Map();
  for (const [key, path] of names.entries()) {
    const parts = key.split("/");
    const originalParts = path.split("/");
    for (let i = 1; i < parts.length; i += 1) {
      if (names.has(parts.slice(0, i).join("/"))) throw new Error("文库清单包含文件与目录路径冲突。");
      const directoryKey = parts.slice(0, i).join("/");
      const spelling = originalParts.slice(0, i).join("/");
      if (directorySpellings.has(directoryKey) && directorySpellings.get(directoryKey) !== spelling) throw new Error("文库目录大小写在 Windows 上冲突。");
      directorySpellings.set(directoryKey, spelling);
    }
  }
  const knowledgeEntries = validateKnowledgeEntries(value.knowledge_entries, files);
  return { ...value, files, total_size: total, ...(knowledgeEntries === undefined ? {} : { knowledge_entries: knowledgeEntries }) };
};

module.exports = { DEFAULT_PROJECT_ENDPOINT, HASH_RE, MAX_ARCHIVE_BYTES, asBytes, sha256, encodeJson, parseJson, validateVersion, validateContentPath, validateUrl, validateLatest, validateManifest, isKnowledgePath, validateKnowledgeEntries };
