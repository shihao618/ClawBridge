/**
 * 单元测试：日志 URL 脱敏工具 + HTTP 错误处理日志的 path 字段。
 *
 * 缺少该工具时，`POST /api/v1/webhook?token=<API_TOKEN>` 被限流/异常处理时
 * 会把明文 API Token 写入 error/debug 日志（logger 只按字段名脱敏，不处理 URL 值）。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { cleanupUnitEnv, prepareUnitEnv } from '../helpers/unit-env.mjs';

const unitEnv = prepareUnitEnv({
  prefix: 'clawbridge-logger-',
  env: {
    APP_SECRET: 'logger-test-secret-0123456789abcdef0123456789abcdef',
    LOG_LEVEL: 'warn',
  },
});

const { redactUrlQueryForLog } = await import('../../server/src/logger.js');
const { errorHandler } = await import('../../server/src/http/middleware.js');

test.after(async () => {
  await cleanupUnitEnv(unitEnv);
});

test('redactUrlQueryForLog：token/key/api_key/authorization 等敏感 query 值替换为 [redacted]', () => {
  assert.equal(redactUrlQueryForLog('/api/v1/webhook?token=SECRET_TOKEN'), '/api/v1/webhook?token=[redacted]');
  assert.equal(
    redactUrlQueryForLog('/api/x?api_key=SECRET&api-key=SECRET2&apikey=SECRET3&key=SECRET4'),
    '/api/x?api_key=[redacted]&api-key=[redacted]&apikey=[redacted]&key=[redacted]',
  );
  assert.equal(
    redactUrlQueryForLog('/api/x?authorization=Bearer%20SECRET&Authorization=SECRET'),
    '/api/x?authorization=[redacted]&Authorization=[redacted]',
  );
  // 绝对 URL（app-rules 运行日志同口径）与 hash 保留
  assert.equal(
    redactUrlQueryForLog('https://x.example/api?token=SECRET#frag'),
    'https://x.example/api?token=[redacted]#frag',
  );
});

test('redactUrlQueryForLog：无查询串原样返回、多参数保留非敏感值、非敏感参数名不误伤', () => {
  assert.equal(redactUrlQueryForLog('/api/admin/app-rules'), '/api/admin/app-rules');
  assert.equal(redactUrlQueryForLog('/api/admin/app-rules?includeDisabled=1'), '/api/admin/app-rules?includeDisabled=1');
  assert.equal(redactUrlQueryForLog(''), '');
  assert.equal(redactUrlQueryForLog(undefined), '');
  assert.equal(
    redactUrlQueryForLog('/hook?a=1&token=SECRET&b=2&keyword=abc'),
    '/hook?a=1&token=[redacted]&b=2&keyword=abc',
  );
  // 参数名包含 key/token 字样但本身不敏感（keyword/monkey/hotkey）不得误伤
  assert.equal(redactUrlQueryForLog('/x?keyword=1&monkey=2&hotkey=3'), '/x?keyword=1&monkey=2&hotkey=3');
});

test('errorHandler：错误日志 path 字段中的 query 机密被脱敏（不含明文 Token）', () => {
  const captured = [];
  const originalWrite = process.stderr.write;
  process.stderr.write = (chunk) => {
    captured.push(String(chunk));
    return true;
  };
  try {
    const req = {
      method: 'POST',
      originalUrl: '/api/v1/webhook?token=SECRET_WEBHOOK_TOKEN&foo=bar',
      path: '/api/v1/webhook',
    };
    const res = {
      headersSent: false,
      statusCode: 0,
      body: null,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(body) {
        this.body = body;
        return this;
      },
    };
    errorHandler(new Error('boom'), req, res, () => {});
    assert.equal(res.statusCode, 500, '未预期异常应返回 500');
    assert.equal(res.body.error.code, 'INTERNAL');
  } finally {
    process.stderr.write = originalWrite;
  }

  const output = captured.join('');
  assert.ok(output.includes('请求处理失败'), `应写入错误日志：${output}`);
  assert.ok(!output.includes('SECRET_WEBHOOK_TOKEN'), `错误日志不得包含明文 token：${output}`);
  const record = JSON.parse(output.trim().split('\n')[0]);
  assert.equal(record.path, '/api/v1/webhook?token=[redacted]&foo=bar');
  assert.equal(record.status, 500);
  assert.equal(record.message, 'boom');
});
