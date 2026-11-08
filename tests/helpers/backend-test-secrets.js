/**
 * 测试辅助（非测试用例）：把测试 env 中的 ADMIN_PASSWORD/API_TOKEN 写入 app_settings 并加载，
 * 模拟 settings.bootstrapSecrets() 之后的 DB-only 机密状态。
 * 说明：生产代码已无 env 回退；单元测试通过该 helper 显式 seed DB 后使用原 env 字面量登录/鉴权。
 */
import { nowMs, run } from '../../server/src/db.js';
import { encryptSecret, hashPassword } from '../../server/src/crypto.js';
import * as settings from '../../server/src/settings.js';

/** 写入 DB 哈希/密文并 loadOverrides，返回 seed 使用的明文（仅测试）。 */
export function seedTestAdminSecrets() {
  const password = String(process.env.ADMIN_PASSWORD ?? '');
  const token = String(process.env.API_TOKEN ?? '');
  if (!password) throw new Error('测试需要显式设置 ADMIN_PASSWORD 环境变量（仅用于 seed DB，不再由 config 读取）');
  run(
    `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    'security.adminPasswordHash',
    JSON.stringify(hashPassword(password)),
    nowMs(),
  );
  if (token) {
    run(
      `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      'security.apiTokenEnc',
      JSON.stringify(encryptSecret(token)),
      nowMs(),
    );
  }
  settings.loadOverrides();
  return { password, token };
}
