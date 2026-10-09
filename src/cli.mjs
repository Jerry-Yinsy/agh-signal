#!/usr/bin/env node
// 统一工具入口：AGH 通过调用本 CLI 连接本项目的模型、优化器、验证器与 SUMO 仿真环境。
// 约定：stdout 只输出 JSON（便于 Agent 解析与留证），人读报告写到 artifacts/。
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { evaluateDesign } from './model.mjs'
import { getScenario, resolveScenarios } from './scenarios.mjs'
import { optimizationReport } from './verify.mjs'
import { runVerification } from './verify.mjs'
import { inspectTlLogic, simulateWithSumo, sumoStatus } from './sumo.mjs'
import { searchDesigns } from './optimize.mjs'

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const artifactsDir = join(projectRoot, 'artifacts')

function parseArgs(argv) {
  const args = { _: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token.startsWith('--')) {
      const key = token.slice(2)
      const next = argv[index + 1]
      if (next === undefined || next.startsWith('--')) args[key] = true
      else {
        args[key] = next
        index += 1
      }
    } else args._.push(token)
  }
  return args
}

const emit = (payload, exitCode = 0) => {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
  process.exitCode = exitCode
}

function markdownReport(report) {
  const lines = []
  lines.push(`# 信号配时寻优报告｜${report.scenario.name}（${report.scenario.id}）`)
  lines.push('')
  lines.push(`- 工况说明：${report.scenario.note}`)
  lines.push(`- 评估方案数：${report.evaluated}（可行 ${report.feasible}）`)
  lines.push(`- 设计空间：周期 ${report.designSpace.cycle}；${report.designSpace.greenSplit}`)
  lines.push('')
  if (!report.feasible) {
    lines.push('## 结论：该工况不可行')
    lines.push('')
    lines.push('所有候选方案的饱和度或最小绿灯约束都不满足，说明路口需求超过信号配时可解范围。')
    lines.push('建议按以下顺序处理：1) 增加进口车道或专用转向；2) 做干线协调/区域控制分流；3) 需求管理。')
  } else {
    lines.push('## 最优方案（按车均延误排序）')
    lines.push('')
    lines.push('| 排名 | 周期(s) | 南北绿(s) | 东西绿(s) | 车均延误(s) | 总延误(veh·h/h) | 最大 v/c | 最差进口延误(s) |')
    lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |')
    report.top.forEach((row, index) => {
      lines.push(
        `| ${index + 1} | ${row.cycle} | ${row.greenNS} | ${row.greenEW} | ${row.avgDelaySec} | ${row.totalDelayVehHours} | ${row.maxVc} | ${row.worstApproachDelaySec} |`,
      )
    })
    if (report.comparison) {
      const { baselines, improvement } = report.comparison
      lines.push('')
      lines.push('## 与基线对比')
      lines.push('')
      lines.push('| 方案 | 周期(s) | 南北绿(s) | 车均延误(s) | 总延误(veh·h/h) |')
      lines.push('| --- | --- | --- | --- | --- |')
      lines.push(
        `| 现状固定配时 | ${baselines.current.design.cycle} | ${baselines.current.design.greenNS} | ${baselines.current.metrics?.avgDelaySec} | ${baselines.current.metrics?.totalDelayVehHours} |`,
      )
      lines.push(
        `| Webster 经典配时 | ${baselines.webster.design.cycle} | ${baselines.webster.design.greenNS} | ${baselines.webster.metrics?.avgDelaySec} | ${baselines.webster.metrics?.totalDelayVehHours} |`,
      )
      lines.push(`| 本方案 | ${report.top[0].cycle} | ${report.top[0].greenNS} | ${report.top[0].avgDelaySec} | ${report.top[0].totalDelayVehHours} |`)
      lines.push('')
      lines.push(
        `相对现状固定配时：车均延误下降 **${improvement.avgDelayPct}%**（${improvement.avgDelaySecAbs}s/车），路口总延误下降 ${improvement.totalDelayVehHoursAbs} veh·h/h。`,
      )
      lines.push('')
      lines.push('## 公平性（Pareto 前沿）')
      lines.push('')
      lines.push('| 周期(s) | 南北绿(s) | 车均延误(s) | 最差进口延误(s) |')
      lines.push('| --- | --- | --- | --- |')
      report.pareto.slice(0, 10).forEach((row) => {
        lines.push(`| ${row.cycle} | ${row.greenNS} | ${row.avgDelaySec} | ${row.worstApproachDelaySec} |`)
      })
    }
  }
  lines.push('')
  lines.push('> 本报告由 `agh-signal` 工具链自动生成；模型假设与简化、验证方法与已知限制见 docs/01-项目方案.md。')
  lines.push('')
  return lines.join('\n')
}

function verificationMarkdown(verification) {
  const lines = []
  lines.push('# 验证报告｜信号配时寻优工具链')
  lines.push('')
  lines.push(`- 生成时间：${verification.generatedAt}`)
  lines.push(`- 基准工况：${verification.scenario}`)
  lines.push(`- 总体结论：${verification.status === 'ok' ? '**通过**' : '**未通过**'}（${verification.checks.length} 项检查）`)
  lines.push('')
  lines.push('## 逐项检查')
  lines.push('')
  lines.push('| 检查项 | 结论 | 证据/说明 |')
  lines.push('| --- | --- | --- |')
  for (const check of verification.checks) {
    lines.push(`| ${check.id} | ${check.status} | ${String(check.detail).replace(/\|/g, '/')} |`)
  }
  const boundary = verification.checks.find((check) => check.id === 'boundary-conditions')
  if (boundary?.rows?.length) {
    lines.push('')
    lines.push('## 边界工况明细')
    lines.push('')
    lines.push('| 工况 | 基准配时是否可行 | 违例 | 重新寻优后车均延误(s) | 收益 | 处置 |')
    lines.push('| --- | --- | --- | --- | --- | --- |')
    for (const row of boundary.rows) {
      lines.push(
        `| ${row.name} | ${row.inheritedFeasible ? '可行' : '不可行'} | ${(row.inheritedViolations ?? []).join('；') || '—'} | ` +
          `${row.reoptimizedAvgDelaySec ?? '—'} | ${row.reoptimizeGainPct === null ? '—' : `${row.reoptimizeGainPct}%`} | ${row.action ?? '—'} |`,
      )
    }
  }
  const failure = verification.checks.find((check) => check.id === 'failure-path')
  if (failure) {
    lines.push('')
    lines.push('## 失败样例')
    lines.push('')
    lines.push(failure.detail)
    if (failure.reasons?.length) {
      lines.push('')
      for (const reason of failure.reasons) lines.push(`- ${reason}`)
    }
  }
  lines.push('')
  lines.push('> 已知限制：分析模型为确定性宏观模型（Webster），未覆盖面控制、行人相位、公交优先与随机波动；')
  lines.push('> SUMO 微观仿真的交叉验证结果需在本机安装 SUMO 后补充（见 docs/03-SUMO接入步骤.md）。')
  lines.push('')
  return lines.join('\n')
}

const commands = {
  scenarios() {
    emit({
      scenarios: resolveScenarios().map((scenario) => ({
        id: scenario.id,
        name: scenario.name,
        kind: scenario.kind,
        note: scenario.note,
        totalDemandVehPerHour: Object.values(scenario.arrivals).reduce((sum, item) => sum + item.through + item.left, 0),
      })),
    })
  },

  simulate(args) {
    const scenario = getScenario(String(args.scenario ?? 'normal'))
    const design = {
      cycle: Number(args.cycle ?? 90),
      greenNS: Number(args['green-ns'] ?? 41),
    }
    emit({ scenario: scenario.id, design, ...evaluateDesign(scenario, design) })
  },

  optimize(args) {
    emit(optimizationReport(String(args.scenario ?? 'normal')))
  },

  verify() {
    const result = runVerification()
    emit(result, result.status === 'ok' ? 0 : 1)
  },

  report(args) {
    const scenarioId = String(args.scenario ?? 'normal')
    const report = optimizationReport(scenarioId)
    mkdirSync(artifactsDir, { recursive: true })
    const jsonPath = join(artifactsDir, `optimize-${scenarioId}.json`)
    const mdPath = join(artifactsDir, `report-${scenarioId}.md`)
    writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
    writeFileSync(mdPath, markdownReport(report), 'utf8')
    const verification = runVerification()
    writeFileSync(join(artifactsDir, 'verification.json'), `${JSON.stringify(verification, null, 2)}\n`, 'utf8')
    const verificationPath = join(artifactsDir, 'verification.md')
    writeFileSync(verificationPath, verificationMarkdown(verification), 'utf8')
    emit({
      scenario: scenarioId,
      artifacts: {
        json: jsonPath,
        markdown: mdPath,
        verification: join(artifactsDir, 'verification.json'),
        verificationMarkdown: verificationPath,
      },
      verificationStatus: verification.status,
    })
  },

  'sumo-check'() {
    emit(sumoStatus())
  },

  'sumo-map'(args) {
    const net = String(args.net ?? join(artifactsDir, 'sumo', 'net.net.xml'))
    emit({ net, programs: inspectTlLogic(net) })
  },

  'sumo-sim'(args) {
    const scenario = getScenario(String(args.scenario ?? 'normal'))
    const design = { cycle: Number(args.cycle ?? 90), greenNS: Number(args['green-ns'] ?? 41) }
    const directory = join(artifactsDir, 'sumo', scenario.id)
    const result = simulateWithSumo({ directory, scenario, design, seed: scenario.seed })
    emit({ scenario: scenario.id, design, analytic: evaluateDesign(scenario, design).metrics, sumo: result })
  },

  selfcheck() {
    const scenarios = resolveScenarios()
    const rows = scenarios.map((scenario) => {
      const search = searchDesigns(scenario, { top: 1 })
      const best = search.top[0]
      return {
        scenario: scenario.id,
        kind: scenario.kind,
        feasible: search.feasible,
        evaluated: search.evaluated,
        avgDelaySec: best?.metrics.avgDelaySec ?? null,
      }
    })
    emit({ status: 'ok', rows })
  },
}

const args = parseArgs(process.argv.slice(2))
const command = args._[0]
if (!command || command === 'help') {
  emit({
    usage: 'node src/cli.mjs <command> [--key value]',
    commands: Object.keys(commands),
  })
} else if (commands[command]) {
  commands[command](args)
} else {
  emit({ error: `未知命令 ${command}`, commands: Object.keys(commands) }, 2)
}
