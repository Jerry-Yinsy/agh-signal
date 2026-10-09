// 验证层：交叉检验、边界工况、失败样例、复现性。验证结论会写进 artifacts/verification.json。
import { createHash } from 'node:crypto'
import { baselineDesign, evaluateDesign, websterDesign } from './model.mjs'
import { compareWithBaselines, searchDesigns } from './optimize.mjs'
import { buildRoutesXml, profiles } from './demand.mjs'
import { resolveScenarios } from './scenarios.mjs'

const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

function recomputeTotals(evaluation) {
  const weighted = evaluation.movements.reduce((sum, movement) => sum + movement.volume * movement.delaySec, 0)
  const volume = evaluation.movements.reduce((sum, movement) => sum + movement.volume, 0)
  return {
    totalDelayVehHours: Number((weighted / 3600).toFixed(3)),
    avgDelaySec: Number((weighted / volume).toFixed(2)),
  }
}

/** 检查 1：模型内部自洽（总延误与车均延误可由明细重算得到）。 */
export function checkConsistency(scenario) {
  const design = searchDesigns(scenario, { top: 1 }).top[0]
  if (!design) return { id: 'consistency', status: 'fail', detail: '基准工况下没有可行方案' }
  const evaluation = evaluateDesign(scenario, design)
  const recomputed = recomputeTotals(evaluation)
  const ok =
    Math.abs(recomputed.totalDelayVehHours - evaluation.metrics.totalDelayVehHours) < 1e-3 &&
    Math.abs(recomputed.avgDelaySec - evaluation.metrics.avgDelaySec) < 1e-2
  return {
    id: 'consistency',
    status: ok ? 'ok' : 'fail',
    detail: ok
      ? `总延误 ${evaluation.metrics.totalDelayVehHours} veh·h、车均延误 ${evaluation.metrics.avgDelaySec}s 可由流向明细重算复现`
      : `重算不一致：报告 ${evaluation.metrics.avgDelaySec}s / 重算 ${recomputed.avgDelaySec}s`,
  }
}

/** 检查 2：网格最优与 Webster 经典公式交叉验证（两条独立路径应给出接近的周期与延误）。 */
export function checkWebsterAgreement(scenario) {
  const grid = searchDesigns(scenario, { top: 1 })
  if (!grid.top[0]) return { id: 'webster-agreement', status: 'fail', detail: '没有可行方案可供交叉验证' }
  const webster = websterDesign(scenario)
  const evaluated = evaluateDesign(scenario, webster)
  if (!evaluated.metrics) return { id: 'webster-agreement', status: 'fail', detail: 'Webster 方案不可评估' }
  const cycleGap = Math.abs(grid.top[0].cycle - webster.cycle)
  const delayGapPct = ((evaluated.metrics.avgDelaySec - grid.top[0].metrics.avgDelaySec) / grid.top[0].metrics.avgDelaySec) * 100
  const status = cycleGap <= 20 && delayGapPct <= 25 ? 'ok' : 'warn'
  return {
    id: 'webster-agreement',
    status,
    detail:
      `网格最优 C=${grid.top[0].cycle}s / Webster C=${webster.cycle}s（相差 ${cycleGap}s）；` +
      `车均延误 ${grid.top[0].metrics.avgDelaySec}s vs ${evaluated.metrics.avgDelaySec}s（${delayGapPct.toFixed(1)}%）`,
    caveat:
      '两条路径共用同一套延误公式（只是周期推导方式不同），因此本项属于**口径一致性核对**，' +
      '不构成独立验证；真正的独立验证来自 SUMO 微观仿真（见 docs/03）。',
  }
}

/**
 * 检查 3：复现性——对"真正进入仿真的产物"做哈希，而不是对只被自己调用的函数做哈希。
 *
 * 这里刻意验证 `profiles()`（需求波动剖面）与 `buildRoutesXml()`（SUMO 车流）两个下游产物：
 * 两者都是确定性生成，同 seed 必须逐字节一致，换 seed 必须改变——否则"同 seed 结果一致"这句
 * 结论就无从谈起。历史版本只对 profiles() 调两次做比较，输入不变必然相等，等于什么都没验证。
 */
export function checkReproducibility(scenario) {
  const route = (item) => hash(buildRoutesXml(item))
  const routeFirst = route(scenario)
  const routeSecond = route(scenario)
  const routeOtherSeed = route({ ...scenario, seed: scenario.seed + 1 })
  const profileFirst = hash(profiles(scenario))
  const profileOtherSeed = hash(profiles({ ...scenario, seed: scenario.seed + 1 }))

  const checks = {
    routesStable: routeFirst === routeSecond,
    routesSeedSensitive: routeFirst !== routeOtherSeed,
    profilesSeedSensitive: profileFirst !== profileOtherSeed,
  }
  const ok = Object.values(checks).every(Boolean)
  return {
    id: 'reproducibility',
    status: ok ? 'ok' : 'fail',
    detail: ok
      ? `seed=${scenario.seed}：SUMO 车流（${routeFirst.slice(0, 12)}…）重复生成一致；` +
        `换 seed 后车流与需求剖面均改变（已排除"换 seed 无影响"的实现错误）`
      : `复现性不成立：${Object.entries(checks)
          .filter(([, value]) => !value)
          .map(([key]) => key)
          .join('、')}`,
    hashes: { routes: routeFirst, routesOtherSeed: routeOtherSeed, profiles: profileFirst, profilesOtherSeed: profileOtherSeed },
    checks,
  }
}

/** 检查 4：边界工况——基准最优方案在扰动下的表现与是否仍可行。 */
export function checkBoundaryConditions() {
  const scenarios = resolveScenarios()
  const base = scenarios.find((item) => item.id === 'normal')
  const baseBest = searchDesigns(base, { top: 1 }).top[0]
  const rows = scenarios
    .filter((item) => item.kind === 'boundary')
    .map((scenario) => {
      const inherited = evaluateDesign(scenario, baseBest)
      const ownBest = searchDesigns(scenario, { top: 1 }).top[0]
      const gain = inherited.feasible && ownBest && inherited.metrics
        ? ((inherited.metrics.avgDelaySec - ownBest.metrics.avgDelaySec) / inherited.metrics.avgDelaySec) * 100
        : null
      return {
        scenario: scenario.id,
        name: scenario.name,
        inheritedFeasible: inherited.feasible,
        inheritedViolations: inherited.violations,
        inheritedAvgDelaySec: inherited.feasible ? (inherited.metrics?.avgDelaySec ?? null) : null,
        reoptimizedAvgDelaySec: ownBest?.metrics.avgDelaySec ?? null,
        reoptimizeGainPct: gain === null ? null : Number(gain.toFixed(2)),
        action: inherited.feasible ? '沿用基准配时可接受' : '基准配时失效：切换该工况专属配时或走降级策略',
      }
    })
  const ok = rows.every((row) => row.inheritedFeasible || row.reoptimizedAvgDelaySec !== null)
  return {
    id: 'boundary-conditions',
    status: ok ? 'ok' : 'fail',
    detail: `${rows.length} 个边界工况均给出结论：不可行时由重新寻优或降级策略兜底`,
    rows,
  }
}

/** 检查 5：失败样例——过饱和必须被显式判定为不可行，不允许静默输出"坏方案"。 */
export function checkFailurePath() {
  const oversaturated = resolveScenarios().find((item) => item.kind === 'failure')
  if (!oversaturated) return { id: 'failure-path', status: 'fail', detail: '缺少失败样例工况' }
  const search = searchDesigns(oversaturated, { top: 1 })
  const baseline = evaluateDesign(oversaturated, baselineDesign(oversaturated))
  const detected = search.feasible === false && baseline.feasible === false
  return {
    id: 'failure-path',
    status: detected ? 'ok' : 'fail',
    detail: detected
      ? `过饱和工况被正确拒绝（可行方案数 ${search.evaluated}），并给出原因：${baseline.violations[0] ?? '饱和度过高'}`
      : '过饱和工况被误判为可行，失败路径不成立',
    reasons: baseline.violations,
  }
}

export function runVerification() {
  const scenarios = resolveScenarios()
  const base = scenarios.find((item) => item.id === 'normal')
  const checks = [
    checkConsistency(base),
    checkWebsterAgreement(base),
    checkReproducibility(base),
    checkBoundaryConditions(),
    checkFailurePath(),
  ]
  const failed = checks.filter((check) => check.status === 'fail')
  const warned = checks.filter((check) => check.status === 'warn')
  return {
    scenario: base.id,
    generatedAt: new Date().toISOString(),
    status: failed.length === 0 ? 'ok' : 'fail',
    // warn 不算失败，但必须显式暴露：否则"5 项全过"会把警告一起吞掉。
    warningCount: warned.length,
    warnings: warned.map((check) => `${check.id}: ${check.detail}`),
    checks,
  }
}

export function optimizationReport(scenarioId) {
  const scenario = resolveScenarios().find((item) => item.id === scenarioId)
  if (!scenario) throw new Error(`未知工况 ${scenarioId}`)
  const search = searchDesigns(scenario, { top: 5 })
  const best = search.top[0] ?? null
  const comparison = best ? compareWithBaselines(scenario, best) : null
  const fairness = search.ranked.length
    ? [...search.ranked].sort((a, b) => a.worstApproachDelaySec - b.worstApproachDelaySec)[0]
    : null
  return {
    scenario: { id: scenario.id, name: scenario.name, kind: scenario.kind, note: scenario.note },
    designSpace: { cycle: '60–160s（步长 2s）', greenSplit: '南北绿灯 8s–(C−损失时间−8s)' },
    evaluated: search.evaluated,
    feasible: search.feasible,
    top: search.top.map((item) => ({
      cycle: item.cycle,
      greenNS: item.greenNS,
      greenEW: item.greenEW,
      avgDelaySec: item.metrics.avgDelaySec,
      totalDelayVehHours: item.metrics.totalDelayVehHours,
      maxVc: item.metrics.maxVc,
      worstApproachDelaySec: Number(item.worstApproachDelaySec.toFixed(2)),
    })),
    pareto: search.pareto.map((item) => ({
      cycle: item.cycle,
      greenNS: item.greenNS,
      avgDelaySec: item.metrics.avgDelaySec,
      worstApproachDelaySec: Number(item.worstApproachDelaySec.toFixed(2)),
    })),
    fairness: fairness
      ? {
          cycle: fairness.cycle,
          greenNS: fairness.greenNS,
          greenEW: fairness.greenEW,
          avgDelaySec: fairness.metrics.avgDelaySec,
          worstApproachDelaySec: Number(fairness.worstApproachDelaySec.toFixed(2)),
          avgDelayPenaltyPct: best
            ? Number((((fairness.metrics.avgDelaySec - best.metrics.avgDelaySec) / best.metrics.avgDelaySec) * 100).toFixed(2))
            : null,
        }
      : null,
    comparison,
  }
}
