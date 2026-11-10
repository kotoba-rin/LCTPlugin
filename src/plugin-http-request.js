const { randomBytes } = require("crypto");

const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 256 * 1024 * 1024;
const abortError = () => Object.assign(new Error("插件网络请求已取消。"), { name: "AbortError" });
const checkResponseSize = (headers, maxBytes) => {
  const declared = Object.entries(headers || {}).find(([key]) => key.toLowerCase() === "content-length")?.[1];
  if (Number(declared) > maxBytes) throw new Error("插件网络响应超出允许的大小。");
};

const normalizeProxyUrl = (value) => {
  const input = String(value || "").trim();
  let url;
  try { url = new URL(input); }
  catch { throw new Error("请填写有效的 HTTP 代理地址，例如 http://127.0.0.1:7890。"); }
  if (!/^https?:\/\/[^\s/?#\\]+\/?$/i.test(input)
    || !["http:", "https:"].includes(url.protocol) || !url.hostname
    || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("代理地址仅支持 HTTP 或 HTTPS 主机和端口，不能包含账号、密码、路径或查询参数。");
  }
  return `${url.protocol}//${url.hostname}:${url.port || (url.protocol === "https:" ? "443" : "80")}`;
};

const makeResponse = (status, rawHeaders, bytes) => {
  const headers = {};
  for (const [key, value] of Object.entries(rawHeaders || {})) {
    headers[key.toLowerCase()] = Array.isArray(value) ? value.join(", ") : String(value);
  }
  const response = { status, headers };
  let arrayBuffer;
  let text;
  let json;
  let parsed = false;
  Object.defineProperties(response, {
    arrayBuffer: { enumerable: true, get: () => arrayBuffer ??= bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
      ? bytes.buffer : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) },
    text: { enumerable: true, get: () => text ??= bytes.toString("utf8") },
    json: { enumerable: true, get: () => {
      if (!parsed) { json = JSON.parse(response.text); parsed = true; }
      return json;
    } },
  });
  return response;
};

const requestBody = (body) => {
  if (body === undefined || body === null || typeof body === "string") return body;
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  throw new Error("网络请求正文必须为文本或二进制数据。");
};

const createPluginRequest = ({ requestUrl, getSettings, getElectron = () => require("electron").remote, requestTimeoutMs = 300000 }) => {
  const sessions = new Map();
  const active = new Set();
  const partitionPrefix = `lacan-translation-helper-http-${randomBytes(12).toString("hex")}`;
  const timeoutMs = Number.isFinite(requestTimeoutMs) && requestTimeoutMs > 0 ? requestTimeoutMs : 300000;
  let nextPartition = 0;
  let disposed = false;

  const getSession = (proxyRules) => {
    if (sessions.has(proxyRules)) return sessions.get(proxyRules).ready;
    const entry = {};
    entry.ready = Promise.resolve().then(async () => {
      if (disposed) throw new Error("插件网络请求已关闭。");
      const electron = getElectron();
      if (!electron?.session?.fromPartition || !electron?.net?.request) {
        throw new Error("当前 Obsidian 不支持插件 HTTP 代理，请使用桌面端。");
      }
      // Each configuration owns an immutable in-memory session, so changing
      // the proxy cannot reroute requests already using another configuration.
      entry.session = electron.session.fromPartition(`${partitionPrefix}-${++nextPartition}`, { cache: false });
      await entry.session.setProxy({ mode: "fixed_servers", proxyRules, proxyBypassRules: "<-loopback>" });
      if (disposed) throw new Error("插件网络请求已关闭。");
      return { electron, session: entry.session };
    }).catch((error) => {
      if (sessions.get(proxyRules) === entry) sessions.delete(proxyRules);
      Promise.resolve().then(() => entry.session?.closeAllConnections?.()).catch(() => {});
      throw error;
    });
    sessions.set(proxyRules, entry);
    return entry.ready;
  };

  const pluginRequest = async (input, { signal, maxBytes = DEFAULT_MAX_BYTES } = {}) => {
    if (disposed) throw new Error("插件网络请求已关闭。");
    if (signal?.aborted) throw abortError();
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > MAX_RESPONSE_BYTES) {
      throw new Error("插件网络响应大小限制无效。");
    }
    const settings = getSettings() || {};
    if (!settings.pluginHttpProxyEnabled) {
      // The host buffers its own response and has no cancellable streaming API.
      // Keep its network settings and original request options intact.
      const response = await requestUrl(input);
      if (signal?.aborted) throw abortError();
      checkResponseSize(response.headers, maxBytes);
      if (response.arrayBuffer?.byteLength > maxBytes) throw new Error("插件网络响应超出允许的大小。");
      return response;
    }
    const proxyRules = normalizeProxyUrl(settings.pluginHttpProxyUrl);
    const options = typeof input === "string" ? { url: input } : input;
    if (!options || typeof options.url !== "string" || !/^https?:\/\//i.test(options.url)) {
      throw new Error("插件代理仅支持 HTTP 或 HTTPS 请求。");
    }
    const headers = { ...options.headers };
    if (options.contentType && !Object.keys(headers).some((key) => key.toLowerCase() === "content-type")) {
      headers["Content-Type"] = options.contentType;
    }
    const body = requestBody(options.body);
    return new Promise((resolve, reject) => {
      let request;
      let response;
      let chunks = [];
      let receivedBytes = 0;
      let settled = false;
      let timer;
      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", cancel);
        active.delete(cancel);
        response?.removeListener?.("data", onData);
        response?.removeListener?.("end", onEnd);
        chunks = [];
        if (error) {
          // Keep error listeners until native close; abort can emit an error.
          try { request?.abort(); } catch { /* The request may already be closed. */ }
          reject(error);
        } else resolve(result);
      };
      const cancel = () => finish(abortError());
      const onData = (chunk) => {
        if (settled) return;
        try {
          const length = typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.byteLength;
          if (!Number.isSafeInteger(length) || length > maxBytes - receivedBytes) {
            throw new Error("插件网络响应超出允许的大小。");
          }
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          receivedBytes += length;
        }
        catch (error) { finish(error); }
      };
      const onEnd = () => {
        if (settled) return;
        try {
          const result = makeResponse(response.statusCode, response.headers, Buffer.concat(chunks, receivedBytes));
          if (options.throw !== false && result.status >= 400) {
            const error = new Error(`Request failed, status ${result.status}`);
            error.status = result.status;
            finish(error);
          } else finish(null, result);
        } catch (error) { finish(error); }
      };
      active.add(cancel);
      signal?.addEventListener("abort", cancel, { once: true });
      if (signal?.aborted) { cancel(); return; }
      timer = setTimeout(() => finish(new Error("插件代理请求超时，请检查代理连接后重试。")), timeoutMs);
      Promise.resolve().then(() => getSession(proxyRules)).then(({ electron, session }) => {
        if (settled) return;
        request = electron.net.request({
          url: options.url, method: options.method || "GET", headers,
          session, redirect: "follow", useSessionCookies: false,
        });
        request.on("error", (error) => finish(error));
        request.on("abort", () => finish(new Error("插件代理请求已中止。")));
        // Electron's remote bridge can deliver request close before response
        // callbacks. Completion is determined by response end or an error;
        // the timeout also bounds a closed connection with no response.
        request.on("login", (_authInfo, callback) => {
          callback();
          finish(new Error("代理要求身份认证，请使用无需认证的 HTTP 代理。"));
        });
        request.on("response", (incoming) => {
          if (settled) return;
          response = incoming;
          response.on("error", (error) => finish(error));
          response.on("aborted", () => finish(new Error("插件代理响应已中止。")));
          try { checkResponseSize(response.headers, maxBytes); }
          catch (error) { finish(error); return; }
          response.on("end", onEnd);
          response.on("data", onData);
        });
        if (body !== undefined && body !== null) request.write(body);
        if (!settled) request.end();
      }).catch((error) => finish(error));
    });
  };

  pluginRequest.dispose = async () => {
    disposed = true;
    for (const cancel of [...active]) cancel();
    await Promise.allSettled([...sessions.values()].map((entry) => Promise.resolve().then(() => entry.session?.closeAllConnections?.())));
    sessions.clear();
  };
  return pluginRequest;
};

module.exports = { createPluginRequest };
