/**
 * 管理后台：接口应用（app-rules）CRUD / 测试 / 日志 / 回复模板离线预览（docs/API_RULES.md §7）。
 */
import * as appRules from '../app-rules.js';
import * as auth from '../auth.js';
import { config } from '../config.js';
import { badRequest, notFound } from '../errors.js';
import { logger } from '../logger.js';
import { requireJsonBody, parseLimit, parseOffset } from '../http/helpers.js';
import { APP_RULE_LOG_STATUSES, buildAppRulePatch } from '../http/app-rule-validators.js';
import { filterWechatMarkdown } from '../shared/wechat-markdown.js';
import * as store from '../store.js';

const log = logger.child({ mod: 'api' });

export function registerAdminRulesRoutes(app) {
  app.get('/api/admin/app-rules', auth.requireAdmin, (req, res) => {
    const includeDisabled = ['1', 'true', 'yes'].includes(String(req.query.includeDisabled ?? '').toLowerCase());
    res.json({ items: store.listAppRules({ includeDisabled }) });
  });

  app.post('/api/admin/app-rules', auth.requireAdminWrite, (req, res) => {
    const body = requireJsonBody(req);
    const patch = buildAppRulePatch(body, { requireAll: true });
    const rule = store.createAppRule(patch);
    log.info('接口应用规则已创建', { ruleId: rule.id, name: rule.name });
    res.status(201).json({ rule });
  });

  app.post('/api/admin/app-rules/:id/duplicate', auth.requireAdminWrite, (req, res) => {
    const rule = store.duplicateAppRule(req.params.id);
    if (!rule) throw notFound('规则不存在');
    log.info('接口应用规则已复制', { sourceRuleId: req.params.id, ruleId: rule.id, name: rule.name });
    res.status(201).json({ rule });
  });

  app.get('/api/admin/app-rules/:id', auth.requireAdmin, (req, res) => {
    const rule = store.getAppRule(req.params.id);
    if (!rule) throw notFound('规则不存在');
    res.json({ rule });
  });

  app.patch('/api/admin/app-rules/:id', auth.requireAdminWrite, (req, res) => {
    const existing = store.getAppRuleRow(req.params.id);
    if (!existing) throw notFound('规则不存在');
    const body = requireJsonBody(req);
    // 传入 existing：request.mode=none 的回复校验需要合并 DB 现有 response 字段。
    const patch = buildAppRulePatch(body, { requireAll: false, existing });
    const rule = store.updateAppRule(req.params.id, patch);
    log.info('接口应用规则已更新', { ruleId: req.params.id });
    res.json({ rule });
  });

  app.delete('/api/admin/app-rules/:id', auth.requireAdminWrite, (req, res) => {
    if (!store.deleteAppRule(req.params.id)) throw notFound('规则不存在');
    log.info('接口应用规则已删除', { ruleId: req.params.id });
    res.status(204).end();
  });

  app.post('/api/admin/app-rules/:id/test', auth.requireAdminWrite, async (req, res) => {
    const row = store.getAppRuleRow(req.params.id);
    if (!row) throw notFound('规则不存在');
    const body = requireJsonBody(req);
    if (typeof body.message !== 'string' || body.message.trim() === '') throw badRequest('message 必须是非空字符串');
    if (body.message.length > config.push.maxTextLength) throw badRequest(`message 长度不能超过 ${config.push.maxTextLength}`);
    const userId = typeof body.userId === 'string' ? body.userId.trim() : '';
    if (userId && !store.getUserRow(userId)) throw notFound('用户不存在');
    const result = await appRules.testRule({ ruleRow: row, message: body.message, userId });
    log.info('接口应用规则测试运行', {
      ruleId: row.id,
      matched: result.matched,
      httpStatus: result.httpStatus,
      error: result.error,
    });
    res.json(result);
  });

  app.get('/api/admin/app-rule-logs', auth.requireAdmin, (req, res) => {
    const ruleId = typeof req.query.ruleId === 'string' ? req.query.ruleId.trim() : '';
    const userId = typeof req.query.userId === 'string' ? req.query.userId.trim() : '';
    const status = typeof req.query.status === 'string' ? req.query.status.trim() : '';
    if (status !== '' && !APP_RULE_LOG_STATUSES.has(status)) {
      throw badRequest('status 只能是 matched | success | failed | skipped');
    }
    res.json(
      store.listAppRuleLogs({
        ruleId,
        userId,
        status,
        limit: parseLimit(req.query.limit, 50, 500),
        offset: parseOffset(req.query.offset),
      }),
    );
  });

  // 回复模板离线预览：用示例响应走真实解析/模板引擎，不访问外部接口。
  app.post('/api/admin/template-preview', auth.requireAdminWrite, (req, res) => {
    const body = requireJsonBody(req);
    const sample = typeof body.sample === 'string' ? body.sample : '';
    if (sample.trim() === '') throw badRequest('sample 必须是非空字符串');
    if (Buffer.byteLength(sample, 'utf8') > config.appRules.maxResponseBytes) {
      throw badRequest(`sample 不能超过 ${config.appRules.maxResponseBytes} 字节`);
    }
    const responseType = body.responseType === 'text' ? 'text' : 'json';
    const responsePath = typeof body.responsePath === 'string' ? body.responsePath : '';
    const template = typeof body.template === 'string' ? body.template : '';
    const fallbackText = typeof body.fallbackText === 'string' ? body.fallbackText : '';
    let preview;
    try {
      preview = appRules.previewReplyTemplate({ responseType, responsePath, template, fallbackText, rawText: sample });
    } catch (err) {
      throw badRequest(err?.message || '示例响应解析失败');
    }
    // 与真实发送保持一致：模板预览返回仅按微信规则过滤后的可发送文本（换行原样保留）
    res.json({ ...preview, replyText: filterWechatMarkdown(preview?.replyText ?? '') });
  });
}
