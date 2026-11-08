/**
 * 外部 HTTP API mock（接口应用 e2e 用：本进程 node:http，随机端口，可配置响应）。
 * 独立于 server/** 与 e2e-client，供 app-rules/scheduled-tasks 等 e2e 断言外部调用。
 */
import http from 'node:http';

import { sleep, waitFor } from './process-env.mjs';

const DEFAULT_MOCK_API_RESPONSE = Object.freeze({
  status: 200,
  headers: { 'Content-Type': 'application/json; charset=utf-8' },
  body: '{"ok":true,"data":{"answer":"MOCK-OK"}}',
});

class MockHttpApi {
  constructor(server) {
    this.server = server;
    this.port = server.address().port;
    this.baseUrl = `http://127.0.0.1:${this.port}`;
    this.requests = [];
    this.responseConfig = { ...DEFAULT_MOCK_API_RESPONSE };
  }

  /**
   * 配置响应（可按请求动态返回）。支持字段：
   *  - status：HTTP 状态码（默认 200）
   *  - headers：响应头对象
   *  - body：字符串响应体
   *  - json：对象响应体（自动 JSON.stringify + Content-Type: application/json）
   *  - delayMs：响应前延迟（用于超时用例）
   *  - redirectTo：设置 302 + Location（用于重定向/SSRF 用例）
   * 也可传函数 (request) => config（支持异步）。
   */
  setResponse(config) {
    this.responseConfig = config ?? { ...DEFAULT_MOCK_API_RESPONSE };
    return this;
  }

  /** 清空收到的请求记录（默认保留当前响应配置）。 */
  reset({ keepResponse = true } = {}) {
    this.requests = [];
    if (!keepResponse) this.responseConfig = { ...DEFAULT_MOCK_API_RESPONSE };
    return this;
  }

  get lastRequest() {
    return this.requests[this.requests.length - 1] ?? null;
  }

  requestsFor(pathname) {
    return this.requests.filter((item) => item.pathname === pathname);
  }

  /** 等待收到满足条件的外部 API 请求（返回请求记录）。 */
  waitForRequest(predicate, { timeoutMs = 10000, intervalMs = 40, label = '外部 API 请求' } = {}) {
    const matcher = typeof predicate === 'function' ? predicate : (item) => item.pathname === predicate;
    return waitFor(() => this.requests.find(matcher) ?? null, { timeoutMs, intervalMs, label });
  }

  /** 等待累计收到 count 个请求。 */
  waitForRequestCount(count, { timeoutMs = 10000, intervalMs = 40, label } = {}) {
    return waitFor(() => (this.requests.length >= count ? this.requests.length : null), {
      timeoutMs,
      intervalMs,
      label: label ?? `外部 API 收到 ${count} 个请求`,
    });
  }

  async close() {
    const server = this.server;
    await new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      server.close(done);
      server.closeAllConnections?.();
      const timer = setTimeout(done, 1500);
      timer.unref?.();
    });
    this.requests = [];
  }
}

/**
 * 启动本进程内的外部 HTTP API mock（随机端口 127.0.0.1）。
 * @param {{response?: object, host?: string}} [options]
 * @returns {Promise<MockHttpApi>}
 */
export async function startMockApi({ response, host = '127.0.0.1' } = {}) {
  const api = { instance: null };
  const server = http.createServer((req, res) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 8 * 1024 * 1024) {
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', async () => {
      const body = Buffer.concat(chunks).toString('utf8');
      let parsedUrl;
      try {
        parsedUrl = new URL(req.url || '/', 'http://127.0.0.1');
      } catch {
        parsedUrl = new URL('http://127.0.0.1/');
      }
      const record = {
        at: Date.now(),
        method: String(req.method || 'GET').toUpperCase(),
        url: String(req.url || '/'),
        pathname: parsedUrl.pathname,
        query: Object.fromEntries(parsedUrl.searchParams.entries()),
        headers: { ...req.headers },
        body,
        bodyJson: null,
      };
      try {
        record.bodyJson = body === '' ? null : JSON.parse(body);
      } catch {
        record.bodyJson = null;
      }
      api.instance.requests.push(record);

      try {
        const target = api.instance.responseConfig;
        const config = typeof target === 'function' ? await target(record) : target;
        const cfg = config && typeof config === 'object' ? config : DEFAULT_MOCK_API_RESPONSE;
        if (Number(cfg.delayMs) > 0) await sleep(Number(cfg.delayMs));
        const status = Number(cfg.status) || (cfg.redirectTo ? 302 : 200);
        const headers = { ...(cfg.headers ?? {}) };
        let payload = '';
        if (cfg.redirectTo) {
          headers.Location = String(cfg.redirectTo);
          res.writeHead(status, headers);
          res.end();
          return;
        }
        if (cfg.json !== undefined) {
          payload = JSON.stringify(cfg.json);
          if (!headers['Content-Type'] && !headers['content-type']) headers['Content-Type'] = 'application/json; charset=utf-8';
        } else if (cfg.body !== undefined) {
          payload = typeof cfg.body === 'string' ? cfg.body : JSON.stringify(cfg.body);
        }
        if (!headers['Content-Type'] && !headers['content-type'] && payload) {
          headers['Content-Type'] = 'text/plain; charset=utf-8';
        }
        res.writeHead(status, headers);
        res.end(payload);
      } catch {
        try {
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end('mock api handler error');
        } catch {
          /* ignore */
        }
      }
    });
    req.on('error', () => {
      try {
        res.destroy();
      } catch {
        /* ignore */
      }
    });
  });
  server.keepAliveTimeout = 5000;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, resolve);
  });
  const mockApi = new MockHttpApi(server);
  api.instance = mockApi;
  if (response !== undefined) mockApi.setResponse(response);
  return mockApi;
}
