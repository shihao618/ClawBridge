/**
 * ClawBridge 管理后台常量与元数据。
 *
 * 从 admin.js 抽出的固定配置：轮询间隔/分页大小、状态徽章文案、菜单视图表。
 */

export const POLL_INTERVAL_MS = 5000;

export const PAGE_SIZE = 20;

export const MAX_TEXT_LENGTH = 4000;

export const ADVANCED_SETTINGS_KEYS = new Set([
  'binding.verifyTimeoutMs',
  'binding.networkErrorLimit',
  'binding.pollGapMs',
  'media.uploadTimeoutMs',
  'ilink.routeTag',
  'ilink.clientVersion',
]);

export const USER_STATUS_META = {
  active: { label: '活跃', className: 'badge-success' },
  paused: { label: '暂停中', className: 'badge-warning' },
  unbound: { label: '已解绑', className: 'badge-muted' },
};

export const MESSAGE_DIRECTION_META = {
  inbound: { label: '入站', className: 'badge-info' },
  outbound: { label: '出站', className: 'badge-success' },
};

export const MESSAGE_STATUS_META = {
  received: { label: '已接收', className: 'badge-info' },
  sent: { label: '已发送', className: 'badge-success' },
  queued: { label: '排队中', className: 'badge-warning' },
  sending: { label: '发送中', className: 'badge-info' },
  failed: { label: '失败', className: 'badge-danger' },
};

/** 消息来源标签（docs/KEEPALIVE.md §4：消息项新增 source 字段）。 */
export const MESSAGE_SOURCE_META = {
  keepalive: { label: '保活', className: 'badge-keepalive' },
  broadcast: { label: '广播', className: 'badge-info' },
  group: { label: '分组', className: 'badge-group' },
  admin: { label: '管理', className: 'badge-muted' },
  api: { label: 'API', className: 'badge-muted' },
  webhook: { label: 'Webhook', className: 'badge-info' },
  system: { label: '系统', className: 'badge-muted' },
};

/** 附件类型元信息（与 docs/MEDIA.md §4.1 的 attachments.kind 对应）。 */
export const MEDIA_KIND_META = {
  image: { label: '图片', icon: '🖼️' },
  video: { label: '视频', icon: '🎬' },
  file: { label: '文件', icon: '📄' },
  voice: { label: '语音', icon: '🎤' },
};

/** 分组名称/描述长度限制（docs/GROUPS_AND_INBOUND.md §3.1）。 */
export const GROUP_NAME_MAX = 40;

export const GROUP_DESC_MAX = 200;

/** 分组颜色预设色板。 */
export const GROUP_COLOR_PALETTE = [
  '#07C160',
  '#2563EB',
  '#7C3AED',
  '#DB2777',
  '#DC2626',
  '#D97706',
  '#0EA5E9',
  '#64748B',
];

/** 分组筛选中「未分组」的客户端哨兵值（后端仅支持 groupId=具体分组）。 */
export const UNGROUPED_FILTER = '__ungrouped__';

/** 后台菜单与 hash 路由（固定 7 个视图，顺序与侧栏一致）。 */
export const VIEW_STORAGE_KEY = 'clawbridge:admin-view:v1';

export const DEFAULT_VIEW = 'overview';

export const MENU_VIEWS = [
  { id: 'overview', hash: '#/overview', title: '概览', sectionId: 'overview-section', live: true },
  { id: 'users', hash: '#/users', title: '用户管理', sectionId: 'users-section', live: true },
  { id: 'groups', hash: '#/groups', title: '用户分组', sectionId: 'groups-section', live: false },
  { id: 'messages', hash: '#/messages', title: '消息记录', sectionId: 'messages-section', live: true },
  { id: 'broadcast', hash: '#/broadcast', title: '广播消息', sectionId: 'broadcast-section', live: false },
  { id: 'app-rules', hash: '#/app-rules', title: '接口应用', sectionId: 'app-rules-section', live: true },
  { id: 'config', hash: '#/config', title: '运行配置', sectionId: 'config-section', live: false },
];

export const VIEW_BY_ID = new Map(MENU_VIEWS.map((view) => [view.id, view]));

export const LIVE_VIEWS = new Set(MENU_VIEWS.filter((view) => view.live).map((view) => view.id));

export const RULE_RUN_STATUS_META = {
  success: { label: '成功', className: 'badge-success' },
  failed: { label: '失败', className: 'badge-danger' },
  skipped: { label: '跳过', className: 'badge-warning' },
  matched: { label: '命中', className: 'badge-info' },
};

export const RULE_EXTRACTION_LABELS = {
  none: '不提取（直接调用接口）',
  multi: '多参数组合提取',
};

export const MULTI_EXTRACTOR_TYPE_LABELS = {
  trailing: '关键词后文本',
  regex: '正则命名捕获',
  json: 'JSON 消息',
  fulltext: '整句',
};

export const SCHEDULE_STATUS_META = {
  success: { label: '成功', className: 'badge-success' },
  failed: { label: '失败', className: 'badge-danger' },
  skipped: { label: '跳过', className: 'badge-warning' },
};
