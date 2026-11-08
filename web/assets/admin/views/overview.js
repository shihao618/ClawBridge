/**
 * 概览视图：GET /api/admin/overview 统计卡片与服务信息。
 */

import { els, state } from '../state.js';
import { appendKv } from '../ui.js';
import { apiFetch, clearNode, el, formatDateTime, formatDuration, formatNumber } from '../../common.js';

export async function loadOverview() {
  const data = await apiFetch('/api/admin/overview');
  state.overview = data;
  renderOverview(data);
}

function renderOverview(data) {
  const stats = data && data.stats && typeof data.stats === 'object' ? data.stats : {};
  const cards = [
    { label: '总用户数', value: stats.totalUsers, icon: '👥' },
    { label: '活跃用户', value: stats.activeUsers, icon: '🟢' },
    { label: '暂停中', value: stats.pausedUsers, icon: '⏸️' },
    { label: '可推送用户', value: stats.usersWithContextToken, icon: '📨' },
    { label: '今日消息', value: stats.messagesToday, icon: '💬' },
    { label: '24h 入站', value: stats.inboundLast24h, icon: '📥' },
    { label: '队列中', value: stats.queued, icon: '⌛' },
    { label: '发送中', value: stats.sending, icon: '🚀' },
    { label: '发送成功', value: stats.sent, icon: '✅' },
    { label: '发送失败', value: stats.failed, icon: '⚠️' },
    { label: '保活用户', value: stats.keepaliveEnabledUsers, icon: '🔁' },
    { label: '24h 保活入队', value: stats.keepaliveSent24h, icon: '📮' },
  ];
  clearNode(els.overviewStats);
  for (const card of cards) {
    els.overviewStats.append(
      el(
        'div',
        { class: 'stat-card' },
        el('span', { class: 'stat-icon', 'aria-hidden': 'true', text: card.icon }),
        el(
          'div',
          { class: 'stat-body' },
          el('span', { class: 'stat-label', text: card.label }),
          el('strong', { class: 'stat-value', text: formatNumber(card.value) }),
        ),
      ),
    );
  }

  const server = data && data.server && typeof data.server === 'object' ? data.server : {};
  const ilink = server.ilink && typeof server.ilink === 'object' ? server.ilink : {};
  const rateLimit = server.rateLimit && typeof server.rateLimit === 'object' ? server.rateLimit : {};
  const entries = [
    ['服务版本', server.version],
    ['运行时长', Number.isFinite(server.uptimeMs) ? formatDuration(server.uptimeMs) : null],
    ['服务器时间', server.now ? formatDateTime(server.now) : null],
    ['微信登录基址', ilink.loginBaseUrl],
    ['微信默认基址', ilink.defaultBaseUrl],
    ['Bot 类型', ilink.botType],
    [
      '发送限流',
      rateLimit.max !== undefined && rateLimit.max !== null
        ? `${formatNumber(rateLimit.max)} 条 / ${formatDuration(rateLimit.windowMs)}`
        : null,
    ],
    ['入站监控账号', server.monitorsRunning],
    ['活跃绑定会话', server.bindingSessionsActive],
  ];
  clearNode(els.overviewServer);
  for (const [label, value] of entries) appendKv(els.overviewServer, label, value);
}
