#!/usr/bin/env bash
# =============================================================================
# ClawBridge 本地一键演示脚本（Linux / macOS / Git Bash）：启动 app + mock iLink 全栈。
#
# 用法：
#   scripts/demo.sh              # 启动并等待健康（首次自动构建镜像）
#   scripts/demo.sh --no-build   # 跳过 --build，复用已构建镜像
#   scripts/demo.sh status       # 查看容器状态
#   scripts/demo.sh logs         # 查看最近 200 行日志
#   scripts/demo.sh down         # 停止（保留数据卷）
#   scripts/demo.sh down --volumes   # 停止并删除数据卷 clawbridge-data
#
# 演示模式无需真实微信：页面生成二维码后，mock 会在 MOCK_AUTO_CONFIRM_MS（默认 3s）后
# 自动“扫码 + 确认”，绑定自动完成；随后在 /admin 登录发消息，用
# http://127.0.0.1:3100/__mock/state 查看 sentMessages 验证投递。
# =============================================================================
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

ACTION="${1:-up}"
shift || true

VOLUMES=0
NO_BUILD=0
for arg in "$@"; do
  case "$arg" in
    --volumes|-v) VOLUMES=1 ;;
    --no-build) NO_BUILD=1 ;;
    -h|--help) sed -n '2,20p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "未知参数：$arg（可用：--volumes --no-build）" >&2; exit 2 ;;
  esac
done

COMPOSE=(docker compose -f docker-compose.yml -f docker-compose.demo.yml --profile demo)
ENV_CREATED=0

if [ -t 1 ]; then
  C_CYAN=$'\033[36m'; C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'; C_RED=$'\033[31m'; C_RESET=$'\033[0m'
else
  C_CYAN=''; C_GREEN=''; C_YELLOW=''; C_RED=''; C_RESET=''
fi

step() { echo; echo "${C_CYAN}==> $*${C_RESET}"; }
ok()   { echo "  ${C_GREEN}[OK] $*${C_RESET}"; }
warn() { echo "  ${C_YELLOW}[WARN] $*${C_RESET}"; }
fail() { echo "  ${C_RED}[FAIL] $*${C_RESET}"; }

invoke_compose() { "${COMPOSE[@]}" "$@"; }

env_get() { # env_get KEY DEFAULT（进程环境优先，其次 .env）
  local key="$1" default="${2:-}" value
  value="${!key:-}"
  if [ -z "$value" ] && [ -f .env ]; then
    value="$(grep -E "^[[:space:]]*${key}[[:space:]]*=" .env | tail -n 1 | cut -d= -f2- | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/")"
  fi
  echo "${value:-$default}"
}

assert_docker() {
  step '检查 Docker 环境'
  command -v docker >/dev/null 2>&1 || { fail '未找到 docker 命令'; exit 1; }
  local server_version
  if ! server_version="$(docker version --format '{{.Server.Version}}' 2>/dev/null)"; then
    fail 'Docker daemon 未运行，请先启动 Docker 后重试'
    exit 1
  fi
  local compose_version
  if ! compose_version="$(docker compose version --short 2>/dev/null)"; then
    fail '未找到 docker compose 插件（需要 Compose v2+）'
    exit 1
  fi
  ok "Docker $server_version，Compose $compose_version"
}

ensure_env_file() {
  step '检查 .env 配置'
  ENV_CREATED=0
  if [ -f .env ]; then
    ok '.env 已存在（已被 .gitignore 忽略）'
    return 0
  fi
  if [ ! -f .env.example ]; then
    fail '未找到 .env 与 .env.example：请在仓库根目录执行本脚本'
    exit 1
  fi
  cp .env.example .env
  ENV_CREATED=1
  warn '未找到 .env，已从 .env.example 复制一份演示配置'
  warn '演示可用默认值；.env 中 APP_SECRET 可选，初始管理密码/API Token 首启自动写入数据卷'
}

wait_http() { # wait_http URL NAME TIMEOUT_SEC
  local url="$1" name="$2" timeout="${3:-180}"
  step "等待 $name 健康检查：$url（最多 ${timeout}s）"
  local deadline=$(( $(date +%s) + timeout )) last_error=''
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if curl -fsS --max-time 3 "$url" >/dev/null 2>&1; then
      ok "$name 已就绪（$url）"
      return 0
    fi
    last_error="HTTP 探测失败"
    sleep 0.8
  done
  fail "$name 在 ${timeout}s 内未通过健康检查（$last_error）"
  return 1
}

show_summary() {
  local app_port="$1" mock_port="$2" mock_auto="$3"
  local base="http://127.0.0.1:${app_port}"
  local mock="http://127.0.0.1:${mock_port}"
  echo
  echo "${C_GREEN}==========================================================================${C_RESET}"
  echo "${C_GREEN} ClawBridge 演示环境已就绪（app + mock 微信 iLink 全栈）${C_RESET}"
  echo "${C_GREEN}==========================================================================${C_RESET}"
  echo
  echo "  绑定页（公开）:   ${base}/bind"
  echo "  管理后台:         ${base}/admin"
  echo "  API 文档页:       ${base}/docs"
  echo "  mock 控制面:      ${mock}/__mock/state"
  echo
  echo "  管理员密码:       docker exec clawbridge-app cat /app/data/admin-password.txt"
  echo "  API Token:        docker exec clawbridge-app cat /app/data/api-token.txt"
  echo "                    （首次启动自动生成；登录后可在「运行配置 → 安全」修改/重置）"
  echo
  echo "${C_CYAN}  如何完成 mock 扫码绑定（无需手机微信）:${C_RESET}"
  echo "    1. 浏览器打开 ${base}/bind，输入昵称并点击「生成绑定二维码」"
  echo "    2. mock 演示模式会在约 ${mock_auto} ms 后自动扫码+确认，页面自动显示「绑定成功」"
  echo "    3. 打开 ${base}/admin 用密码登录，在用户列表点「发消息」"
  echo "    4. 验证投递： curl -s ${mock}/__mock/state | head -c 2000   # 查看 sentMessages"
  echo
  echo "${C_CYAN}  常用命令:${C_RESET}"
  echo "    查看状态：  scripts/demo.sh status"
  echo "    查看日志：  scripts/demo.sh logs"
  echo "    停止环境：  scripts/demo.sh down            # 加 --volumes 同时清空数据卷"
  echo "    查看 mock 状态:"
  echo "      curl -s ${mock}/__mock/state | python3 -m json.tool | less"
  echo
}

main() {
  case "$ACTION" in
    up)
      assert_docker
      ensure_env_file
      local app_port mock_port mock_auto
      app_port="$(env_get PORT 10380)"
      mock_port="$(env_get MOCK_PORT 3100)"
      mock_auto="$(env_get MOCK_AUTO_CONFIRM_MS 3000)"
      command -v curl >/dev/null 2>&1 || { fail '需要 curl 用于健康检查'; exit 1; }

      step "启动全栈容器（mock-ilink + app，宿主端口 app=${app_port} mock=${mock_port}）"
      if [ "$NO_BUILD" = "1" ]; then
        invoke_compose up -d
      else
        invoke_compose up -d --build
      fi
      wait_http "http://127.0.0.1:${mock_port}/__mock/health" 'mock-ilink' 120
      wait_http "http://127.0.0.1:${app_port}/health" 'app' 180
      show_summary "$app_port" "$mock_port" "$mock_auto"
      ;;
    down)
      assert_docker
      step '停止演示环境'
      if [ "$VOLUMES" = "1" ]; then
        invoke_compose down --remove-orphans -v
        ok '容器与数据卷 clawbridge-data 已删除'
      else
        invoke_compose down --remove-orphans
        ok '容器已停止（数据卷 clawbridge-data 保留；清空用 down --volumes）'
      fi
      ;;
    status)
      assert_docker
      step '当前服务状态'
      invoke_compose ps
      echo
      echo "  app:  http://127.0.0.1:$(env_get PORT 10380)/health"
      echo "  mock: http://127.0.0.1:$(env_get MOCK_PORT 3100)/__mock/health"
      ;;
    logs)
      assert_docker
      step '最近 200 行日志（app + mock）'
      invoke_compose logs --tail=200
      ;;
    *)
      echo "未知动作：$ACTION（可用：up | down | status | logs）" >&2
      exit 2
      ;;
  esac
}

on_error() {
  echo
  fail '演示环境启动失败'
  echo
  echo '排查建议：'
  echo '  - docker compose ps                 # 查看容器状态'
  echo '  - docker compose logs --tail=100    # 查看启动日志'
  echo '  - 确认 10380 / 3100 端口未被占用'
  echo '  - 确认 .env 存在（可由 .env.example 复制）'
}

trap on_error ERR
main
