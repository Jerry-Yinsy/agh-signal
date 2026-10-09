param(
  [string]$Scenario = 'normal'
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
Set-Location $root

Write-Host '== 0/4 环境自检 =='
node --version

Write-Host '== 1/4 工况清单 =='
node src\cli.mjs scenarios | Out-Host

Write-Host '== 2/4 逐工况最优配时 =='
node src\cli.mjs selfcheck | Out-Host

Write-Host '== 3/4 生成报告与验证证据 =='
node src\cli.mjs report --scenario $Scenario | Out-Host

Write-Host '== 4/4 产物位置 =='
Write-Host "  寻优报告: $root\artifacts\report-$Scenario.md"
Write-Host "  验证报告: $root\artifacts\verification.md"
Write-Host "  原始数据: $root\artifacts\optimize-$Scenario.json"
