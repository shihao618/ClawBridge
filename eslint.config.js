/**
 * ESLint flat config（本项目为无构建、零运行时依赖的原生 ESM 项目）。
 *
 * 定位：只做“容易出错/易漏”的静态检查，不强制代码格式（避免把 2 万行手工风格代码一次性重排，
 * 也无需要求 Prettier）。文件分为 Node 侧（server/mock/tests/scripts）与浏览器侧（web/assets）。
 *
 * 运行：
 *   npm run lint        # 全量检查（CI 使用 --max-warnings=0）
 *   npm run lint:fix    # 自动修复可修复项
 */
import { defineConfig } from 'eslint/config';
import globals from 'globals';

/** 两侧通用规则：只保留能发现真实缺陷或明显坏味道的项。 */
const sharedRules = {
  'no-undef': 'error',
  'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none', varsIgnorePattern: '^_' }],
  'no-const-assign': 'error',
  'no-dupe-args': 'error',
  'no-dupe-keys': 'error',
  'no-unreachable': 'error',
  'no-fallthrough': 'error',
  'no-self-assign': 'error',
  'no-unsafe-negation': 'error',
  'no-cond-assign': ['error', 'except-parens'],
  'no-redeclare': 'error',
  'no-prototype-builtins': 'error',
  'no-async-promise-executor': 'error',
  'no-irregular-whitespace': 'error',
  'no-control-regex': 'off',
  'valid-typeof': 'error',
  'eqeqeq': ['error', 'smart'],
  'prefer-const': 'warn',
  'no-empty': ['warn', { allowEmptyCatch: true }],
  'no-useless-escape': 'warn',
};

export default defineConfig([
  {
    ignores: [
      'node_modules/**',
      'data/**',
      'backups/**',
      'screenshots/**',
      'coverage/**',
      '.audit/**',
      '*.md',
    ],
  },
  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: sharedRules,
  },
  {
    // 浏览器端 ES Module（无 Node API）
    files: ['web/assets/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.browser },
    },
    rules: sharedRules,
  },
  {
    // 测试代码常有“部分夹具/工具留作后续使用”的情况，未使用变量不强制清理
    files: ['tests/**/*.js', 'tests/**/*.mjs'],
    rules: { 'no-unused-vars': 'off' },
  },
]);
