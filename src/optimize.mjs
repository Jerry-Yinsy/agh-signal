import { DESIGN_BOUNDS, baselineDesign, evaluateDesign, websterDesign } from './model.mjs'

/** 穷举可行域（模型是确定性的，单次评估 <0.1ms，故网格扫描即全局最优）。 */
export function searchDesigns(scenario, options = {}) {
  const step = Number(options.step ?? 2)
  const top = Number(options.top ?? 5)
  const lost = 2 * Number(scenario.lostTimePerPhase ?? 4)
  const results = []

  for (let cycle = DESIGN_BOUNDS.minCycle; cycle <= DESIGN_BOUNDS.maxCycle; cycle += step) {
    const usable = cycle - lost
    for (let greenNS = DESIGN_BOUNDS.minGreen; greenNS <= usable - DESIGN_BOUNDS.minGreen; greenNS += step) {
      const evaluation = evaluateDesign(scenario, { cycle, greenNS })
      if (!evaluation.feasible) continue
      results.push({
        cycle,
        greenNS,
        greenEW: cycle - lost - greenNS,
        metrics: evaluation.metrics,
        worstApproachDelaySec: Math.max(...Object.values(evaluation.metrics.delayByApproach)),
      })
    }
  }

  const ranked = [...results].sort((a, b) => a.metrics.avgDelaySec - b.metrics.avgDelaySec)
  return {
    scenarioId: scenario.id,
    evaluated: results.length,
    feasible: results.length > 0,
    ranked,
    top: ranked.slice(0, top),
    pareto: paretoFront(results),
  }
}

/** 双目标 Pareto 前沿：车均延误 vs 最差进口延误（公平性）。 */
export function paretoFront(results) {
  const sorted = [...results].sort((a, b) => a.metrics.avgDelaySec - b.metrics.avgDelaySec)
  const front = []
  let bestWorst = Number.POSITIVE_INFINITY
  for (const candidate of sorted) {
    if (candidate.worstApproachDelaySec < bestWorst - 1e-9) {
      front.push(candidate)
      bestWorst = candidate.worstApproachDelaySec
    }
  }
  return front
}

/** 与两个对照基线比较：现状固定配时、Webster 经典配时。 */
export function compareWithBaselines(scenario, best) {
  const baselines = {
    current: baselineDesign(scenario),
    webster: websterDesign(scenario),
  }
  const summary = {}
  for (const [name, design] of Object.entries(baselines)) {
    const evaluation = evaluateDesign(scenario, design)
    summary[name] = {
      design,
      feasible: evaluation.feasible,
      violations: evaluation.violations,
      metrics: evaluation.metrics,
    }
  }
  const baselineDelay = summary.current.metrics?.avgDelaySec ?? Number.NaN
  const bestDelay = best?.metrics?.avgDelaySec ?? Number.NaN
  return {
    baselines: summary,
    best,
    improvement: {
      avgDelaySecAbs: Number((baselineDelay - bestDelay).toFixed(2)),
      avgDelayPct: Number((((baselineDelay - bestDelay) / baselineDelay) * 100).toFixed(2)),
      totalDelayVehHoursAbs: Number(
        ((summary.current.metrics?.totalDelayVehHours ?? 0) - (best?.metrics?.totalDelayVehHours ?? 0)).toFixed(3),
      ),
    },
  }
}
