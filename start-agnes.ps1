<#
启动 Agnes Harness 本地工作台。
用法：在 PowerShell 里执行 .\start-agnes.ps1
     不想自动打开浏览器就加 -NoBrowser
关掉本窗口或按 Ctrl+C 会结束 Web 服务；后台 daemon 需要单独 stop（见文件末尾说明）。
#>
param(
  [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'

# ---- 路径配置（按你的实际位置改） ----
$repo = 'D:\dev\agnes-project\agnes-harness'
$entry = Join-Path $repo 'packages\cli\dist\local\agnes.mjs'
$env:AGH_HOME = 'D:\dev\agnes-project\agh-home'
$env:AGNES_PROFILE = 'local-dev'
$env:AGH_SIGNAL_HOME = 'D:\dev\agnes-project\agh-signal'
# -------------------------------------

if (-not (Test-Path -LiteralPath $entry)) {
  throw "找不到 AGH 入口文件：$entry（源码是否还在？是否已执行过 build:local？）"
}

Write-Host "[1/3] 检查环境" -ForegroundColor Cyan
Write-Host ("     node {0}" -f (node --version))
Write-Host ("     AGH_HOME = {0}" -f $env:AGH_HOME)
Write-Host ("     AGNES_PROFILE = {0}" -f $env:AGNES_PROFILE)
Write-Host ("     AGH_SIGNAL_HOME = {0}" -f $env:AGH_SIGNAL_HOME)
if (-not (Test-Path -LiteralPath $env:AGH_SIGNAL_HOME)) {
  Write-Host "     注意：AGH_SIGNAL_HOME 指向的目录不存在，traffic_* 工具会报错，其它功能不受影响。" -ForegroundColor Yellow
}

Set-Location -LiteralPath $repo

Write-Host "[2/3] 结束可能残留的旧后台" -ForegroundColor Cyan
try {
  node $entry daemon stop | Out-Null
} catch {
  Write-Host "     没有需要停止的后台（可忽略）" -ForegroundColor DarkGray
}

if (-not $NoBrowser) {
  Start-Job -ScriptBlock {
    Start-Sleep -Seconds 8
    Start-Process 'http://127.0.0.1:4177'
  } | Out-Null
  Write-Host "     约 8 秒后自动打开浏览器（失败就手动访问 http://127.0.0.1:4177）" -ForegroundColor DarkGray
}

Write-Host "[3/3] 启动 Web 工作台，本窗口保持开着" -ForegroundColor Cyan
Write-Host ""
node $entry serve

Write-Host ""
Write-Host "Web 服务已退出。后台 daemon 仍在时，可用下面命令停止：" -ForegroundColor Yellow
Write-Host "  node `"$entry`" daemon stop"
