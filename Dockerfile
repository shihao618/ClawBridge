# syntax=docker/dockerfile:1
# =============================================================================
# ClawBridge 生产镜像（单容器：Web 页面 + 绑定 + 管理 API + 推送 API + 入站监控 + 出站队列）
#
# 构建：docker build -t clawbridge:local .
# 运行：见 docker-compose.yml（推荐，命名卷）或 docker-compose.fnos.yml（fnOS）：
#   docker run -d --name clawbridge -p 10380:3000 \
#     -e NODE_ENV=production -e DATA_DIR=/app/data \
#     -v clawbridge-data:/app/data clawbridge:local
#   初始管理密码/API Token 会在首次启动时生成到数据卷 /app/data/ 下。
#
# 基础镜像说明：
# - 使用 node:24-alpine（Node 24 内置 node:sqlite；express/qrcode 均为纯 JS 依赖，
#   无 native 编译需求，alpine/musl 上 npm ci 可直接使用）。
# - 依赖层单独缓存：只有 package.json / package-lock.json 变化时才重新 npm ci。
# - USER node 运行；/app/data 由 compose 命名卷（或 fnOS 项目 data/）挂载并属于 node 用户。
# - HEALTHCHECK 用内置 fetch 探测 /health（无需 curl/wget）。
# =============================================================================
FROM node:24-alpine

ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/app/data

WORKDIR /app

# ---- 依赖层（利用 Docker 层缓存）----
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund \
    && npm cache clean --force

# ---- 应用代码 ----
# server: 后端（Express 5 + node:sqlite）；web: 静态页面（文档页内置在 web/docs.html）
COPY server ./server
COPY web ./web

# ---- 运行时目录与权限 ----
# /app/data 为命名卷挂载点：目录 700（仅 node 用户可读写执行）；应用写出的 DB/secret 文件
# 由进程 umask(0o077) 保证 600（见 server/src/index.js 的安全加固）。
RUN mkdir -p /app/data \
    && chmod 700 /app/data \
    && chown -R node:node /app
USER node

EXPOSE 3000

# ---- 健康检查（node fetch，5s 超时）----
HEALTHCHECK --interval=15s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/src/index.js"]
