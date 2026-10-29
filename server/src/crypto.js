/**
 * 加密与签名工具（不依赖第三方库）。
 *
 * - encryptSecret / decryptSecret：AES-256-GCM，用于 bot_token / context_token
 *   等敏感凭证的落库加密。密钥由 APP_SECRET 派生。
 * - hashToken：绑定会话 token 的哈希（DB/内存只保存哈希）。
 * - signAdminSession / verifyAdminSession：管理后台 Cookie 的 HMAC 签名。
 */
import crypto from 'node:crypto';

import { config } from './config.js';

const ENC_PREFIX = 'v1';
const TOKEN_KEY = crypto.createHash('sha256').update(`clawbridge:secret:v1:${config.secrets.appSecret}`).digest();
// 管理会话签名只依赖 APP_SECRET（管理密码已改为 DB 管理，不再参与派生，
// 避免首次引导生成随机密码/后台改密导致所有已登录会话失效）。
const SESSION_KEY = crypto
  .createHash('sha256')
  .update(`clawbridge:session:v2:${config.secrets.appSecret}`)
  .digest();

function b64urlEncode(buf) {
  return Buffer.from(buf).toString('base64url');
}

function b64urlDecode(str) {
  return Buffer.from(str, 'base64url');
}

/** AES-256-GCM 加密任意 UTF-8 字符串，返回可落库的 ASCII 串。 */
export function encryptSecret(plaintext) {
  if (plaintext === null || plaintext === undefined) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', TOKEN_KEY, iv);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [ENC_PREFIX, b64urlEncode(iv), b64urlEncode(tag), b64urlEncode(ciphertext)].join('.');
}

/** 解密 encryptSecret 的输出；格式非法/被篡改时抛错。 */
export function decryptSecret(encoded) {
  if (!encoded) return null;
  if (typeof encoded !== 'string') throw new Error('decryptSecret: 输入必须是字符串');
  const parts = encoded.split('.');
  if (parts.length !== 4 || parts[0] !== ENC_PREFIX) throw new Error('decryptSecret: 未知的密文格式');
  const [, ivB64, tagB64, dataB64] = parts;
  const decipher = crypto.createDecipheriv('aes-256-gcm', TOKEN_KEY, b64urlDecode(ivB64));
  decipher.setAuthTag(b64urlDecode(tagB64));
  return Buffer.concat([decipher.update(b64urlDecode(dataB64)), decipher.final()]).toString('utf8');
}

/** 解密失败返回 null（用于读取历史数据时容忍损坏）。 */
export function decryptSecretOrNull(encoded) {
  try {
    return decryptSecret(encoded);
  } catch {
    return null;
  }
}

/** 生成 URL 安全的随机 token。 */
export function randomToken(bytes = 24) {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function randomUuid() {
  return crypto.randomUUID();
}

/** 绑定会话 token 的 SHA-256 哈希（用于比较，不保存明文）。 */
export function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

/** 常量时间比较两个字符串（先做定长 SHA-256，避免长度差异导致的时序侧信道）。 */
export function timingSafeEqualStr(a, b) {
  const digestA = crypto.createHash('sha256').update(String(a ?? ''), 'utf8').digest();
  const digestB = crypto.createHash('sha256').update(String(b ?? ''), 'utf8').digest();
  return crypto.timingSafeEqual(digestA, digestB);
}

// ---------------------------------------------------------------------------
// 管理密码哈希（scrypt；DB 只存自描述哈希记录，可回退 env）
// ---------------------------------------------------------------------------
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 32;

/** 生成 scrypt 密码哈希：`scrypt$N$r$p$saltB64url$hashB64url`。 */
export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password ?? ''), salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });
  return ['scrypt', SCRYPT_N, SCRYPT_R, SCRYPT_P, salt.toString('base64url'), hash.toString('base64url')].join('$');
}

/** 校验密码与 hashPassword 生成的记录；格式非法/不匹配返回 false。 */
export function verifyPassword(password, record) {
  if (typeof record !== 'string' || typeof password !== 'string') return false;
  const parts = record.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const n = Number.parseInt(parts[1], 10);
  const r = Number.parseInt(parts[2], 10);
  const p = Number.parseInt(parts[3], 10);
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  if (n < 1024 || n > 1 << 20 || r < 1 || r > 32 || p < 1 || p > 16) return false;
  let salt;
  let expected;
  try {
    salt = Buffer.from(parts[4], 'base64url');
    expected = Buffer.from(parts[5], 'base64url');
  } catch {
    return false;
  }
  if (expected.length < 16 || expected.length > 128) return false;
  let actual;
  try {
    actual = crypto.scryptSync(password, salt, expected.length, { N: n, r, p });
  } catch {
    return false;
  }
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function sign(payloadB64) {
  return crypto.createHmac('sha256', SESSION_KEY).update(payloadB64).digest('base64url');
}

/** 生成管理后台会话 Cookie 值：base64url(payload).hmac */
export function signAdminSession({ ttlMs = config.session.ttlMs } = {}) {
  const now = Date.now();
  const payload = { sub: 'admin', iat: now, exp: now + ttlMs };
  const payloadB64 = b64urlEncode(JSON.stringify(payload));
  return `${payloadB64}.${sign(payloadB64)}`;
}

/** 校验管理后台会话 Cookie；无效或过期返回 null。 */
export function verifyAdminSession(cookieValue) {
  if (!cookieValue || typeof cookieValue !== 'string') return null;
  const parts = cookieValue.split('.');
  if (parts.length !== 2) return null;
  const [payloadB64, signature] = parts;
  const expected = sign(payloadB64);
  if (!timingSafeEqualStr(signature, expected)) return null;
  try {
    const payload = JSON.parse(b64urlDecode(payloadB64).toString('utf8'));
    if (payload.sub !== 'admin' || typeof payload.exp !== 'number' || payload.exp <= Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}
