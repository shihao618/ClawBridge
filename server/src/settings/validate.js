/**
 * 运行配置值校验：字段类型/范围/URL/主机名/MIME/枚举 + 脱敏展示工具。
 *
 * 校验失败统一走 badRequest() 抛 400（保持原校验文案不变）。
 */
import net from 'node:net';

import { badRequest } from '../errors.js';

export function cloneValue(value) {
  return Array.isArray(value) ? value.map((item) => (Array.isArray(item) ? item.slice() : item)) : value;
}

// ---------------------------------------------------------------------------
// 值校验
// ---------------------------------------------------------------------------
export function fail(message) {
  throw badRequest(message);
}

export function parseStringArray(raw) {
  let values;
  if (Array.isArray(raw)) values = raw;
  else if (typeof raw === 'string') values = raw.split(',');
  else fail('必须是数组或逗号分隔字符串');
  return values.map((value) => String(value).trim().toLowerCase()).filter((value) => value !== '');
}

export function validateHostname(value) {
  if (net.isIP(value) !== 0) return true;
  if (value.length < 1 || value.length > 253) return false;
  return /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value);
}

const MIME_RE = /^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/;

export function validateUrl(value, field, label) {
  if (value === '' && field.allowEmpty) return '';
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail(`${label} 不是合法 URL`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) fail(`${label} 仅允许 http/https`);
  if (parsed.username || parsed.password) fail(`${label} 不允许包含 userinfo`);
  return value.replace(/\/+$/, '');
}

export function validateFieldValue(field, raw) {
  const label = `${field.group}.${field.key}`;
  if (field.type === 'boolean') {
    if (typeof raw !== 'boolean') fail(`${label} 必须是 boolean`);
    return raw;
  }
  if (field.type === 'number') {
    if (typeof raw !== 'number' || !Number.isFinite(raw) || !Number.isInteger(raw)) {
      fail(`${label} 必须是整数`);
    }
    if (raw < field.min || raw > field.max) fail(`${label} 必须在 ${field.min}..${field.max} 之间`);
    return raw;
  }
  if (field.type === 'numberArray') {
    let list;
    if (Array.isArray(raw)) list = raw;
    else if (typeof raw === 'string') list = raw.split(',');
    else fail(`${label} 必须是整数数组或逗号分隔字符串`);
    list = list.map((value) => String(value).trim()).filter((value) => value !== '');
    if (list.length === 0 || list.length > 10) fail(`${label} 必须包含 1..10 个数值`);
    return list.map((value) => {
      const parsed = Number(value);
      if (!Number.isInteger(parsed)) fail(`${label} 包含非法数值：${value}`);
      if (parsed < field.min || parsed > field.max) fail(`${label} 每个数值必须在 ${field.min}..${field.max} 之间`);
      return parsed;
    });
  }
  if (field.type === 'stringArray') {
    const list = [...new Set(parseStringArray(raw))];
    if (list.length > 100) fail(`${label} 最多 100 项`);
    for (const value of list) {
      if (!validateHostname(value)) fail(`${label} 包含非法主机名：${value}`);
    }
    return list;
  }
  if (field.type === 'mimeArray') {
    const list = [...new Set(parseStringArray(raw))];
    if (list.length === 0 || list.length > 50) fail(`${label} 必须包含 1..50 个 MIME 类型`);
    for (const value of list) {
      if (!MIME_RE.test(value)) fail(`${label} 包含非法 MIME 类型：${value}`);
    }
    return list;
  }
  if (field.type === 'enum') {
    if (typeof raw !== 'string' || !field.options.includes(raw)) {
      fail(`${label} 必须是 ${field.options.join('/')} 之一`);
    }
    return raw;
  }
  // string / url
  if (typeof raw !== 'string') fail(`${label} 必须是字符串`);
  const value = raw.trim();
  if (field.type === 'url') return validateUrl(value, field, label);
  if (value.length < field.min || value.length > field.max) {
    fail(`${label} 长度必须在 ${field.min}..${field.max} 之间`);
  }
  if (field.validator === 'timezone') {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: value });
    } catch {
      fail(`${label} 不是合法的 IANA 时区`);
    }
  }
  return value;
}

// ---------------------------------------------------------------------------
// envOnly（只读、脱敏展示 + env 默认快照）
// ---------------------------------------------------------------------------
export function maskSecret(value) {
  const text = String(value ?? '');
  if (!text) return '未配置';
  if (text.length <= 8) return '已配置（隐藏）';
  return `${text.slice(0, 4)}…${text.slice(-4)}`;
}

export function previewToken(value) {
  const text = String(value ?? '');
  if (!text) return '未配置';
  if (text.length <= 12) return '已配置（隐藏）';
  return `${text.slice(0, 6)}…${text.slice(-4)}`;
}
