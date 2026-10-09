<#
把项目发布到 GitHub：先体检，再 init / add / commit / 关联远程 / push。

用法：
  # 只做本地提交，不联网（先本地看清提交了什么）
  .\publish-github.ps1 -NoPush

  # 完整发布（先在 GitHub 建好空仓库，把地址传进来）
  .\publish-github.ps1 -RepoUrl 'https://github.com/<你的用户名>/agh-signal.git'

说明：
  - 不会碰你的全局 git 配置；需要身份时用 -GitUserName/-GitUserEmail 写进本仓库的本地配置。
  - 提交前会拦住 agh-home / artifacts\evidence / *.html / *.db 这类不该公开的路径。
#>
param(
  [string]$ProjectDir = 'D:\dev\agnes-project\agh-signal',
  [string]$RepoUrl,
  [string]$Branch = 'main',
  [string]$Message = 'feat: AGH 信号配时寻优与验证闭环（首个公开版本）',
  [string]$GitUserName,
  [string]$GitUserEmail,
  [switch]$NoPush,
  [switch]$SkipPreflight
)

$utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8
$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $ProjectDir)) { throw "找不到项目目录：$ProjectDir" }
Set-Location -LiteralPath $ProjectDir

Write-Host '[1/6] 初始化仓库' -ForegroundColor Cyan
if (-not (Test-Path -LiteralPath (Join-Path $ProjectDir '.git'))) {
  git init -b $Branch | Out-Null
  Write-Host "      已创建 git 仓库，分支 $Branch"
} else {
  Write-Host '      已存在 .git，跳过 init'
}

if ($GitUserName) { git config user.name $GitUserName }
if ($GitUserEmail) { git config user.email $GitUserEmail }
$name = git config user.name
$email = git config user.email
if (-not $name -or -not $email) {
  throw 'git 身份未配置。二选一：① 配置全局 git config --global user.name/user.email；② 重跑本脚本并带 -GitUserName/-GitUserEmail（只写入本仓库）。'
}
Write-Host ("      提交身份：{0} <{1}>" -f $name, $email)

if (-not $SkipPreflight) {
  Write-Host '[2/6] 发布前体检' -ForegroundColor Cyan
  $preflight = Join-Path $ProjectDir 'tools\preflight-publish.ps1'
  if (Test-Path -LiteralPath $preflight) {
    & powershell -NoProfile -ExecutionPolicy Bypass -File $preflight -ProjectDir $ProjectDir
    if ($LASTEXITCODE -ne 0) {
      throw '体检未通过（见上面的 blockers）。处理后再运行，或加 -SkipPreflight 强制继续（不建议）。'
    }
  } else {
    Write-Host '      跳过：找不到 tools\preflight-publish.ps1' -ForegroundColor Yellow
  }
} else {
  Write-Host '[2/6] 跳过体检（-SkipPreflight）' -ForegroundColor Yellow
}

Write-Host '[3/6] 暂存文件' -ForegroundColor Cyan
git add -A

Write-Host '[4/6] 检查暂存区（拦截不该公开的路径）' -ForegroundColor Cyan
$staged = @(git diff --cached --name-only)
$forbiddenPattern = '^(agh-home/|\.agh/|artifacts/evidence/|artifacts/sumo/|.*\.html$|.*\.db(-wal|-shm)?$|node_modules/)'
$bad = @($staged | Where-Object { $_ -match $forbiddenPattern })
if ($bad.Count -gt 0) {
  Write-Host '      以下文件不该公开，已中止：' -ForegroundColor Red
  $bad | ForEach-Object { Write-Host "        $_" -ForegroundColor Red }
  Write-Host '      处理：把它们加进 .gitignore，然后 git rm --cached <路径> 再重跑。' -ForegroundColor Yellow
  throw '暂存区包含敏感路径'
}
Write-Host ("      暂存 {0} 个文件，未发现敏感路径" -f $staged.Count) -ForegroundColor Green

if ($staged.Count -eq 0) {
  Write-Host '      没有需要提交的改动。' -ForegroundColor Yellow
} else {
  Write-Host '[5/6] 提交' -ForegroundColor Cyan
  git commit -m $Message | Out-Null
  $sha = git rev-parse --short HEAD
  Write-Host ("      已提交：{0}" -f $sha)
}

if ($NoPush -or -not $RepoUrl) {
  Write-Host ''
  Write-Host '本地步骤完成（未推送）。' -ForegroundColor Green
  Write-Host '接下来：在 GitHub 建一个空仓库（不要勾选 README/gitignore/license），然后执行：' -ForegroundColor Cyan
  Write-Host ("  git remote add origin <仓库地址>   # 已有则 git remote set-url origin <仓库地址>")
  Write-Host ("  git push -u origin {0}" -f $Branch)
  exit 0
}

Write-Host '[6/6] 关联远程并推送' -ForegroundColor Cyan
$existing = git remote get-url origin 2>$null
if ($existing) {
  if ($existing -ne $RepoUrl) { git remote set-url origin $RepoUrl }
  Write-Host ("      origin 已指向 {0}" -f $RepoUrl)
} else {
  git remote add origin $RepoUrl
  Write-Host ("      已添加 origin {0}" -f $RepoUrl)
}
git push -u origin $Branch
Write-Host ''
Write-Host '推送完成。建议再核对一次：' -ForegroundColor Green
Write-Host '  git ls-files | Select-String -Pattern "agh-home|evidence|\.html$|\.db$"   # 应无输出'
