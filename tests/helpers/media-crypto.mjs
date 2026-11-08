/**
 * 媒体 AES 测试工具：微信出站 CDNMedia.aes_key 约定（base64(32 字符 hex key 的 ASCII 字节)）
 * 与接收端解密校验；协议说明见 docs/MEDIA.md。
 */
import assert from 'node:assert/strict';
import { createDecipheriv } from 'node:crypto';

/** 微信出站 CDNMedia.aes_key = base64(32 字符 hex key 的 ASCII 字节)（44 字符 base64）。 */
export function b64HexKey(aeskeyHex) {
  return Buffer.from(String(aeskeyHex ?? ''), 'utf8').toString('base64');
}

/**
 * 按接收端逻辑解析出站 media.aes_key：base64 decode → 32 字符 hex → hex decode 得到 16 字节 AES key。
 * @returns {Buffer} 16 字节 key
 */
export function parseOutboundAesKey(aesKeyBase64) {
  const ascii = Buffer.from(String(aesKeyBase64 ?? ''), 'base64').toString('utf8');
  assert.match(ascii, /^[0-9a-f]{32}$/, `出站 aes_key base64 decode 后应为 32 字符 hex，实际=${JSON.stringify(ascii.slice(0, 64))}`);
  const key = Buffer.from(ascii, 'hex');
  assert.equal(key.length, 16, 'hex decode 后应为 16 字节 AES-128 key');
  return key;
}
