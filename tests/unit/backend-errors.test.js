/**
 * 单元测试：errors.js —— 错误码映射、AppError/ILinkError 分类与 toErrorResponse 表驱动。
 *
 * 覆盖错误处理契约：错误码/上游错误分类/对外错误响应格式与“不泄漏内部信息”。
 * 纯函数测试，无网络、无临时目录。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AppError,
  ErrorCodes,
  ILinkError,
  badRequest,
  conflict,
  forbidden,
  isAbortError,
  isPrepareFailedError,
  isRateLimitError,
  isStaleTokenError,
  isTimeoutError,
  notFound,
  rateLimited,
  toErrorResponse,
  unauthorized,
  unavailable,
} from '../../server/src/errors.js';

test('ErrorCodes：8 个错误码，键值一致且唯一', () => {
  const expected = ['BAD_REQUEST', 'UNAUTHORIZED', 'FORBIDDEN', 'NOT_FOUND', 'CONFLICT', 'RATE_LIMITED', 'INTERNAL', 'UNAVAILABLE'];
  assert.deepEqual(Object.keys(ErrorCodes).sort(), [...expected].sort());
  for (const code of expected) assert.equal(ErrorCodes[code], code);
  assert.equal(new Set(Object.values(ErrorCodes)).size, expected.length, '错误码值不应重复');
});

test('AppError：默认 status 400、到 JSON 的错误结构、details 可选', () => {
  const plain = new AppError(ErrorCodes.BAD_REQUEST, '参数错误');
  assert.equal(plain.name, 'AppError');
  assert.ok(plain instanceof Error);
  assert.equal(plain.status, 400);
  assert.equal(plain.code, 'BAD_REQUEST');
  assert.equal(plain.message, '参数错误');
  assert.deepEqual(plain.toJSON(), { error: { code: 'BAD_REQUEST', message: '参数错误' } });

  const withDetails = new AppError(ErrorCodes.CONFLICT, '冲突', { status: 409, details: { field: 'name' }, cause: new Error('root') });
  assert.equal(withDetails.status, 409);
  assert.deepEqual(withDetails.toJSON(), {
    error: { code: 'CONFLICT', message: '冲突', details: { field: 'name' } },
  });
  assert.ok(withDetails.cause instanceof Error, 'cause 应被保留');
});

test('错误工厂：code/status/默认文案/自定义文案', () => {
  const rows = [
    [badRequest('bad'), 'BAD_REQUEST', 400, 'bad'],
    [unauthorized(), 'UNAUTHORIZED', 401, '未认证'],
    [unauthorized('自定义未认证'), 'UNAUTHORIZED', 401, '自定义未认证'],
    [forbidden(), 'FORBIDDEN', 403, '无权限'],
    [notFound(), 'NOT_FOUND', 404, '资源不存在'],
    [conflict('冲突'), 'CONFLICT', 409, '冲突'],
    [rateLimited(), 'RATE_LIMITED', 429, '请求过于频繁'],
    [unavailable(), 'UNAVAILABLE', 503, '服务暂不可用'],
  ];
  for (const [err, code, status, message] of rows) {
    assert.ok(err instanceof AppError, `${code} 应为 AppError`);
    assert.equal(err.code, code);
    assert.equal(err.status, status);
    assert.equal(err.message, message);
  }
  assert.deepEqual(badRequest('x', { a: 1 }).details, { a: 1 }, 'badRequest 应透传 details');
  assert.deepEqual(conflict('x', { b: 2 }).details, { b: 2 }, 'conflict 应透传 details');
});

test('ILinkError：默认值与 code 推导（ret > httpStatus > timeout > aborted > 兜底）', () => {
  const base = new ILinkError('上游失败');
  assert.equal(base.name, 'ILinkError');
  assert.equal(base.code, 'ILINK_ERROR');
  assert.equal(base.endpoint, '');
  assert.equal(base.httpStatus, null);
  assert.equal(base.ret, null);
  assert.equal(base.timeout, false);
  assert.equal(base.aborted, false);

  assert.equal(new ILinkError('限流', { ret: -2 }).code, 'ILINK_-2');
  assert.equal(new ILinkError('失效', { ret: -14 }).code, 'ILINK_-14');
  assert.equal(new ILinkError('HTTP 500', { httpStatus: 500 }).code, 'ILINK_HTTP_500');
  assert.equal(new ILinkError('ret 优先', { ret: -2, httpStatus: 500 }).code, 'ILINK_-2');
  assert.equal(new ILinkError('超时', { timeout: true }).code, 'ILINK_TIMEOUT');
  assert.equal(new ILinkError('中止', { aborted: true }).code, 'ILINK_ABORTED');
  // 非 Error cause 不被误当成原因
  const withBody = new ILinkError('带响应体', { endpoint: 'sendmessage', body: '{"ret":-14}', cause: null });
  assert.equal(withBody.endpoint, 'sendmessage');
  assert.equal(withBody.body, '{"ret":-14}');
});

test('isRateLimitError / isPrepareFailedError：-2 限流与 prepare failed 语义区分', () => {
  assert.equal(isRateLimitError(new ILinkError('限流', { ret: -2 })), true);
  assert.equal(isRateLimitError(new ILinkError('限流', { ret: -2, errmsg: 'too fast' })), true);
  assert.equal(isRateLimitError(new ILinkError('prepared', { ret: -2, errmsg: 'prepare failed' })), false);
  assert.equal(isRateLimitError(new ILinkError('PREPARE FAILED x', { ret: -2 })), false, 'message 中的 prepare failed 同样不算限流');
  assert.equal(isRateLimitError(new ILinkError('-14', { ret: -14 })), false);
  assert.equal(isRateLimitError(new Error('ret=-2')), false);
  assert.equal(isRateLimitError(null), false);

  assert.equal(isPrepareFailedError(new ILinkError('prepare failed', { ret: -2, errmsg: 'prepare failed' })), true);
  assert.equal(isPrepareFailedError(new ILinkError('', { ret: -2, errmsg: 'Prepare Failed: token' })), true);
  assert.equal(isPrepareFailedError(new ILinkError('upstream prepare failed', { ret: -2 })), true);
  assert.equal(isPrepareFailedError(new ILinkError('', { ret: -2 })), false);
  assert.equal(isPrepareFailedError(new ILinkError('', { ret: -14, errmsg: 'prepare failed' })), false);
  assert.equal(isPrepareFailedError({ ret: -2, errmsg: 'prepare failed' }), false);
});

test('isStaleTokenError / isTimeoutError / isAbortError', () => {
  assert.equal(isStaleTokenError(new ILinkError('失效', { ret: -14 })), true);
  assert.equal(isStaleTokenError(new ILinkError('限流', { ret: -2 })), false);
  assert.equal(isStaleTokenError(new Error('-14')), false);

  assert.equal(isTimeoutError(new ILinkError('超时', { timeout: true })), true);
  assert.equal(isTimeoutError(new ILinkError('中止', { aborted: true })), true);
  assert.equal(isTimeoutError(new ILinkError('普通')), false);
  assert.equal(isTimeoutError(new AppError('X', 'x')), false);

  assert.equal(isAbortError({ name: 'AbortError' }), true);
  assert.equal(isAbortError(Object.assign(new Error('aborted'), { code: 'ABORT_ERR' })), true);
  assert.equal(isAbortError(new Error('普通错误')), false);
  assert.equal(isAbortError(null), false);
  assert.equal(isAbortError(undefined), false);
});

test('toErrorResponse：AppError 原样透出、ILinkError 502 脱敏、未知错误 500 不泄漏内部信息', () => {
  const app = toErrorResponse(notFound());
  assert.equal(app.status, 404);
  assert.deepEqual(app.body, { error: { code: 'NOT_FOUND', message: '资源不存在' } });

  const appWithDetails = toErrorResponse(new AppError(ErrorCodes.BAD_REQUEST, '校验失败', { details: { field: 'x' } }));
  assert.deepEqual(appWithDetails.body.error.details, { field: 'x' });

  const ilink = toErrorResponse(
    new ILinkError('sendmessage 请求超时（15000ms）', { endpoint: 'sendmessage', timeout: true }),
  );
  assert.equal(ilink.status, 502);
  assert.equal(ilink.body.error.code, 'UPSTREAM_ERROR');
  assert.equal(ilink.body.error.message, '微信 ClawBot 接口调用失败');
  assert.ok(String(ilink.body.error.details).includes('超时'), '上游错误细节应保留便于排障');

  const unknown = toErrorResponse(new Error('数据库文件路径 /secret/db.sqlite 打开失败'));
  assert.equal(unknown.status, 500);
  assert.equal(unknown.body.error.code, 'INTERNAL');
  assert.equal(unknown.body.error.message, '服务器内部错误');
  assert.equal(JSON.stringify(unknown).includes('/secret/db.sqlite'), false, '未知错误不得把内部信息返回客户端');
  assert.equal(JSON.stringify(unknown).includes('打开失败'), false);

  assert.equal(toErrorResponse('字符串错误').status, 500, '非 Error 也应转换为 500');
  assert.equal(toErrorResponse(null).body.error.code, 'INTERNAL');
});
