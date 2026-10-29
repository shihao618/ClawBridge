<#
.SYNOPSIS
  ClawBridge 本地一键演示脚本（Windows PowerShell）：启动 app + mock 微信 iLink 全栈。

.DESCRIPTION
  自动完成：
    1) 检查 Docker / docker compose；
    2) 若无 .env 则从 .env.example 复制并提示修改密码（.env 不会提交到仓库）；
    3) docker compose -f docker-compose.yml -f docker-compose.demo.yml --profile demo up -d --build；
    4) 等待 mock-ilink 与 app 健康检查通过；
    5) 打印访问地址、初始凭据获取方式、mock 自动绑定说明与排查命令。

  演示模式无需真实微信：页面生成二维码后，mock 会在 MOCK_AUTO_CONFIRM_MS（默认 3s）后
  自动“扫码 + 确认”，绑定自动完成；随后可在 /admin 登录并发送消息，
  用 mock 控制面 /__mock/state 查看 sentMessages 验证投递。

.PARAMETER Action
  up（默认）启动并等待健康；down 停止；status 查看状态；logs 查看最近日志。

.PARAMETER Volumes
  down 时同时删除数据卷 clawbridge-data（会清空已绑定用户与消息）。

.PARAMETER NoBuild
  up 时跳过 --build（复用已有镜像）。

.PARAMETER TimeoutSec
  等待健康检查的最长秒数（默认 180）。

.EXAMPLE
  scripts/demo.ps1
  一键启动演示环境（首次会自动构建镜像）。

.EXAMPLE
  scripts/demo.ps1 status
  查看容器与健康状态。

.EXAMPLE
  scripts/demo.ps1 down
  停止演示环境（保留数据卷）。
#>
[CmdletBinding()]
param(
  [ValidateSet('up', 'down', 'status', 'logs')]
  [string]$Action = 'up',

  [switch]$Volumes,

  [switch]$NoBuild,

  [int]$TimeoutSec = 180
)

$ErrorActionPreference = 'Stop'
$RepoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $RepoRoot

$ComposeArgs = @(
  'compose',
  '-f', 'docker-compose.yml',
  '-f', 'docker-compose.demo.yml',
  '--profile', 'demo'
)

function Write-Step([string]$Message) {
  Write-Host ""
  Write-Host "==> $Message" -ForegroundColor Cyan
}

function Write-Ok([string]$Message) {
  Write-Host "  [OK] $Message" -ForegroundColor Green
}

function Write-WarnLine([string]$Message) {
  Write-Host "  [WARN] $Message" -ForegroundColor Yellow
}

function Write-Fail([string]$Message) {
  Write-Host "  [FAIL] $Message" -ForegroundColor Red
}

function Invoke-Compose {
  param([Parameter(Mandatory = $true)][string[]]$Arguments)
  & docker @ComposeArgs @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "docker compose $($Arguments -join ' ') 失败（exit code $LASTEXITCODE）"
  }
}

function Get-DotEnv {
  $map = @{}
  $envPath = Join-Path $RepoRoot '.env'
  if (-not (Test-Path $envPath)) { return $map }
  foreach ($line in Get-Content -LiteralPath $envPath) {
    if ($line -match '^\s*#') { continue }
    if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$') {
      $key = $Matches[1]
      $value = $Matches[2].Trim()
      if ($value -match '^"(.*)"$') { $value = $Matches[1] }
      elseif ($value -match "^'(.*)'$") { $value = $Matches[1] }
      $map[$key] = $value
    }
  }
  return $map
}

function Get-Setting {
  param($Map, [string]$Name, [string]$Default)
  $fromProcess = [Environment]::GetEnvironmentVariable($Name)
  if ($fromProcess) { return $fromProcess }
  if ($Map -and $Map.ContainsKey($Name) -and $Map[$Name]) { return $Map[$Name] }
  return $Default
}

function Assert-Docker {
  Write-Step '检查 Docker 环境'
  $dockerCmd = Get-Command docker -ErrorAction SilentlyContinue
  if (-not $dockerCmd) {
    throw '未找到 docker 命令：请先安装 Docker Desktop 并确认已加入 PATH。'
  }
  $serverVersion = & docker version --format '{{.Server.Version}}' 2>&1
  if ($LASTEXITCODE -ne 0) {
    Write-Fail "Docker daemon 未运行：$serverVersion"
    throw '请先启动 Docker Desktop / Docker daemon 后重试。'
  }
  $composeVersion = & docker compose version --short 2>&1
  if ($LASTEXITCODE -ne 0) {
    throw '未找到 docker compose 插件（需要 Docker Compose v2+）。'
  }
  Write-Ok "Docker $serverVersion，Compose $composeVersion"
}

function Ensure-EnvFile {
  Write-Step '检查 .env 配置'
  $envPath = Join-Path $RepoRoot '.env'
  if (Test-Path $envPath) {
    Write-Ok '.env 已存在（未被 .gitignore 提交）'
    return $false
  }
  $examplePath = Join-Path $RepoRoot '.env.example'
  if (-not (Test-Path $examplePath)) {
    throw '未找到 .env 与 .env.example：请在仓库根目录执行本脚本。'
  }
  Copy-Item -LiteralPath $examplePath -Destination $envPath
  Write-WarnLine '未找到 .env，已从 .env.example 复制一份演示配置'
  Write-WarnLine '演示可用默认值；初始管理密码/API Token 首启自动写入数据卷'
  return $true
}

function Wait-HttpOk {
  param(
    [Parameter(Mandatory = $true)][string]$Url,
    [Parameter(Mandatory = $true)][string]$Name,
    [int]$Timeout = 180
  )
  Write-Step "等待 $Name 健康检查：$Url（最多 ${Timeout}s）"
  $deadline = (Get-Date).AddSeconds($Timeout)
  $lastError = ''
  while ((Get-Date) -lt $deadline) {
    try {
      $response = Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec 3
      if ($response.StatusCode -eq 200) {
        Write-Ok "$Name 已就绪：$($response.Content)"
        return
      }
      $lastError = "HTTP $($response.StatusCode)"
    }
    catch {
      $lastError = $_.Exception.Message
    }
    Start-Sleep -Milliseconds 800
  }
  throw "$Name 在 ${Timeout}s 内未通过健康检查。最后错误：$lastError"
}

function Show-Summary {
  param(
    [string]$AppPort,
    [string]$MockPort,
    [bool]$EnvWasCreated,
    [string]$MockAutoConfirmMs
  )
  $base = "http://127.0.0.1:$AppPort"
  $mock = "http://127.0.0.1:$MockPort"

  Write-Host ""
  Write-Host '==========================================================================' -ForegroundColor Green
  Write-Host ' ClawBridge 演示环境已就绪（app + mock 微信 iLink 全栈）' -ForegroundColor Green
  Write-Host '==========================================================================' -ForegroundColor Green
  Write-Host ''
  Write-Host '  绑定页（公开）:   ' -NoNewline; Write-Host "$base/bind" -ForegroundColor White
  Write-Host '  管理后台:         ' -NoNewline; Write-Host "$base/admin" -ForegroundColor White
  Write-Host '  API 文档页:       ' -NoNewline; Write-Host "$base/docs" -ForegroundColor White
  Write-Host '  mock 控制面:      ' -NoNewline; Write-Host "$mock/__mock/state" -ForegroundColor White
  Write-Host ''
  Write-Host '  管理员密码:       ' -NoNewline
  Write-Host 'docker exec clawbridge-app cat /app/data/admin-password.txt' -ForegroundColor Yellow
  Write-Host '  API Token:        ' -NoNewline
  Write-Host 'docker exec clawbridge-app cat /app/data/api-token.txt' -ForegroundColor Yellow
  if ($EnvWasCreated) {
    Write-Host '                    （首次启动自动生成；登录后可在「运行配置 → 安全」修改/重置）'
  }
  Write-Host ''
  Write-Host '  如何完成 mock 扫码绑定（无需手机微信）:' -ForegroundColor Cyan
  Write-Host "    1. 浏览器打开 $base/bind，输入昵称并点击「生成绑定二维码」"
  Write-Host "    2. mock 演示模式会在约 $MockAutoConfirmMs ms 后自动扫码+确认，页面自动显示「绑定成功」"
  Write-Host '    3. 打开发送/管理后台用密码登录，在用户列表点「发消息」'
  Write-Host "    4. 验证投递：curl.exe -s $mock/__mock/state   → 查看 sentMessages[].text / contextToken"
  Write-Host ''
  Write-Host '  常用命令:' -ForegroundColor Cyan
  Write-Host '    查看状态：  scripts/demo.ps1 status'
  Write-Host '    查看日志：  scripts/demo.ps1 logs'
  Write-Host '    停止环境：  scripts/demo.ps1 down        # 加 -Volumes 同时清空数据卷'
  Write-Host '    查看 mock 状态（PowerShell）:'
  Write-Host "      (Invoke-RestMethod $mock/__mock/state).sentMessages | Format-Table"
  Write-Host ''
}

try {
  switch ($Action) {
    'up' {
      Assert-Docker
      $envWasCreated = Ensure-EnvFile
      $envMap = Get-DotEnv
      $appPort = Get-Setting -Map $envMap -Name 'PORT' -Default '10380'
      $mockPort = Get-Setting -Map $envMap -Name 'MOCK_PORT' -Default '3100'
      $mockAutoConfirm = Get-Setting -Map $envMap -Name 'MOCK_AUTO_CONFIRM_MS' -Default '3000'

      $upArgs = @('up', '-d')
      if (-not $NoBuild) { $upArgs += '--build' }
      Write-Step "启动全栈容器（mock-ilink + app，宿主端口 app=$appPort mock=$mockPort）"
      Invoke-Compose -Arguments $upArgs

      Wait-HttpOk -Url "http://127.0.0.1:$mockPort/__mock/health" -Name 'mock-ilink' -Timeout $TimeoutSec
      Wait-HttpOk -Url "http://127.0.0.1:$appPort/health" -Name 'app' -Timeout $TimeoutSec
      Show-Summary -AppPort $appPort -MockPort $mockPort -EnvWasCreated $envWasCreated -MockAutoConfirmMs $mockAutoConfirm
    }
    'down' {
      Assert-Docker
      $downArgs = @('down', '--remove-orphans')
      if ($Volumes) { $downArgs += '-v' }
      Write-Step '停止演示环境'
      Invoke-Compose -Arguments $downArgs
      if ($Volumes) {
        Write-Ok '容器与数据卷 clawbridge-data 已删除'
      }
      else { Write-Ok '容器已停止（数据卷 clawbridge-data 保留；如需清空用 down -Volumes）' }
    }
    'status' {
      Assert-Docker
      Write-Step '当前服务状态'
      Invoke-Compose -Arguments @('ps')
      $envMap = Get-DotEnv
      $appPort = Get-Setting -Map $envMap -Name 'PORT' -Default '3000'
      $mockPort = Get-Setting -Map $envMap -Name 'MOCK_PORT' -Default '3100'
      Write-Host ''
      Write-Host "  app:  http://127.0.0.1:$appPort/health"
      Write-Host "  mock: http://127.0.0.1:$mockPort/__mock/health"
    }
    'logs' {
      Assert-Docker
      Write-Step '最近 200 行日志（app + mock）'
      Invoke-Compose -Arguments @('logs', '--tail=200')
    }
  }
  exit 0
}
catch {
  Write-Host ""
  Write-Fail $_.Exception.Message
  Write-Host ""
  Write-Host '排查建议：' -ForegroundColor Yellow
  Write-Host '  - docker compose ps                 # 查看容器状态'
  Write-Host '  - docker compose logs --tail=100    # 查看启动日志'
  Write-Host '  - 确认 10380 / 3100 端口未被占用'
  Write-Host '  - 确认 .env 存在（可由 .env.example 复制）'
  exit 1
}
