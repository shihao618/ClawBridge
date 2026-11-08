/**
 * 纯解析函数（无 DOM，可被 node:test 直接 import）。
 *
 * 从 admin.js 抽出：关键词/Header/设置数组输入解析与分组颜色白名单校验。
 */

/**
 * 解析关键词输入（换行 / 中英文逗号 / 分号分隔），去空白、丢空项。
 * @param {unknown} text
 * @returns {string[]}
 */
export function parseKeywordsInput(text) {
  return String(text || '')
    .split(/[\n,，;；]+/)
    .map((keyword) => keyword.trim())
    .filter(Boolean);
}

/**
 * 解析 Header 文本（每行 `Name: value`），保留首次出现的名称，忽略空名称行。
 * @param {unknown} text
 * @returns {Record<string, string>}
 */
export function parseHeadersInput(text) {
  const headers = {};
  for (const line of String(text || '').split('\n')) {
    const index = line.indexOf(':');
    if (index <= 0) continue;
    const name = line.slice(0, index).trim();
    const value = line.slice(index + 1).trim();
    if (name) headers[name] = value;
  }
  return headers;
}

/** 仅接受 #RRGGBB，避免把接口返回的颜色直接当 CSS 使用。 */
export function normalizeGroupColor(value) {
  return typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value) ? value.toUpperCase() : '';
}

/**
 * 解析设置项数组输入（换行 / 中英文逗号 / 分号分隔），去空白、丢空项。
 * @param {unknown} text
 * @returns {string[]}
 */
export function parseSettingArrayInput(text) {
  return String(text || '')
    .split(/[,\n，;；]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}
