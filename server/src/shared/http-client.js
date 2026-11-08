/**
 * 通用 HTTP 客户端 + SSRF 防护（shared，无业务依赖；/）。
 *
 * 安全要点：
 *  - 仅允许 http/https、禁止 userinfo；
 *  - validateTargetUrl 先解析 DNS 并拒绝私网/保留网段（APP_RULES_ALLOWED_HOSTS 白名单可放行）；
 *  - 真正建连时通过 node:http/https.request 的 `lookup` 把 IP 固定为已校验地址，
 *    避免“校验时解析 → 连接时再解析”的 DNS rebinding TOCTOU；
 *  - 重定向 manual 逐跳处理（最多 3 跳、禁止跨源、仅允许同主机 http→https 升级），
 *    每跳重新校验并重新固定 IP；
 *  - 超时覆盖响应头与 body 读取阶段；响应体流式大小上限；仅接受文本/JSON 响应；
 *  - fetch 自动解压 gzip/deflate/br，node:http 不自动解压，这里补上并限制解压后大小。
 */
import { promises as dnsPromises } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { Readable } from 'node:stream';
import zlib from 'node:zlib';

import { config } from '../config.js';
import { truncate } from './template.js';

const DIAGNOSTIC_RESPONSE_HEADERS = [
  'content-type',
  'x-ratelimit-type',
  'x-ratelimit-limit',
  'x-ratelimit-remaining',
  'ratelimit',
  'x-error-code',
  'retry-after',
  'x-request-id',
];

/** 从外部响应头中挑选诊断字段（不含 Set-Cookie 等敏感头），供测试运行展示。 */
export function pickDiagnosticHeaders(headers) {
  const source = headers && typeof headers === 'object' ? headers : {};
  const picked = {};
  for (const key of DIAGNOSTIC_RESPONSE_HEADERS) {
    const value = source[key];
    if (value !== undefined && value !== null && String(value) !== '') {
      picked[key] = truncate(String(value), 200);
    }
  }
  return picked;
}

// ---------------------------------------------------------------------------
// 可注入依赖（测试用；默认真实 node:http/https 传输 + dns + now）
//
// 注意：HTTP 传输必须走 httpRequest（而不是 fetch）——fetch/undici 会在内部重新解析
// DNS，无法在调用侧把连接地址固定为 validateTargetUrl 校验过的 IP（DNS rebinding）。
// ---------------------------------------------------------------------------
const defaultDeps = {
  dnsLookup: (hostname, options) => dnsPromises.lookup(hostname, options),
  httpRequest: defaultHttpRequest,
  now: () => Date.now(),
};
let deps = { ...defaultDeps };

/** 注入测试依赖（httpRequest/dnsLookup/now），未传字段保持不变。 */
export function configureDependencies(overrides = {}) {
  deps = { ...deps, ...overrides };
}

/** 恢复默认真实依赖。 */
export function resetDependencies() {
  deps = { ...defaultDeps };
}

// ---------------------------------------------------------------------------
// SSRF 防护
// ---------------------------------------------------------------------------

/** 判断 IP 是否属于私网/环回/链路本地/组播/保留地址。 */
export function isPrivateIp(ip) {
  const value = String(ip ?? '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  const version = net.isIP(value);
  if (version === 4) return isPrivateIpv4(value);
  if (version === 6) return isPrivateIpv6(value);
  return true; // 非法地址一律视为不可访问
}

function isPrivateIpv4(ip) {
  const parts = ip.split('.').map((part) => Number.parseInt(part, 10));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b, c] = parts;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 127) return true;
  if (a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a === 198 && b === 51 && c === 100) return true;
  if (a === 203 && b === 0 && c === 113) return true;
  if (a >= 224) return true;
  return false;
}

function isPrivateIpv6(ip) {
  const value = ip.toLowerCase();
  if (value === '::' || value === '::1') return true;
  if (value.startsWith('::ffff:')) {
    const mapped = value.slice('::ffff:'.length);
    if (net.isIP(mapped) === 4) return isPrivateIpv4(mapped);
    return true;
  }
  if (value.startsWith('fc') || value.startsWith('fd')) return true; // fc00::/7
  if (/^fe[89ab]/.test(value)) return true; // fe80::/10
  if (value.startsWith('ff')) return true; // ff00::/8
  if (value.startsWith('64:ff9b')) return true; // NAT64 保留
  if (value.startsWith('2001:db8')) return true; // 文档保留
  return false;
}

/** URL 解析 + SSRF 校验（DNS 解析所有地址；白名单主机允许私网）。 */
export async function validateTargetUrl(rawUrl, { allowedHosts = config.appRules.allowedHosts, dnsLookup = deps.dnsLookup } = {}) {
  let url;
  try {
    url = new URL(String(rawUrl));
  } catch {
    throw new Error('URL 格式非法');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('仅允许 http/https 协议');
  if (url.username || url.password) throw new Error('URL 不允许包含 userinfo（user:pass@）');
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!hostname) throw new Error('URL 缺少主机名');
  const allowed = (allowedHosts ?? []).map((host) => String(host).toLowerCase()).includes(hostname);
  const literalVersion = net.isIP(hostname);
  let addresses;
  if (literalVersion !== 0) {
    addresses = [hostname];
  } else {
    try {
      addresses = await dnsLookup(hostname, { all: true });
    } catch (err) {
      throw new Error(`域名解析失败：${err?.message ?? 'unknown'}`);
    }
  }
  const list = Array.isArray(addresses) ? addresses : [addresses];
  const validatedAddresses = [];
  for (const entry of list) {
    const ip = typeof entry === 'string' ? entry : entry?.address;
    if (!ip) continue;
    if (isPrivateIp(ip) && !allowed) {
      throw new Error(`目标地址位于私网/保留网段，已拒绝（SSRF）：${hostname} → ${ip}`);
    }
    const family = Number(typeof entry === 'object' ? entry?.family : 0) || net.isIP(ip);
    validatedAddresses.push({ address: String(ip), family });
  }
  if (validatedAddresses.length === 0) throw new Error(`域名解析失败：未返回有效地址（${hostname}）`);
  // addresses 是校验通过的地址列表；requestExternal 必须把连接固定到其中之一，
  // 不能在真正建连时再交给 HTTP 栈重新解析 DNS（DNS rebinding）。
  return { url, hostname, addresses: validatedAddresses };
}

/** 从校验通过的地址列表中挑选连接固定使用的 IP（优先 IPv4，避免 AAAA 不可达时无回退）。 */
function pickPinnedAddress(addresses) {
  const list = (Array.isArray(addresses) ? addresses : []).filter(
    (entry) => entry && net.isIP(String(entry.address ?? '')) !== 0,
  );
  if (list.length === 0) return null;
  return list.find((entry) => net.isIP(String(entry.address)) === 4) ?? list[0];
}

/**
 * 生成固定 DNS 解析结果的 lookup：连接层无论何时解析、DNS 记录如何变化，
 * 都只会拿到 validateTargetUrl 校验通过的那个 IP（DNS rebinding 的最后一道防线）。
 */
function createPinnedLookup(pinned) {
  const address = String(pinned.address);
  const family = Number(pinned.family) || net.isIP(address);
  return function pinnedLookup(hostname, options, callback) {
    const cb = typeof options === 'function' ? options : callback;
    if (typeof cb !== 'function') return;
    const lookupOptions = options && typeof options === 'object' ? options : {};
    if (lookupOptions.all) {
      cb(null, [{ address, family }]);
      return;
    }
    cb(null, address, family);
  };
}

/** 与 fetch/AbortController 错误形态保持一致：describeFetchError 依赖 name=AbortError 识别超时。 */
function createAbortError() {
  const err = new Error('This operation was aborted');
  err.name = 'AbortError';
  err.code = 'ABORT_ERR';
  return err;
}

/** 给 Promise 叠加 AbortSignal：超时后立即以 AbortError 拒绝（不依赖传输实现自身支持 signal）。 */
function abortable(promise, signal) {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(createAbortError());
      return;
    }
    const onAbort = () => reject(createAbortError());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
}

/**
 * 默认 HTTP 传输：node:http/https.request，并用 request options 的 `lookup`
 * 把连接地址固定为 validateTargetUrl 校验过的 IP 之后再建连。
 *
 * 返回 fetch Response 兼容结构（{status, statusText, headers, body}），
 * 以复用 readResponseBodyLimited 的流式大小限制/取消逻辑。
 */
export function defaultHttpRequest({ url, method = 'GET', headers = {}, body = '', signal, lookup }) {
  return new Promise((resolve, reject) => {
    let target;
    try {
      target = new URL(String(url));
    } catch {
      reject(new Error('URL 格式非法'));
      return;
    }
    const secure = target.protocol === 'https:';
    // URL.hostname 对 IPv6 会带方括号（如 [::1]），传给 http.request 前需去掉。
    const hostname = target.hostname.replace(/^\[|\]$/g, '');
    const port = target.port ? Number(target.port) : secure ? 443 : 80;
    const payload = method === 'GET' ? '' : String(body ?? '');
    const requestHeaders = {};
    for (const [key, value] of Object.entries(headers ?? {})) requestHeaders[key] = value;
    // Host 必须对应 URL 主机（含非默认端口）；连接目标是固定后的 IP，不能由调用方覆盖。
    for (const key of Object.keys(requestHeaders)) {
      const lower = key.toLowerCase();
      if (lower === 'host' || lower === 'content-length' || lower === 'transfer-encoding') delete requestHeaders[key];
    }
    requestHeaders.host = target.host;
    if (method !== 'GET') requestHeaders['content-length'] = Buffer.byteLength(payload);

    const requestOptions = {
      protocol: secure ? 'https:' : 'http:',
      hostname,
      port,
      path: `${target.pathname || '/'}${target.search}`,
      method,
      headers: requestHeaders,
      lookup, // 固定 DNS 解析结果的关键：http(s) 栈不会再自行解析
      agent: false, // 不复用 keep-alive 连接，避免固定 IP 的连接被后续请求复用
    };
    // TLS SNI 用域名而不是 IP（证书校验按 HTTPS 主机名进行）。
    if (secure && net.isIP(hostname) === 0) requestOptions.servername = hostname;

    let settled = false;
    let response = null;
    const onAbort = () => {
      const err = createAbortError();
      if (!settled) {
        settled = true;
        reject(err);
      }
      try {
        response?.destroy(err);
      } catch {
        /* 已销毁 */
      }
      try {
        req.destroy(err);
      } catch {
        /* 已销毁 */
      }
    };
    const transport = secure ? https : http;
    const req = transport.request(requestOptions, (res) => {
      response = res;
      if (settled) {
        res.destroy();
        return;
      }
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      if (signal) {
        // 响应头之后、body 读取阶段的超时：由 readResponseBodyLimited 抛 AbortError，
        // 这里同步销毁 socket，保证读流立即结束。
        const onStreamAbort = () => {
          try {
            res.destroy(createAbortError());
          } catch {
            /* 已销毁 */
          }
        };
        signal.addEventListener('abort', onStreamAbort, { once: true });
        res.on('close', () => signal.removeEventListener('abort', onStreamAbort));
      }
      res.on('error', () => {
        /* 由 body 读取方（reader）感知错误，避免 unhandled 'error' */
      });
      const responseHeaders = new Headers();
      for (const [key, value] of Object.entries(res.headers)) {
        if (value === undefined) continue;
        if (Array.isArray(value)) {
          for (const item of value) responseHeaders.append(key, String(item));
        } else {
          responseHeaders.set(key, String(value));
        }
      }
      resolve({
        status: Number(res.statusCode) || 0,
        statusText: String(res.statusMessage ?? ''),
        headers: responseHeaders,
        body: Readable.toWeb(res),
      });
    });
    req.on('error', (err) => {
      signal?.removeEventListener('abort', onAbort);
      if (settled) return;
      settled = true;
      reject(err);
    });
    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }
    if (payload) req.write(payload);
    req.end();
  });
}

/** 是否为 JSON 形态的请求 body（对象/数组文本）；用于自动补 Content-Type。 */
function looksLikeJsonBody(body) {
  const text = String(body ?? '').trim();
  return text.startsWith('{') || text.startsWith('[');
}

/** POST + JSON body 且未显式设置 Content-Type 时，自动补 application/json。 */
function withDefaultJsonContentType(method, body, headers) {
  const next = { ...(headers ?? {}) };
  if (String(method).toUpperCase() !== 'POST' || !String(body ?? '').trim()) return next;
  const hasContentType = Object.keys(next).some((key) => key.toLowerCase() === 'content-type');
  if (!hasContentType && looksLikeJsonBody(body)) next['Content-Type'] = 'application/json';
  return next;
}

/**
 * 把底层网络错误转成可读诊断：保留 fetch failed 原因码（ECONNREFUSED/ENOTFOUND/超时等），
 * 避免界面只显示 “fetch failed”。
 */
export function describeFetchError(err) {
  if (err?.name === 'AbortError' || /aborted|abort/i.test(String(err?.message ?? ''))) {
    return '请求超时：目标接口未在限定时间内响应';
  }
  const base = String(err?.message ?? err ?? '请求失败');
  const cause = err && typeof err === 'object' ? err.cause : null;
  const code = cause && typeof cause === 'object' ? cause.code || cause.errno || '' : '';
  const causeMessage = cause && typeof cause === 'object' ? String(cause.message ?? '') : '';
  const details = [];
  if (code && !base.includes(String(code))) details.push(String(code));
  if (causeMessage && !base.includes(causeMessage)) details.push(causeMessage);
  let text = base;
  if (details.length > 0) text += `（${details.join('：')}）`;
  if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|EHOSTUNREACH|ECONNRESET|UND_ERR/i.test(text)) {
    text += '；请检查目标服务是否已启动、URL 端口是否正确，以及 Docker 容器内是否可达该地址';
  }
  return text;
}

/**
 * 补齐 node:http 相对 fetch 缺少的自动解压：按 Content-Encoding 解压响应体，
 * 并同样强制解压后大小上限（防 gzip 炸弹）。
 */
function decodeCompressedBody(buffer, headers, limit) {
  const encoding = String(headers?.get?.('content-encoding') ?? '')
    .trim()
    .toLowerCase();
  if (!encoding || encoding === 'identity') return buffer;
  try {
    if (encoding === 'gzip' || encoding === 'x-gzip') return zlib.gunzipSync(buffer, { maxOutputLength: limit });
    if (encoding === 'deflate') return zlib.inflateSync(buffer, { maxOutputLength: limit });
    if (encoding === 'br') return zlib.brotliDecompressSync(buffer, { maxOutputLength: limit });
  } catch (err) {
    if (err?.code === 'ERR_BUFFER_TOO_LARGE' || /maxOutputLength|too large/i.test(String(err?.message))) {
      throw new Error('响应体超过大小上限');
    }
    throw new Error(`响应体解压失败：${err?.message ?? 'unknown'}`);
  }
  return buffer;
}

/**
 * 读取外部响应体并强制大小上限。
 * 不能直接 arrayBuffer()：chunked / 无 Content-Length 响应会在内存中无限增长；
 * 这里按流累计，超过上限立即取消读取并抛错。
 * signal 用于让超时覆盖响应头之后、body 读取阶段（AbortError 语义与 fetch 一致）。
 */
async function readResponseBodyLimited(response, maxBytes, signal) {
  const limit = Math.max(1, Number(maxBytes) || config.appRules.maxResponseBytes);
  if (signal?.aborted) throw createAbortError();
  const declaredSize = Number(response.headers.get('content-length') ?? 0);
  if (declaredSize > limit) {
    try {
      await response.body?.cancel?.();
    } catch {
      /* 已超限，取消失败不影响错误返回 */
    }
    throw new Error('响应体超过大小上限');
  }

  if (!response.body || typeof response.body.getReader !== 'function') {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > limit) throw new Error('响应体超过大小上限');
    return decodeCompressedBody(buffer, response.headers, limit);
  }

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  let rejectAbort = () => {};
  const abortPromise = new Promise((_, reject) => {
    rejectAbort = reject;
  });
  const onAbort = () => {
    try {
      Promise.resolve(reader.cancel()).catch(() => {});
    } catch {
      /* 已取消 */
    }
    rejectAbort(createAbortError());
  };
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  try {
    for (;;) {
      if (signal?.aborted) throw createAbortError();
      const { done, value } = await Promise.race([reader.read(), abortPromise]);
      // cancel() 可能让挂起的 read() 以 done=true 先于 abortPromise 结算，这里兜底：
      // 只要超时信号已触发，就必须以 AbortError 结束（不能把半截 body 当成功）。
      if (signal?.aborted) throw createAbortError();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > limit) {
        try {
          await reader.cancel();
        } catch {
          /* 已超限，取消失败不影响错误返回 */
        }
        throw new Error('响应体超过大小上限');
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    signal?.removeEventListener?.('abort', onAbort);
    try {
      reader.releaseLock?.();
    } catch {
      /* 忽略 */
    }
  }
  if (signal?.aborted) throw createAbortError();
  return decodeCompressedBody(Buffer.concat(chunks, total), response.headers, limit);
}

/**
 * 调用外部接口（SSRF 校验 + 连接层固定 IP + 重定向逐跳复验 + 超时 + 响应大小限制 + 仅文本）。
 * 每个重定向跳都会重新 validateTargetUrl 并重新固定该跳校验过的 IP。
 * @returns {Promise<{status:number, text:string, headers:object, finalUrl:string, latencyMs:number}>}
 */
export async function requestExternal({
  url,
  method = 'GET',
  headers = {},
  body = '',
  timeoutMs = config.appRules.timeoutMs,
  maxResponseBytes = config.appRules.maxResponseBytes,
  allowedHosts = config.appRules.allowedHosts,
  redirectLimit = 3,
  dnsLookup = deps.dnsLookup,
  httpRequest = deps.httpRequest,
} = {}) {
  const startedAt = deps.now();
  let currentUrl = String(url);
  let currentMethod = String(method || 'GET').toUpperCase() === 'POST' ? 'POST' : 'GET';
  let currentBody = currentMethod === 'GET' ? '' : String(body ?? '');
  const requestHeaders = { ...(headers ?? {}) };

  for (let redirect = 0; redirect <= redirectLimit; redirect += 1) {
    // 1) 每跳都重新解析并校验；2) 把校验通过的 IP 固定到该跳实际建连的 lookup。
    const validated = await validateTargetUrl(currentUrl, { allowedHosts, dnsLookup });
    const pinned = pickPinnedAddress(validated.addresses);
    if (!pinned) throw new Error(`域名解析失败：未返回有效地址（${validated.hostname}）`);
    const lookup = createPinnedLookup(pinned);
    const hopTimeoutMs = Math.max(1, Number(timeoutMs) || config.appRules.timeoutMs);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), hopTimeoutMs);
    try {
      const response = await abortable(
        httpRequest({
          url: currentUrl,
          method: currentMethod,
          headers: withDefaultJsonContentType(currentMethod, currentBody, requestHeaders),
          body: currentMethod === 'GET' ? '' : currentBody,
          timeoutMs: hopTimeoutMs,
          signal: controller.signal,
          hostname: validated.hostname,
          address: pinned.address,
          family: pinned.family,
          lookup,
        }),
        controller.signal,
      );

      if ([301, 302, 303, 307, 308].includes(Number(response.status))) {
        if (redirect === redirectLimit) throw new Error('重定向次数过多');
        const location = response.headers.get('location');
        if (!location) throw new Error('重定向响应缺少 Location');
        const nextUrl = new URL(location, currentUrl);
        const fromUrl = new URL(currentUrl);
        const sameHost = nextUrl.hostname.toLowerCase() === fromUrl.hostname.toLowerCase();
        const secureUpgrade = fromUrl.protocol === 'http:' && nextUrl.protocol === 'https:';
        if (!sameHost || (!secureUpgrade && nextUrl.origin !== fromUrl.origin)) {
          throw new Error('拒绝跨源重定向，避免自定义请求头/凭据被转发到其他主机');
        }
        currentUrl = nextUrl.toString();
        if (Number(response.status) === 303) {
          currentMethod = 'GET';
          currentBody = '';
        }
        try {
          await response.body?.cancel?.();
        } catch {
          /* 重定向响应体不需要读取 */
        }
        continue;
      }

      const contentType = String(response.headers.get('content-type') ?? '').toLowerCase();
      if (
        contentType &&
        !/^(text\/|application\/(json|xml|javascript|x-www-form-urlencoded))/i.test(contentType)
      ) {
        try {
          await response.body?.cancel?.();
        } catch {
          /* 不读取的响应体主动释放连接 */
        }
        throw new Error(`不支持的响应类型（仅接受文本/JSON）：${contentType}`);
      }
      const buffer = await readResponseBodyLimited(response, maxResponseBytes, controller.signal);
      const text = buffer.toString('utf8');
      const responseHeaders = {};
      for (const [key, value] of response.headers.entries()) responseHeaders[key] = value;
      return {
        status: Number(response.status),
        text,
        headers: responseHeaders,
        finalUrl: currentUrl,
        latencyMs: Math.max(0, deps.now() - startedAt),
      };
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error('重定向次数过多');
}
