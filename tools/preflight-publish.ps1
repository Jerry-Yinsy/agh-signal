<#
发布前体检：检查不该公开的内容、可能的密钥、以及会阻碍推送的大文件。
用法：.\preflight-publish.ps1 -ProjectDir 'D:\dev\agnes-project\agh-signal'
退出码 0 = 可以发布（可能有提醒）；1 = 发现必须处理的问题。
#>
param(
  [string]$ProjectDir = 'D:\dev\agnes-project\agh-signal'
)

$utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8
$ErrorActionPreference = 'Continue'

if (-not (Test-Path -LiteralPath $ProjectDir)) { throw "找不到项目目录：$ProjectDir" }
Set-Location -LiteralPath $ProjectDir

$blockers = @()
$warnings = @()
$notes = @()

Write-Host '== 1/5 检查不该入库的目录与文件 ==' -ForegroundColor Cyan
$forbidden = @(
  'agh-home',
  '.agh',
  'node_modules',
  'artifacts\evidence',
  'artifacts\sumo'
)
foreach ($item in $forbidden) {
  $path = Join-Path $ProjectDir $item
  if (Test-Path -LiteralPath $path) {
    $notes += "存在 $item（已由 .gitignore 排除，确认它确实被忽略即可）"
  }
}
$htmlFiles = @(Get-ChildItem -LiteralPath $ProjectDir -Recurse -Filter '*.html' -ErrorAction SilentlyContinue |
  Where-Object { $_.FullName -notmatch 'node_modules' })
if ($htmlFiles.Count -gt 0) {
  $warnings += "发现 $($htmlFiles.Count) 个 HTML 文件（会话导出）：$($htmlFiles[0].Name) 等；它们包含会话正文，已按 .gitignore 排除，别手动 git add -f"
}

Write-Host '== 2/5 扫描可能的密钥与凭据 ==' -ForegroundColor Cyan
$secretPatterns = @(
  'sk-[A-Za-z0-9]{16,}',
  'ghp_[A-Za-z0-9]{20,}',
  'github_pat_[A-Za-z0-9_]{20,}',
  'AKIA[0-9A-Z]{16}',
  'Bearer\s+[A-Za-z0-9\-_\.]{20,}',
  '(?i)api[_-]?key\s*[:=]\s*[''"]?[A-Za-z0-9\-_]{16,}',
  '(?i)secret\s*[:=]\s*[''"]?[A-Za-z0-9\-_]{16,}'
)
$scannable = Get-ChildItem -LiteralPath $ProjectDir -Recurse -File -ErrorAction SilentlyContinue |
  Where-Object {
    $_.FullName -notmatch '\\node_modules\\|\\artifacts\\evidence\\|\\artifacts\\sumo\\|\\\.git\\' -and
    $_.Length -lt 2MB -and
    $_.Extension -match '^\.(md|mjs|js|ts|json|ps1|yaml|yml|txt|html)$'
  }
$secretHits = @()
foreach ($file in $scannable) {
  $text = Get-Content -LiteralPath $file.FullName -Raw -ErrorAction SilentlyContinue
  if (-not $text) { continue }
  foreach ($pattern in $secretPatterns) {
    if ($text -match $pattern) {
      $secretHits += "$($file.FullName.Replace($ProjectDir + '\', '')) 命中模式 $pattern"
    }
  }
}
if ($secretHits.Count -gt 0) {
  $blockers += '疑似密钥：' + ($secretHits -join ' | ')
} else {
  Write-Host '      未发现疑似密钥' -ForegroundColor Green
}

Write-Host '== 3/5 扫描本机绝对路径（提醒，不阻断）==' -ForegroundColor Cyan
$pathHits = @()
foreach ($file in $scannable) {
  $text = Get-Content -LiteralPath $file.FullName -Raw -ErrorAction SilentlyContinue
  if ($text -and ($text -match 'D:\\dev\\|C:\\Users\\')) {
    $pathHits += $file.FullName.Replace($ProjectDir + '\', '')
  }
}
if ($pathHits.Count -gt 0) {
  $warnings += "以下文件含本机绝对路径（公开仓库里建议在 README 里说明：示例路径可自行替换）：$($pathHits -join '、')"
}

Write-Host '== 4/5 检查大文件（GitHub 单文件上限 100MB）==' -ForegroundColor Cyan
$bigFiles = @(Get-ChildItem -LiteralPath $ProjectDir -Recurse -File -ErrorAction SilentlyContinue |
  Where-Object { $_.FullName -notmatch '\\node_modules\\' -and $_.Length -gt 20MB })
if ($bigFiles.Count -gt 0) {
  $warnings += '大文件（需确认是否要提交）：' + (($bigFiles | ForEach-Object { "$($_.Name) $([math]::Round($_.Length/1MB,1))MB" }) -join '、')
}

Write-Host '== 5/5 检查 git 身份与忽略规则生效情况 ==' -ForegroundColor Cyan
$userName = git config user.name
$userEmail = git config user.email
if (-not $userName -or -not $userEmail) {
  $blockers += 'git 身份未配置：可执行 git config --global user.name / user.email，或用 publish-github.ps1 的 -GitUserName / -GitUserEmail 只写入本仓库'
}
if (Test-Path -LiteralPath (Join-Path $ProjectDir '.git')) {
  # 用"目录内的一个假想文件"来探测，直接探测目录名在目录不存在时不会命中
  $ignored = git check-ignore -v 'artifacts/evidence/probe.txt' 2>$null
  if (-not $ignored) { $ignored = git check-ignore -v 'agh-home/probe.txt' 2>$null }
  if (-not $ignored) { $warnings += '.gitignore 可能没生效，请确认文件在项目根目录且已提交' }
  else { Write-Host ("      .gitignore 已生效：{0}" -f $ignored) -ForegroundColor Green }
} else {
  $notes += '尚未 git init（下一步做）'
}

Write-Host ''
if ($blockers.Count -gt 0) {
  Write-Host '必须处理（blockers）：' -ForegroundColor Red
  foreach ($item in $blockers) { Write-Host "  ✗ $item" -ForegroundColor Red }
}
if ($warnings.Count -gt 0) {
  Write-Host '建议检查（warnings）：' -ForegroundColor Yellow
  foreach ($item in $warnings) { Write-Host "  ! $item" -ForegroundColor Yellow }
}
if ($notes.Count -gt 0) {
  Write-Host '信息（notes）：' -ForegroundColor DarkGray
  foreach ($item in $notes) { Write-Host "  - $item" -ForegroundColor DarkGray }
}

Write-Host ''
if ($blockers.Count -eq 0) {
  Write-Host '结论：可以发布（处理完上面的 warnings 更稳妥）' -ForegroundColor Green
  exit 0
} else {
  Write-Host '结论：先解决 blockers 再发布' -ForegroundColor Red
  exit 1
}
