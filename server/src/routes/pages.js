/**
 * 静态资源与页面路由（必须挂在全部 API 路由之后、404 之前）。
 */
import express from 'express';

import { WEB_DIR, sendPage } from '../http/helpers.js';

export function registerPagesRoutes(app) {
  app.use(
    express.static(WEB_DIR, {
      index: false,
      fallthrough: true,
      setHeaders(res) {
        // 版本升级后浏览器必须重新校验 JS/CSS，避免继续使用旧界面。
        res.setHeader('Cache-Control', 'no-cache, must-revalidate');
      },
    }),
  );

  // 首页与扫码绑定页是同一个页面：统一使用 /，/bind 只做 302 跳转
  app.get('/', (req, res, next) => sendPage(res, 'index.html', next));
  app.get('/bind', (req, res) => res.redirect(302, '/'));
  app.get('/admin', (req, res, next) => sendPage(res, 'admin.html', next));
  app.get('/docs', (req, res, next) => sendPage(res, 'docs.html', next));
}
