const DICTIONARY_ORIGIN = "https://www.frdic.com";
const OPEN_API_ORIGIN = "https://api.frdic.com";
const SOURCE_LABEL = "法语助手在线词典";
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_LIMIT = 80;
const MAX_DEFINITION_LENGTH = 2000;

class FrenchDictionaryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "FrenchDictionaryError";
    this.code = code;
  }
}

function normalizeFrenchQuery(value) {
  const query = String(value || "")
    .normalize("NFC")
    .trim()
    .replace(/^[\s«»“”".,;:!?()[\]{}<>]+|[\s«»“”".,;:!?()[\]{}<>]+$/g, "")
    .replace(/[\u2010-\u2011]/g, "-")
    .replace(/\s+/g, " ");
  if (!query || query.length > 80 || !/\p{Script=Latin}/u.test(query) || !/^[\p{Script=Latin}\p{M}'’ʼ -]+$/u.test(query)) {
    throw new FrenchDictionaryError("INVALID_QUERY", "请选择一个法语单词或短语（最多 80 个字符）。");
  }
  return query;
}

function normalizeWordbookId(value) {
  const category = String(value ?? "").trim();
  if (!category || category.length > 128 || !/^[\w:-]+$/.test(category)) {
    throw new FrenchDictionaryError("INVALID_WORDBOOK", "请选择有效的法语生词本。");
  }
  return category;
}

function dictionaryUrl(word) {
  return `${DICTIONARY_ORIGIN}/dicts/fr/${encodeURIComponent(word)}`;
}

function defaultParseHtml(html) {
  if (typeof DOMParser === "undefined") {
    throw new FrenchDictionaryError("PARSE_UNAVAILABLE", "当前环境无法解析在线词典。");
  }
  return new DOMParser().parseFromString(html, "text/html");
}

function imageAttribute(tag, name) {
  const match = tag.match(new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  return match ? match[1] ?? match[2] ?? match[3] ?? "" : "";
}

function safeGlyph(tag) {
  if (!imageAttribute(tag, "class").split(/\s+/).includes("dictimgtoword")) return null;
  try {
    const url = new URL(imageAttribute(tag, "src"), DICTIONARY_ORIGIN);
    if (url.origin !== DICTIONARY_ORIGIN || url.username || url.password || url.search || url.hash
      || !/^\/tmp\/wordimg\/[A-Za-z0-9@=_+\-]{1,128}\.png$/.test(url.pathname)) return null;
    const dimension = (name) => {
      const value = imageAttribute(tag, name);
      return /^\d{1,3}$/.test(value) && Number(value) > 0 && Number(value) <= 128 ? Number(value) : null;
    };
    return { src: url.href, width: dimension("width"), height: dimension("height"), alt: "词典字图" };
  } catch {
    return null;
  }
}

function inertHtml(html) {
  // This document is only read, never mounted. Drop executable/loading elements
  // before DOMParser. Only known dictionary glyph URLs become structured images;
  // the UI constructs those images itself instead of receiving server HTML.
  const glyphs = [];
  const bySource = new Map();
  let markerPrefix = "〔法助字图:";
  while (html.includes(markerPrefix)) markerPrefix += "_";
  const prepared = html
    .replace(/<(script|style|noscript|iframe|object)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<img\b[^>]*>/gi, (tag) => {
      const glyph = safeGlyph(tag);
      if (!glyph) return '<span data-french-dictionary-image="true">〔图文〕</span>';
      const key = `${glyph.src}|${glyph.width}|${glyph.height}`;
      if (!bySource.has(key)) {
        const item = { marker: `${markerPrefix}${glyphs.length}〕`, ...glyph };
        bySource.set(key, item);
        glyphs.push(item);
      }
      return `<span data-french-dictionary-glyph="true">${bySource.get(key).marker}</span>`;
    })
    .replace(/<\/?(?:link|base|embed|source|audio|video|iframe|object)\b[^>]*>/gi, "")
    .replace(/\s(?:src|srcset|poster|background|style)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "");
  return { html: prepared, glyphs, markerPrefix };
}

function plainText(node, { skipGrammar = false, skipExamples = false } = {}) {
  if (!node) return "";
  if (node.nodeType === 3) return node.nodeValue || node.textContent || "";
  const tag = String(node.tagName || "").toUpperCase();
  if (["SCRIPT", "STYLE", "NOSCRIPT", "IFRAME", "OBJECT"].includes(tag)) return "";
  const classes = String(node.getAttribute?.("class") || "").split(/\s+/);
  if (skipGrammar && classes.some((name) => ["cara", "syno"].includes(name))) return "";
  if (skipExamples && classes.some((name) => ["eg", "example"].includes(name))) return "";
  if (tag === "BR") return "\n";
  const text = Array.from(node.childNodes || [], (child) => plainText(child, { skipGrammar, skipExamples })).join("");
  return ["DIV", "P", "LI", "UL", "OL", "SECTION"].includes(tag) ? `\n${text}\n` : text;
}

function cleanLine(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function suggestionsFrom(document) {
  const suggestions = [];
  for (const anchor of document.querySelectorAll(".suggestion-list a, .spellHint a")) {
    const headword = cleanLine(plainText(anchor));
    const href = anchor.getAttribute("href") || "";
    try {
      const url = new URL(href, DICTIONARY_ORIGIN);
      if (url.origin !== DICTIONARY_ORIGIN || !/^\/dicts\/(?:fr|search)\//i.test(url.pathname)) continue;
      normalizeFrenchQuery(headword);
      if (!suggestions.some((item) => item.headword === headword)) {
        suggestions.push({ headword, sourceUrl: url.href });
      }
    } catch {
      // Ignore unrelated or malformed links instead of widening the source.
    }
    if (suggestions.length === 8) break;
  }
  return suggestions;
}

function parseFrenchDictionaryHtml(html, query, parseHtml = defaultParseHtml) {
  const normalized = normalizeFrenchQuery(query);
  if (typeof html !== "string" || !html.trim() || html.length > 2_000_000) {
    throw new FrenchDictionaryError("BAD_RESPONSE", "在线词典返回了无法识别的数据。");
  }
  const prepared = inertHtml(html);
  const document = parseHtml(prepared.html);
  if (!document?.querySelector || !document?.querySelectorAll) {
    throw new FrenchDictionaryError("BAD_RESPONSE", "在线词典返回了无法识别的数据。");
  }
  const entry = document.querySelector("#ExpFCchild, #ExpFCChild");
  const suggestions = suggestionsFrom(document);
  if (!entry && !suggestions.length) {
    const visibleText = plainText(document.querySelector("body") || document);
    if (/(安全验证|人机验证|请输入验证码|访问过于频繁|验证您是真人|checking your browser|verify you are human|captcha challenge|access denied)/i.test(visibleText)) {
      throw new FrenchDictionaryError("ACCESS_RESTRICTED", "在线词典暂时限制访问，请打开原站查看。");
    }
    throw new FrenchDictionaryError("NOT_FOUND", "法语助手在线词典未找到该词。");
  }
  const grammar = entry
    ? Array.from(entry.querySelectorAll(".cara, .syno"), (node) => cleanLine(plainText(node))).filter(Boolean)
    : ["原站提供多个匹配词条，请选择。"];
  const headword = cleanLine(plainText(document.querySelector(".explain-Word .word"))) || normalized;
  if (headword.toLocaleLowerCase("fr") !== normalized.toLocaleLowerCase("fr")) {
    grammar.unshift(`原站匹配词头：${headword}（查询：${normalized}）`);
  }
  const spellingHint = cleanLine(plainText(document.querySelector(".spellHint")));
  if (spellingHint) grammar.push(spellingHint);
  const definitionText = entry
    ? plainText(entry, { skipGrammar: true, skipExamples: true })
    : Array.from(document.querySelectorAll(".suggestion-list li"), (node) => cleanLine(plainText(node))).join("\n");
  const lines = definitionText
    .replace(/法\s*语\s*助\s*手\s*版\s*权\s*所\s*有[\s\S]*$/, "")
    .split(/\n+/)
    .map(cleanLine)
    .filter(Boolean);
  const definitions = [];
  let length = 0;
  let truncated = false;
  for (const line of [...new Set(lines)]) {
    const remaining = MAX_DEFINITION_LENGTH - length;
    if (remaining <= 0) { truncated = true; break; }
    let clipped = line.slice(0, remaining);
    const markerStart = clipped.lastIndexOf(prepared.markerPrefix);
    if (markerStart >= 0 && !clipped.slice(markerStart).includes("〕")) clipped = clipped.slice(0, markerStart);
    definitions.push(clipped);
    length += clipped.length;
    if (line.length > remaining) { truncated = true; break; }
  }
  const visibleDefinitions = definitions.join("\n");
  const glyphs = prepared.glyphs.filter((glyph) => visibleDefinitions.includes(glyph.marker));
  const partial = truncated || visibleDefinitions.includes("〔图文〕");
  return {
    query: normalized,
    headword,
    phonetic: cleanLine(plainText(document.querySelector(".Phonitic, .phonitic, .Phonetic"))),
    definitions,
    glyphs,
    grammar: [...new Set(grammar)].slice(0, 12),
    suggestions,
    ambiguous: !entry && suggestions.length > 0,
    partial,
    truncated,
    sourceUrl: dictionaryUrl(normalized),
    source: SOURCE_LABEL,
  };
}

function copyEntry(entry) {
  return { ...entry, definitions: [...entry.definitions], glyphs: entry.glyphs.map((item) => ({ ...item })), grammar: [...entry.grammar], suggestions: entry.suggestions.map((item) => ({ ...item })) };
}

class FrenchDictionaryService {
  constructor({ requestUrl, getToken = async () => "", parseHtml = defaultParseHtml, now = Date.now }) {
    this.requestUrl = requestUrl;
    this.getToken = getToken;
    this.parseHtml = parseHtml;
    this.now = now;
    this.cache = new Map();
  }

  async request(options, kind, { allowNotFound = false } = {}) {
    let timeout;
    try {
      const response = await Promise.race([
        this.requestUrl({ ...options, throw: false }),
        new Promise((_, reject) => {
          timeout = setTimeout(() => reject(new Error("timeout")), 15_000);
        }),
      ]);
      const status = Number(response?.status);
      if (status >= 200 && status < 300) return response;
      if (kind === "api" && allowNotFound && status === 404) return response;
      if (kind === "api" && status === 401) {
        throw new FrenchDictionaryError("AUTH_REQUIRED", "欧路 API Token 无效或已过期，请检查插件设置。");
      }
      if ([403, 429].includes(status)) {
        throw new FrenchDictionaryError("ACCESS_RESTRICTED", kind === "api" ? "欧路服务暂时限制访问，请稍后再试。" : "在线词典暂时限制访问，请打开原站查看。");
      }
      if (kind === "dictionary" && status === 404) {
        throw new FrenchDictionaryError("NOT_FOUND", "法语助手在线词典未找到该词。");
      }
      throw new FrenchDictionaryError("SERVICE_ERROR", kind === "api" ? "欧路 API 请求失败，请稍后再试。" : "在线词典请求失败，请稍后再试。");
    } catch (error) {
      if (error instanceof FrenchDictionaryError) throw error;
      throw new FrenchDictionaryError("NETWORK_ERROR", kind === "api" ? "暂时无法连接欧路 API，请检查网络。" : "暂时无法连接在线词典，请检查网络。");
    } finally {
      clearTimeout(timeout);
    }
  }

  async lookup(value) {
    const query = normalizeFrenchQuery(value);
    const cached = this.cache.get(query);
    if (cached && this.now() - cached.time < CACHE_TTL_MS) return copyEntry(cached.entry);
    this.cache.delete(query);
    const response = await this.request({ url: dictionaryUrl(query), method: "GET" }, "dictionary");
    let entry;
    try {
      entry = parseFrenchDictionaryHtml(response.text, query, this.parseHtml);
    } catch (error) {
      if (error instanceof FrenchDictionaryError) throw error;
      throw new FrenchDictionaryError("BAD_RESPONSE", "在线词典返回了无法识别的数据。");
    }
    this.cache.set(query, { time: this.now(), entry });
    while (this.cache.size > CACHE_LIMIT) this.cache.delete(this.cache.keys().next().value);
    return copyEntry(entry);
  }

  async authorizedRequest(path, method, body, { allowNotFound = false } = {}) {
    let token;
    try { token = String(await this.getToken() || "").trim(); } catch {
      throw new FrenchDictionaryError("AUTH_REQUIRED", "无法读取欧路 API Token，请检查插件设置。");
    }
    if (!token) throw new FrenchDictionaryError("AUTH_REQUIRED", "请先在插件设置中填写欧路 API Token。");
    if (/[\r\n]/.test(token) || token.length > 4096) {
      throw new FrenchDictionaryError("AUTH_REQUIRED", "欧路 API Token 格式不正确，请检查插件设置。");
    }
    const response = await this.request({
      url: `${OPEN_API_ORIGIN}/api/open/v1${path}`,
      method,
      headers: { Authorization: /^NIS/i.test(token) ? token : `NIS ${token}`, "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }, "api", { allowNotFound });
    if (allowNotFound && Number(response.status) === 404) return null;
    if (response.status === 204) return {};
    try {
      const data = response.json ?? JSON.parse(response.text);
      if (!data || typeof data !== "object") throw new Error("invalid JSON");
      return data;
    } catch {
      throw new FrenchDictionaryError("BAD_RESPONSE", "欧路 API 返回了无法识别的数据。");
    }
  }

  async listWordbooks() {
    const result = await this.authorizedRequest("/studylist/category?language=fr", "GET");
    if (!Array.isArray(result.data)) {
      throw new FrenchDictionaryError("BAD_RESPONSE", "欧路 API 返回了无法识别的生词本列表。");
    }
    return result.data.filter((item) => item && ["string", "number"].includes(typeof item.id))
      .map((item) => ({ id: String(item.id), name: String(item.name || "未命名生词本") }));
  }

  async addWord(value, categoryId = "0") {
    const word = normalizeFrenchQuery(value);
    const category = normalizeWordbookId(categoryId);
    await this.authorizedRequest("/studylist/words", "POST", {
      language: "fr", category_id: category, items: [{ word, star: 1 }],
    });
    return { ok: true, message: "已加入法语生词本。" };
  }

  async isWordInWordbook(value, categoryId = "0") {
    const word = normalizeFrenchQuery(value);
    const category = normalizeWordbookId(categoryId);
    const params = new URLSearchParams({ language: "fr", word });
    const result = await this.authorizedRequest(`/studylist/word?${params}`, "GET", undefined, { allowNotFound: true });
    if (result === null) return false;
    // The official example is a top-level word object; its field table also
    // describes a data wrapper. Read either form without caching account state.
    const data = Object.hasOwn(result, "data") ? result.data : result;
    if (data === null || (Array.isArray(data) && data.length === 0)) return false;
    const entries = Array.isArray(data) ? data : [data];
    const invalidResponse = () => new FrenchDictionaryError("BAD_RESPONSE", "欧路 API 返回了无法识别的生词状态。");
    for (const entry of entries) {
      if (!entry || typeof entry.word !== "string"
        || entry.word.normalize("NFC").trim().toLocaleLowerCase("fr") !== word.toLocaleLowerCase("fr")
        || !Number.isInteger(entry.star) || entry.star < 0 || entry.star > 5
        || !Array.isArray(entry.category_ids)) throw invalidResponse();
      try {
        for (const id of entry.category_ids) {
          if (!["string", "number"].includes(typeof id) || (typeof id === "number" && !Number.isFinite(id))) throw invalidResponse();
          normalizeWordbookId(id);
        }
      } catch {
        throw invalidResponse();
      }
    }
    return entries.some((entry) => entry.star > 0 && entry.category_ids.some((id) => String(id).trim() === category));
  }
}

module.exports = { FrenchDictionaryService, FrenchDictionaryError, parseFrenchDictionaryHtml, normalizeFrenchQuery };
