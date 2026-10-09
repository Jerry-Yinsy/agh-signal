// 确定性信号交叉口分析模型（两相位、允许式左转）。
// 用途：寻优阶段的快速评估器，与 SUMO 微观仿真交叉验证（见 src/verify.mjs）。
// 参考：Webster 延误公式 + 饱和流率/通行能力定义；所有简化都在 docs/01-项目方案.md 中列出。

export const DESIGN_BOUNDS = {
  minCycle: 60,
  maxCycle: 160,
  minGreen: 8,
  maxVc: 0.95,
}

const PHASE_OF = { N: 'NS', S: 'NS', E: 'EW', W: 'EW' }

function movementsOf(scenario) {
  const rows = []
  for (const [approach, demand] of Object.entries(scenario.arrivals)) {
    for (const turn of ['through', 'left']) {
      const volume = Number(demand[turn] ?? 0)
      if (volume <= 0) continue
      const saturationBase = Number(scenario.saturationFlow?.[turn] ?? (turn === 'left' ? 1200 : 1800))
      const saturationScale = Number(scenario.saturationScaleByApproach?.[approach] ?? 1)
      const heavy = Number(scenario.heavyVehicleShare ?? 0)
      rows.push({
        id: `${approach}-${turn}`,
        approach,
        turn,
        phase: PHASE_OF[approach],
        volume,
        saturation: saturationBase * saturationScale * (1 - 0.15 * heavy),
      })
    }
  }
  return rows
}

function lostTimeTotal(scenario) {
  return 2 * Number(scenario.lostTimePerPhase ?? 4)
}

/** 相位关键流率比：该相位内各流向 v/s 的最大值。 */
export function phaseFlowRatios(scenario) {
  const ratio = { NS: 0, EW: 0 }
  for (const movement of movementsOf(scenario)) {
    ratio[movement.phase] = Math.max(ratio[movement.phase], movement.volume / movement.saturation)
  }
  return ratio
}

/** Webster 最佳周期与按流率比分配的绿灯（作为对照基线之一）。 */
export function websterDesign(scenario) {
  const ratio = phaseFlowRatios(scenario)
  const y = ratio.NS + ratio.EW
  const lost = lostTimeTotal(scenario)
  const raw = y >= 1 ? DESIGN_BOUNDS.maxCycle : (1.5 * lost + 5) / (1 - y)
  const cycle = Math.min(DESIGN_BOUNDS.maxCycle, Math.max(DESIGN_BOUNDS.minCycle, Math.round(raw / 2) * 2))
  const usable = Math.max(0, cycle - lost)
  const share = y > 0 ? ratio.NS / y : 0.5
  const greenNS = Math.round((usable * share) / 2) * 2
  return { cycle, greenNS }
}

/** 现状固定配时基线：常见于未做优化的路口。 */
export function baselineDesign() {
  return { cycle: 90, greenNS: 41 }
}

export function evaluateDesign(scenario, design) {
  const lost = lostTimeTotal(scenario)
  const cycle = Number(design.cycle)
  const greenNS = Number(design.greenNS)
  const greenEW = cycle - lost - greenNS
  const violations = []

  if (!Number.isFinite(cycle) || !Number.isFinite(greenNS)) {
    return { feasible: false, violations: ['配时参数不是有限数值'], metrics: null }
  }
  if (cycle < DESIGN_BOUNDS.minCycle || cycle > DESIGN_BOUNDS.maxCycle)
    violations.push(`周期 ${cycle}s 超出 [${DESIGN_BOUNDS.minCycle}, ${DESIGN_BOUNDS.maxCycle}]`)
  if (greenNS < DESIGN_BOUNDS.minGreen) violations.push(`南北绿灯 ${greenNS}s 低于最小绿灯 ${DESIGN_BOUNDS.minGreen}s`)
  if (greenEW < DESIGN_BOUNDS.minGreen) violations.push(`东西绿灯 ${greenEW}s 低于最小绿灯 ${DESIGN_BOUNDS.minGreen}s`)

  const green = { NS: greenNS, EW: greenEW }
  const lambda = cycle > 0 ? { NS: greenNS / cycle, EW: greenEW / cycle } : { NS: 0, EW: 0 }
  const movements = []
  let totalVolume = 0
  let totalDelayVehSeconds = 0
  let capacity = 0
  let maxVc = 0

  for (const movement of movementsOf(scenario)) {
    const ratio = lambda[movement.phase]
    const capacityMovement = movement.saturation * ratio
    const x = capacityMovement > 0 ? movement.volume / capacityMovement : Number.POSITIVE_INFINITY
    const q = movement.volume / 3600
    const uniform = 0.5 * cycle * (1 - ratio) ** 2 / Math.max(1e-6, 1 - Math.min(1, x) * ratio)
    const overflow = x >= 1 ? (x - 1) * cycle + 60 : x ** 2 / (2 * Math.max(1e-6, q * (1 - x)))
    const delay = uniform + overflow
    totalVolume += movement.volume
    totalDelayVehSeconds += movement.volume * delay
    capacity += capacityMovement
    maxVc = Math.max(maxVc, x)
    movements.push({
      id: movement.id,
      phase: movement.phase,
      volume: movement.volume,
      saturation: Number(movement.saturation.toFixed(1)),
      capacity: Number(capacityMovement.toFixed(1)),
      vc: Number(x.toFixed(4)),
      delaySec: Number(delay.toFixed(2)),
      uniformDelaySec: Number(uniform.toFixed(2)),
      stops: Number((1 - ratio).toFixed(4)),
    })
  }

  if (maxVc > DESIGN_BOUNDS.maxVc) violations.push(`最大饱和度 ${maxVc.toFixed(3)} 超过上限 ${DESIGN_BOUNDS.maxVc}`)
  const ratioSum = phaseFlowRatios(scenario)
  if (ratioSum.NS + ratioSum.EW >= 1) violations.push('总流率比 Y ≥ 1，路口已达过饱和，配时无法解决')

  const avgDelaySec = totalVolume > 0 ? totalDelayVehSeconds / totalVolume : 0

  // 排队：HCM 均匀延误假设下，车辆在红灯期间到达并按到达率累积，消散期间排空，
  // 故平均排队 = 到达率 × 平均均匀延误（Little 定律），最大排队 = 到达率 × 红灯时长。
  // 注意：这里必须用**均匀延误**而不是总延误，也不能用 Σ(q·d)（那是延误车辆秒，量纲是 veh·s/h）。
  let avgQueueVehicles = 0
  let maxQueueVehicles = 0
  for (const movement of movements) {
    const arrivalRate = movement.volume / 3600
    const ratio = lambda[movement.phase]
    avgQueueVehicles += arrivalRate * movement.uniformDelaySec
    maxQueueVehicles = Math.max(maxQueueVehicles, arrivalRate * cycle * (1 - ratio))
  }

  const stopRate = totalVolume > 0 ? movements.reduce((sum, m) => sum + m.volume * m.stops, 0) / totalVolume : 0
  const occupancy = Number(scenario.occupancy ?? 1.3)

  return {
    feasible: violations.length === 0,
    violations,
    metrics: {
      cycle,
      greenNS,
      greenEW,
      avgDelaySec: Number(avgDelaySec.toFixed(2)),
      totalDelayVehHours: Number((totalDelayVehSeconds / 3600).toFixed(3)),
      personHours: Number(((totalDelayVehSeconds / 3600) * occupancy).toFixed(3)),
      // 排队口径：单位是"辆"。avgQueueVehicles 为全路口各流向平均排队之和，maxQueueVehicles 为最大流向排队。
      avgQueueVehicles: Number(avgQueueVehicles.toFixed(2)),
      maxQueueVehicles: Number(maxQueueVehicles.toFixed(2)),
      // 兼容旧字段名：历史上这两个名字装的是 Σ(q·d)（量纲 veh·s/h）与它的 2 倍，语义错误，勿再使用。
      avgQueueVeh: Number(avgQueueVehicles.toFixed(2)),
      maxQueueVeh: Number(maxQueueVehicles.toFixed(2)),
      stopRate: Number(stopRate.toFixed(4)),
      capacityVehPerHour: Number(capacity.toFixed(1)),
      avgVc: Number((totalVolume / Math.max(1e-6, capacity)).toFixed(4)),
      maxVc: Number(maxVc.toFixed(4)),
      criticalFlowRatio: Number((ratioSum.NS + ratioSum.EW).toFixed(4)),
      delayByApproach: Object.fromEntries(
        Object.keys(scenario.arrivals).map((approach) => {
          const rows = movements.filter((m) => m.id.startsWith(`${approach}-`))
          const volume = rows.reduce((sum, r) => sum + r.volume, 0)
          const delay = volume > 0 ? rows.reduce((sum, r) => sum + r.volume * r.delaySec, 0) / volume : 0
          return [approach, Number(delay.toFixed(2))]
        }),
      ),
    },
    movements,
  }
}
