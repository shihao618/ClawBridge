/**
 * 运行配置（settings）纯函数（无 DOM，可被 node:test 直接 import）。
 */
import { parseSettingArrayInput } from './parse.js';

/**
 * 归一化设置字段类型：boolean / number / array / text / enum / url / string。
 * @param {object|null|undefined} field
 * @returns {string}
 */
export function settingTypeOf(field) {
  const type = field && typeof field.type === 'string' ? field.type.toLowerCase() : '';
  if (type === 'boolean' || type === 'bool') return 'boolean';
  if (type === 'number') return 'number';
  if (type === 'array' || type === 'numberarray' || type === 'stringarray') return 'array';
  if (type === 'text') return 'text';
  if (type === 'enum' || type === 'select') return 'enum';
  if (type === 'url' || type === 'urlstring') return 'url';
  const value = field ? field.value : undefined;
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') return 'number';
  if (Array.isArray(value)) return 'array';
  return 'string';
}

/**
 * 按设置字段类型归一化值。
 * @param {unknown} value
 * @param {string} type settingTypeOf() 的返回类型
 * @returns {unknown}
 */
export function normalizeSettingValue(value, type) {
  if (type === 'boolean') return value === true;
  if (type === 'number') {
    const number = Number(value);
    return Number.isFinite(number) ? number : value;
  }
  if (type === 'array') {
    if (Array.isArray(value)) return value.map((item) => String(item));
    if (typeof value === 'string') return parseSettingArrayInput(value);
    return [];
  }
  return value === undefined || value === null ? '' : String(value);
}

/**
 * 比较两个设置值是否相等（数组按 JSON 序列化比较）。
 * @param {unknown} left
 * @param {unknown} right
 * @returns {boolean}
 */
export function settingsValuesEqual(left, right) {
  if (Array.isArray(left) || Array.isArray(right)) {
    return JSON.stringify(left || []) === JSON.stringify(right || []);
  }
  return left === right;
}
