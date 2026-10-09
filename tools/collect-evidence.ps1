<#
采集 AGH 运行证据（提交用）。

为什么不能直接导出 Web 里的会话：
  AGH 的会话归创建它的客户端身份所有（见 daemon 的 requireSessionOwner）。
  Web 界面创建的会话，一次性 CLI 导出会被 CAPABILITY_DENIED 拒绝。
  所以本脚本改用「CLI 一次性模式重跑取证」：会话归 CLI 所有，既能复现也能导出。

用法：
  .\collect-evidence.ps1                 # 跑 5 步取证 + 采集环境信息 + 生成索引
  .\collect-evidence.ps1 -OnlyExport      # 只导出已存在的 CLI 会话，不重跑
  .\collect-evidence.ps1 -SkipPrompts     # 不重跑，只做环境信息与索引
#>
param(
  [string]$Repo = 'D:\dev\agnes-project\agnes-harness',
  [string]$AghHome = 'D:\dev\agnes-project\agh-home',
  [string]$Profile = 'local-dev',
  [string]$ProjectDir = 'D:\dev\agnes-project\agh-signal',
  [switch]$SkipPrompts,
  [switch]$OnlyExport
)

$ErrorActionPreference = 'Stop'

# 关键修复：PowerShell 默认按控制台代码页解码外部程序输出，会把 node 的 UTF-8 中文变乱码，
# 导致 ConvertFrom-Json 失败。这里统一改成 UTF-8。
$utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8

$env:AGH_HOME = $AghHome
$env:AGNES_PROFILE = $Profile
$env:AGH_SIGNAL_HOME = $ProjectDir

$entry = Join-Path $Repo 'packages\cli\dist\local\agnes.mjs'
if (-not (Test-Path -LiteralPath $entry)) { throw "找不到 AGH 入口：$entry" }
if (-not (Test-Path -LiteralPath $ProjectDir)) { throw "找不到项目目录：$ProjectDir" }

# 前置检查之后放开 Stop：调用外部程序时，stderr 输出在 Stop 模式下会被当成终止错误，
# 而我们要的失败判据是退出码与产物是否存在，所以这里自己判断。
$ErrorActionPreference = 'Continue'

$evidence = Join-Path $ProjectDir 'artifacts\evidence'
New-Item -ItemType Directory -Force -Path $evidence | Out-Null

function Get-SafeName([string]$name, [int]$max = 36) {
  if (-not $name) { return 'session' }
  $safe = $name -replace '[\\/:*?"<>|\r\n\t]', '_'
  $safe = $safe.Trim()
  if ($safe.Length -gt $max) { $safe = $safe.Substring(0, $max) }
  if (-not $safe) { $safe = 'session' }
  return $safe
}

# ---------- 1. 环境与模型信息 ----------
Write-Host '[1/4] 采集版本、体检与模型配置' -ForegroundColor Cyan
& node $entry --version | Out-File -FilePath (Join-Path $evidence 'agh-version.txt') -Encoding UTF8
& node $entry doctor --json | Out-File -FilePath (Join-Path $evidence 'doctor.json') -Encoding UTF8
& node $entry doctor provider --json | Out-File -FilePath (Join-Path $evidence 'provider.json') -Encoding UTF8
(node --version) | Out-File -FilePath (Join-Path $evidence 'node-version.txt') -Encoding UTF8
Write-Host '      agh-version.txt / doctor.json / provider.json / node-version.txt'

# ---------- 2. 用 CLI 一次性模式跑取证 ----------
$prompts = @(
  '调用 traffic_scenarios 列出所有工况，并说明哪个是失败样例、为什么必须被拒绝。',
  '调用 traffic_optimize 处理 normal 工况，告诉我最优方案、公平性方案，以及与现状固定配时的差距。',
  '对 peak 和 incident 两个工况分别调用 traffic_optimize，说明基准配时是否仍然可用；不可用时要怎么处置。',
  '调用 traffic_optimize 处理 oversaturated 工况，确认它必须被拒绝，并给出降级建议。',
  '调用 traffic_report 生成报告文件，并把产物路径列出来。'
)

if (-not $SkipPrompts -and -not $OnlyExport) {
  Write-Host '[2/4] 用 CLI 一次性模式重跑 5 步取证（每步输出单独存文件）' -ForegroundColor Cyan
  Set-Location -LiteralPath $ProjectDir
  for ($i = 0; $i -lt $prompts.Count; $i++) {
    $step = $i + 1
    $file = Join-Path $evidence ('step-{0:00}.md' -f $step)
    $question = $prompts[$i]
    Write-Host ("      步骤 {0}：{1}" -f $step, $question)
    $header = @"
# 取证步骤 $step

## 提示词

$question

## AGH 输出

"@
    Set-Content -LiteralPath $file -Value $header -Encoding UTF8
    & node $entry -p $question | Out-File -FilePath $file -Append -Encoding UTF8
    $code = $LASTEXITCODE
    Add-Content -LiteralPath $file -Value "`n（退出码：$code）" -Encoding UTF8
    if ($code -ne 0) {
      Write-Host ("      步骤 {0} 返回退出码 {1}，请打开 {2} 查看原因（常见原因：模型未配置）" -f $step, $code, (Split-Path $file -Leaf)) -ForegroundColor Yellow
    }
  }
} else {
  Write-Host '[2/4] 跳过重跑取证' -ForegroundColor DarkGray
}

# ---------- 3. 导出会话（CLI 自己的会话应当可导出） ----------
Write-Host '[3/4] 尝试导出会话' -ForegroundColor Cyan
$exported = @()
try {
  $rawJson = (& node $entry sessions --json | Out-String)
  $sessions = @(($rawJson | ConvertFrom-Json).items)
  Write-Host ("      会话总数：{0}" -f $sessions.Count)

  # 只挑本项目目录下、最近创建的 5 个，避免把无关会话（例如"生成快捷方式"）也拖进证据包
  $targets = @(
    $sessions |
      Where-Object { $_.cwd -eq $ProjectDir } |
      Sort-Object { [datetime]$_.createdAt } -Descending |
      Select-Object -First 5
  )

  $index = 0
  foreach ($session in $targets) {
    $index += 1
    $shortId = $session.sessionId.Substring(0, 8)
    $base = '{0:00}-{1}-{2}' -f $index, (Get-SafeName $session.title), $shortId
    $target = Join-Path $evidence ($base + '.html')
    $ok = $false
    try {
      & node $entry export $session.sessionId --html --out $target 2>$null | Out-Null
      $ok = Test-Path -LiteralPath $target
    } catch {
      $ok = $false
    }
    if ($ok) {
      Write-Host ("      已导出：{0}" -f (Split-Path $target -Leaf)) -ForegroundColor Green
      $exported += [PSCustomObject]@{ Title = $session.title; SessionId = $session.sessionId; File = (Split-Path $target -Leaf); Ok = $true }
    } else {
      Write-Host ("      跳过（无导出权限或格式不支持）：{0}" -f $session.title) -ForegroundColor Yellow
      $exported += [PSCustomObject]@{ Title = $session.title; SessionId = $session.sessionId; File = '—'; Ok = $false }
    }
  }
} catch {
  Write-Host ("      读取会话列表失败：{0}" -f $_.Exception.Message) -ForegroundColor Yellow
}

# ---------- 4. 生成证据索引 ----------
Write-Host '[4/4] 生成证据索引' -ForegroundColor Cyan
$lines = @()
$lines += '# 运行证据索引'
$lines += ''
$lines += ("- 生成时间：{0}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))
$lines += ("- AGH_HOME：{0}（profile：{1}）" -f $AghHome, $Profile)
$lines += ("- 项目目录：{0}" -f $ProjectDir)
$lines += ''
$lines += '## 一、会话证据'
$lines += ''
$lines += '### 1. CLI 一次性模式取证（可复现，推荐作为主证据）'
$lines += ''
$lines += '| 步骤 | 文件 | 覆盖的评分维度 |'
$lines += '| --- | --- | --- |'
$lines += '| 1 工况与失败样例 | step-01.md | 问题价值、任务完成度 |'
$lines += '| 2 基准工况寻优与基线对比 | step-02.md | 任务完成度、AGH 闭环 |'
$lines += '| 3 边界工况复核 | step-03.md | 验证严谨性、异常处理 |'
$lines += '| 4 失败路径拒绝 | step-04.md | 异常处理、验证严谨性 |'
$lines += '| 5 生成报告与产物 | step-05.md | 运行证据、复现能力 |'
$lines += ''
$lines += '### 2. 会话导出'
$lines += ''
if ($exported.Count -gt 0) {
  $lines += '| 会话标题 | 会话 ID | 文件 | 结果 |'
  $lines += '| --- | --- | --- | --- |'
  foreach ($row in $exported) {
    $lines += ("| {0} | {1} | {2} | {3} |" -f $row.Title, $row.SessionId, $row.File, ($(if ($row.Ok) { '已导出' } else { '无权限/跳过' })))
  }
} else {
  $lines += '（本次没有导出成功的会话。）'
}
$lines += ''
$lines += '> 说明：Web 界面里创建的会话归 Web 客户端身份所有，一次性 CLI 导出会被 CAPABILITY_DENIED 拒绝，'
$lines += '> 这是 AGH 的所有权隔离设计。因此主证据请使用上面的 CLI 取证步骤，Web 会话用截图补充即可。'
$lines += ''
$lines += '## 二、环境与模型'
$lines += ''
$lines += '- `agh-version.txt`：AGH 与协议版本'
$lines += '- `doctor.json`：环境体检（平台能力、存储、扩展装配、后台状态）'
$lines += '- `provider.json`：模型路由配置（技术信息表要填的模型名称/环节/调用方式）'
$lines += '- `node-version.txt`：Node 运行时版本'
$lines += ''
$lines += '## 三、还需手动补的截图'
$lines += ''
$lines += '- [ ] 每步取证时工具调用的**参数**与**返回 JSON**'
$lines += '- [ ] AGH 工具列表中 5 个 `traffic_*` 工具'
$lines += '- [ ] `artifacts/report-normal.md` 与 `artifacts/verification.md` 正文'
$lines += '- [ ] Web 会话界面（补充说明模型实际参与过程）'
$lines += ''
$lines += '## 四、官方必填项对应关系'
$lines += ''
$lines += '| 官方要求 | 对应物 |'
$lines += '| --- | --- |'
$lines += '| AGH 执行记录 | step-01..05.md + 会话导出 + 截图 |'
$lines += '| 工具调用链 | step-01..05.md 中的 traffic_* 调用 |'
$lines += '| 模型参与核心任务证据 | step-02..04.md 中模型给出的结论与判断 |'
$lines += '| 测试样例（正常/边界/失败） | ..\report-normal.md、..\report-peak/skew/heavy/incident.md、..\report-oversaturated.md |'
$lines += '| 验证结果 | ..\verification.md、..\verification.json |'
$lines += ''

$indexFile = Join-Path $evidence 'README.md'
[System.IO.File]::WriteAllLines($indexFile, $lines, $utf8)

Write-Host ''
Write-Host ("完成。证据目录：{0}" -f $evidence) -ForegroundColor Green
Write-Host ("索引文件：{0}" -f $indexFile)
