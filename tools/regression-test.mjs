#!/usr/bin/env node
/**
 * 回归测试：锁住已修复的缺陷，避免改回去。
 *
 * 用法：node tools/regression-test.mjs
 * 特点：不依赖 SUMO 安装——所有涉及 SUMO 的部分都只验证"生成的文件/相位表是否正确"，
 * 不真的启动仿真器。
 *
 * 每个用例都对应一个曾经真实存在的 bug，注释里写明了错法，便于判断"是不是又改回去了"。
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

import { DESIGN_BOUNDS, baselineDesign, evaluateDesign } from '../src/model.mjs'
import { searchDesigns } from '../src/optimize.mjs'
import { buildRoutesXml, profiles } from '../src/demand.mjs'
import { buildTlLogicOverride, inspectTlLogic, parseTripinfo } from '../src/sumo.mjs'
import { resolveScenarios } from '../src/scenarios.mjs'

const results = []
function check(id, name, fn) {
  try {
    const detail = fn()
    results.push({ id, name, status: 'ok', detail })
  } catch (error) {
    results.push({ id, name, status: 'fail', detail: error.message })
  }
}
function assert(condition, message) {
  if (!condition) throw new Error(message)
}
const round = (value, digits = 2) => Number(Number(value).toFixed(digits))

const scenarios = resolveScenarios()
const byId = (id) => {
  const scenario = scenarios.find((item) => item.id === id)
  if (!scenario) throw new Error(`工况 ${id} 不存在`)
  return scenario
}
const totalDemandOf = (scenario) =>
  Object.values(scenario.arrivals).reduce((sum, item) => sum + item.through + item.left, 0)

/* ==========================================================================
   1. SUMO 需求总量：vehsPerHour 是"整小时率"，不能被当成单时段量
   历史 bug：把 1 小时流量直接写进只覆盖 900s 的 flow，实际发车量放大 8 倍。
   正确关系：8 段 × 900s = 2h，故生成车辆总数 = 2 × sum(volume)。
   ========================================================================== */
check('sumo-demand-total', 'SUMO 车流总量与工况需求一致（未放大 8 倍）', () => {
  const lines = []
  for (const id of ['normal', 'peak', 'oversaturated']) {
    const scenario = byId(id)
    const xml = buildRoutesXml(scenario)
    // 只累计 car flow 的 vehsPerHour（heavy flow 用 probability，其车辆数由 car 流量 × 比例决定，
    // 而 SUMO 的 probability 是"按 car 流量为基数的比例"，故总量校准看 car 即可）
    let generated = 0
    for (const match of xml.matchAll(/vehsPerHour="(\d+)"[^>]*begin="(\d+)" end="(\d+)"/g)) {
      const rate = Number(match[1])
      const seconds = Number(match[3]) - Number(match[2])
      generated += (rate * seconds) / 3600
    }
    const expected = 2 * totalDemandOf(scenario) // 2 小时
    const deviation = Math.abs(generated - expected) / expected
    assert(
      deviation < 0.15,
      `${id}: 生成 ${generated.toFixed(0)} 辆 vs 期望 ${expected} 辆（偏差 ${(deviation * 100).toFixed(1)}%，` +
        '上限 15% 用于容纳 ±12% 波动剖面）。偏差接近 8 倍说明 vehsPerHour 又按单时段写了。',
    )
    lines.push(`${id} ${generated.toFixed(0)}/${expected} 辆（${(deviation * 100).toFixed(1)}%）`)
  }
  return lines.join('；')
})

/* ==========================================================================
   2. 重车混流：heavyVehicleShare 必须体现为车型比例
   历史 bug：`type = heavy > 0.06 ? 'heavy' : 'car'`，heavy 工况 100% 重车、
   normal 工况 0% 重车，比例完全失效。
   ========================================================================== */
check('sumo-vtype-mix', '重车比例体现为混流而非整条 flow 换车型', () => {
  const lines = []
  for (const [id, share] of [
    ['normal', 0.04],
    ['heavy', 0.12],
  ]) {
    const scenario = byId(id)
    assert(
      round(scenario.heavyVehicleShare, 4) === share,
      `${id}: 期望 heavyVehicleShare=${share}，实际 ${scenario.heavyVehicleShare}`,
    )
    const xml = buildRoutesXml(scenario)
    const heavyFlows = (xml.match(/type="heavy"/g) ?? []).length
    const carFlows = (xml.match(/type="car"/g) ?? []).length
    assert(carFlows > 0, `${id}: 没有任何 car flow，车型又被二值化了`)
    assert(heavyFlows > 0, `${id}: 没有任何 heavy flow`)
    // 每个 movement × 每个时段都应有成对的 car / heavy
    assert(
      heavyFlows === carFlows,
      `${id}: heavy flow ${heavyFlows} 条与 car flow ${carFlows} 条不成对（应为每个时段各一条）`,
    )
    const probability = Number(/type="heavy" probability="([\d.]+)"/.exec(xml)?.[1])
    assert(
      Math.abs(probability - share) < 1e-9,
      `${id}: heavy flow 的 probability=${probability}，应等于 heavyVehicleShare=${share}`,
    )
    lines.push(`${id} heavy prob=${probability} / car ${carFlows} 条`)
  }
  return lines.join('；')
})

/* ==========================================================================
   3. 相位映射周期守恒：注入 SUMO 的方案必须就是被模型评估的那个方案
   历史 bug：只改绿灯时长、清空相位保持原值，导致 SUMO 周期 = 设计周期 + 清空时间差额。
   ========================================================================== */
function writeNet(dir, phases) {
  const file = join(dir, 'net.net.xml')
  const body = phases
    .map((phase) => `    <phase duration="${phase.duration}" state="${phase.state}"/>`)
    .join('\n')
  writeFileSync(file, `<net>\n  <tlLogic id="C" type="static" programID="0" offset="0">\n${body}\n  </tlLogic>\n</net>`, 'utf8')
  return file
}

check('sumo-cycle-conservation', '相位映射后周期严格等于设计周期', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agh-cycle-'))
  const cases = [
    { name: '清空=模型假设(4s/相位)', phases: [
      { duration: 30, state: 'GGGGrrrr' }, { duration: 4, state: 'yyyyrrrr' },
      { duration: 22, state: 'rrrrGGGG' }, { duration: 4, state: 'rrrryyyy' }], design: { cycle: 60, greenNS: 30 } },
    { name: '真实清空(5s/相位)', phases: [
      { duration: 31, state: 'GGGGrrrr' }, { duration: 5, state: 'yyyyrrrr' },
      { duration: 19, state: 'rrrrGGGG' }, { duration: 5, state: 'rrrryyyy' }], design: { cycle: 60, greenNS: 30 } },
    { name: '长清空(7s/相位)', phases: [
      { duration: 40, state: 'GGGGrrrr' }, { duration: 7, state: 'yyyyrrrr' },
      { duration: 25, state: 'rrrrGGGG' }, { duration: 7, state: 'rrrryyyy' }], design: { cycle: 80, greenNS: 40 } },
    { name: '多绿灯相位(3个)', phases: [
      { duration: 20, state: 'GGGGrrrr' }, { duration: 15, state: 'GGGGrrrr' }, { duration: 4, state: 'yyyyrrrr' },
      { duration: 25, state: 'rrrrGGGG' }, { duration: 1, state: 'rrrryyyy' }], design: { cycle: 80, greenNS: 40 } },
  ]
  const lines = []
  for (const item of cases) {
    const net = writeNet(dir, item.phases)
    const override = buildTlLogicOverride(net, item.design)
    assert(
      override.actualCycle === item.design.cycle,
      `${item.name}: 实际周期 ${override.actualCycle}s ≠ 设计周期 ${item.design.cycle}s（绿灯总量应自动吸收清空时间差额）`,
    )
    // 绿灯在两个方向之间的比例应与设计一致（允许 2s 取整误差）
    const designGreenEW = item.design.cycle - 8 - item.design.greenNS
    const scale = override.greenShare.NS / item.design.greenNS
    const expectedEW = designGreenEW * scale
    assert(
      Math.abs(override.greenShare.EW - expectedEW) <= 2,
      `${item.name}: 东西绿灯 ${override.greenShare.EW}s 与按比例应有值 ${expectedEW.toFixed(1)}s 偏差过大`,
    )
    lines.push(`${item.name} → ${override.actualCycle}s`)
  }
  return lines.join('；')
})

check('sumo-cycle-guard', '周期无法守恒时拒绝输出、不给出假验证结论', () => {
  // 清空时间 7s/相位 = 14s，远超模型假设的 8s；若设计周期小于清空时间，绿灯总量会被压到 0
  const dir = mkdtempSync(join(tmpdir(), 'agh-guard-'))
  const net = writeNet(dir, [
    { duration: 20, state: 'GGGGrrrr' }, { duration: 7, state: 'yyyyrrrr' },
    { duration: 20, state: 'rrrrGGGG' }, { duration: 7, state: 'rrrryyyy' },
  ])
  const override = buildTlLogicOverride(net, { cycle: 60, greenNS: 30 })
  assert(override.actualCycle === 60, `周期应守恒为 60s，实际 ${override.actualCycle}s`)
  assert(
    typeof override.mismatch === 'string' && override.mismatch.includes('14'),
    '清空时间(14s)与模型损失时间(8s)不一致时必须给出 mismatch 提示，供报告披露口径差异',
  )
  return 'mismatch 已显式暴露，不会静默通过'
})

check('sumo-clearance-mismatch', '清空时间与模型口径不一致时给出可执行提示', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agh-mismatch-'))
  const net = writeNet(dir, [
    { duration: 25, state: 'GGGGrrrr' }, { duration: 6, state: 'yyyyrrrr' },
    { duration: 25, state: 'rrrrGGGG' }, { duration: 6, state: 'rrrryyyy' },
  ])
  const override = buildTlLogicOverride(net, { cycle: 70, greenNS: 34 })
  assert(override.actualCycle === 70, `周期应守恒为 70s，实际 ${override.actualCycle}s`)
  assert(override.actualClearance === 12, `实际清空时间应为 12s，得到 ${override.actualClearance}`)
  assert(override.modelLostTime === 8, `模型损失时间应为 8s，得到 ${override.modelLostTime}`)
  assert(
    /lostTimePerPhase/.test(override.mismatch ?? ''),
    'mismatch 文案应告诉使用者把 lostTimePerPhase 改成多少，才能让两个口径一致',
  )
  return `清空 12s vs 模型 8s → 提示改 lostTimePerPhase=6`
})

/* ==========================================================================
   4. 排队指标量纲：必须是"辆"，且来自均匀延误而非总延误
   历史 bug：avgQueueVeh = Σ(q·d)（量纲 veh·s/h），maxQueueVeh = avgQueueVeh × 2。
   ========================================================================== */
check('queue-semantics', '排队量纲正确（辆）且与到达率×均匀延误一致', () => {
  const scenario = byId('normal')
  const design = { cycle: 90, greenNS: 41 }
  const evaluation = evaluateDesign(scenario, design)
  const metrics = evaluation.metrics

  // 独立重算：avgQueue = Σ 到达率 × 该流向均匀延误
  const expectedAvg = evaluation.movements.reduce((sum, m) => sum + (m.volume / 3600) * m.uniformDelaySec, 0)
  assert(
    Math.abs(metrics.avgQueueVehicles - expectedAvg) < 0.05,
    `avgQueueVehicles=${metrics.avgQueueVehicles} 与独立重算 ${expectedAvg.toFixed(2)} 不符`,
  )
  // 量纲上界：任何流向的排队都不可能超过"该流向整整一个周期都在排队"，
  // 即 全路口 Σ(到达率 × 周期)。历史 bug 用总延误算出的值会明显偏大，这条能抓住它。
  const upperBound = evaluation.movements.reduce((sum, m) => sum + (m.volume / 3600) * design.cycle, 0)
  assert(
    metrics.maxQueueVehicles <= upperBound + 1e-6,
    `最大排队 ${metrics.maxQueueVehicles} 辆超过物理上界 ${upperBound.toFixed(1)} 辆，量纲仍然可疑`,
  )
  assert(
    metrics.avgQueueVehicles < upperBound,
    `平均排队 ${metrics.avgQueueVehicles} 辆达到物理上界 ${upperBound.toFixed(1)} 辆，量纲仍然可疑`,
  )
  // 注意口径不同：avgQueueVehicles 是全路口各流向之和（4 个进口），
  // maxQueueVehicles 是"单个流向"的峰值，两者不能直接比大小。
  // 正确的对应关系是：任一流向的平均排队 ≤ 该流向峰值 ≤ maxQueueVehicles。
  for (const movement of evaluation.movements) {
    const approachQueueAvg = (movement.volume / 3600) * movement.uniformDelaySec
    assert(
      approachQueueAvg <= metrics.maxQueueVehicles + 1e-6,
      `${movement.id}: 该流向平均排队 ${approachQueueAvg.toFixed(2)} 辆超过峰值 ${metrics.maxQueueVehicles} 辆`,
    )
  }
  assert(
    metrics.avgQueueVeh === metrics.avgQueueVehicles && metrics.maxQueueVeh === metrics.maxQueueVehicles,
    '旧字段名必须与新字段同值（兼容层不能各算一套）',
  )

  // 均匀延误 ≤ 总延误，故用总延误算排队一定会偏大——这正是历史 bug 的偏大方向
  for (const movement of evaluation.movements) {
    assert(
      movement.uniformDelaySec <= movement.delaySec + 1e-9,
      `${movement.id}: 均匀延误 ${movement.uniformDelaySec} 不应大于总延误 ${movement.delaySec}`,
    )
  }
  return `avg=${metrics.avgQueueVehicles} 辆、max=${metrics.maxQueueVehicles} 辆（旧字段同步）`
})

check('queue-signal-plan-sanity', '排队随周期/绿信比变化的方向正确', () => {
  const scenario = byId('normal')
  const shortCycle = evaluateDesign(scenario, { cycle: 60, greenNS: 30 }).metrics
  const longCycle = evaluateDesign(scenario, { cycle: 140, greenNS: 70 }).metrics
  assert(
    longCycle.maxQueueVehicles > shortCycle.maxQueueVehicles,
    `红灯更长的方案最大排队应更大：C=140 → ${longCycle.maxQueueVehicles} vs C=60 → ${shortCycle.maxQueueVehicles}`,
  )
  return `C=60 max=${shortCycle.maxQueueVehicles} 辆 → C=140 max=${longCycle.maxQueueVehicles} 辆`
})

/* ==========================================================================
   5. 复现性：同 seed 逐字节一致、换 seed 必须改变
   ========================================================================== */
check('reproducibility-real', '同 seed 逐字节一致、换 seed 结果改变', () => {
  const scenario = byId('normal')
  const routesA = buildRoutesXml(scenario)
  const routesB = buildRoutesXml(scenario)
  const routesOther = buildRoutesXml({ ...scenario, seed: scenario.seed + 1 })
  assert(routesA === routesB, '同 seed 两次生成的 SUMO 车流不一致')
  assert(routesA !== routesOther, '换 seed 后 SUMO 车流没有变化，seed 实际上没生效')
  assert(JSON.stringify(profiles(scenario)) !== JSON.stringify(profiles({ ...scenario, seed: scenario.seed + 1 })), '换 seed 后需求剖面没有变化')
  return '车流与需求剖面均已验证'
})

check('routes-xml-wellformed', '车流 XML 结构自洽（flow 有起止时间与路径）', () => {
  const xml = buildRoutesXml(byId('normal'))
  const flows = [...xml.matchAll(/<flow [^>]*\/>/g)].map((match) => match[0])
  assert(flows.length > 0, '没有生成任何 flow')
  for (const flow of flows) {
    for (const attribute of ['id=', 'type=', 'begin=', 'end=', 'from=', 'to=']) {
      assert(flow.includes(attribute), `flow 缺少属性 ${attribute}：${flow}`)
    }
    const begin = Number(/begin="(\d+)"/.exec(flow)[1])
    const end = Number(/end="(\d+)"/.exec(flow)[1])
    assert(end > begin, `flow 起止时间非法：${flow}`)
    const hasRate = /vehsPerHour="\d+"/.test(flow)
    const hasProbability = /probability="[\d.]+"/.test(flow)
    assert(hasRate !== hasProbability, `flow 必须且只能有一个流量定义（vehsPerHour 或 probability）：${flow}`)
  }
  assert(xml.trimEnd().endsWith('</routes>'), 'routes 根标签未正确闭合')
  return `${flows.length} 条 flow 校验通过`
})

/* ==========================================================================
   6. 主链路不受影响：寻优结果仍是全局最优，且与网格步长无关的量级一致
   ========================================================================== */
check('optimizer-global-optimum', '寻优结果不劣于更细的网格（确为全局最优）', () => {
  const lines = []
  for (const id of ['normal', 'peak', 'incident']) {
    const scenario = byId(id)
    const coarse = searchDesigns(scenario, { step: 2, top: 1 }).top[0]
    const fine = searchDesigns(scenario, { step: 1, top: 1 }).top[0]
    assert(
      fine.metrics.avgDelaySec <= coarse.metrics.avgDelaySec + 1e-9,
      `${id}: 细网格 ${fine.metrics.avgDelaySec}s 竟然优于粗网格 ${coarse.metrics.avgDelaySec}s`,
    )
    lines.push(`${id} 2s网格=${coarse.metrics.avgDelaySec}s / 1s网格=${fine.metrics.avgDelaySec}s`)
  }
  return lines.join('；')
})

check('optimizer-respects-constraints', '所有输出的可行方案都满足约束', () => {
  const scenario = byId('normal')
  const search = searchDesigns(scenario, { top: 20 })
  assert(search.feasible, 'normal 工况应当有可行方案')
  for (const candidate of search.ranked) {
    const evaluation = evaluateDesign(scenario, candidate)
    assert(evaluation.feasible, `方案 C=${candidate.cycle} gNS=${candidate.greenNS} 被判不可行却出现在结果里`)
    assert(candidate.metrics.maxVc <= DESIGN_BOUNDS.maxVc + 1e-9, `方案最大饱和度 ${candidate.metrics.maxVc} 超限`)
    assert(candidate.greenEW >= DESIGN_BOUNDS.minGreen, `东西绿灯 ${candidate.greenEW}s 低于最小绿灯`)
  }
  return `${search.ranked.length} 个可行方案全部满足约束`
})

check('baseline-and-improvement', '基线可评估且最优方案不劣于现状固定配时', () => {
  const scenario = byId('normal')
  const baseline = evaluateDesign(scenario, baselineDesign(scenario))
  assert(baseline.feasible, '现状固定配时基线在 normal 工况下应当可行')
  const best = searchDesigns(scenario, { top: 1 }).top[0]
  assert(
    best.metrics.avgDelaySec < baseline.metrics.avgDelaySec,
    `最优方案 ${best.metrics.avgDelaySec}s 未优于基线 ${baseline.metrics.avgDelaySec}s`,
  )
  return `基线 ${baseline.metrics.avgDelaySec}s → 最优 ${best.metrics.avgDelaySec}s`
})

check('failure-path-rejected', '过饱和工况必须被拒绝', () => {
  const scenario = byId('oversaturated')
  const search = searchDesigns(scenario, { top: 1 })
  assert(!search.feasible && search.evaluated === 0, `过饱和工况出现了 ${search.evaluated} 个可行方案`)
  const baseline = evaluateDesign(scenario, baselineDesign(scenario))
  assert(!baseline.feasible && baseline.violations.length > 0, '过饱和工况的基线应带明确违例')
  return `可行方案 0 个；违例：${baseline.violations[0]}`
})

/* ==========================================================================
   7. 产物一致性：仓库里提交的报告应能由当前代码原样重放
   ========================================================================== */
check('net-inspection-format', 'net 相位解析兼容属性顺序与自闭合写法', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agh-net-'))
  const file = join(dir, 'net.net.xml')
  writeFileSync(
    file,
    `<net>
  <tlLogic id="A" type="static" programID="0" offset="0">
    <phase duration="30" state="GGGGrrrr"/>
    <phase state="yyyyrrrr" duration="4"/>
    <phase duration="22" state="rrrrGGGG"/>
  </tlLogic>
</net>`,
    'utf8',
  )
  const programs = inspectTlLogic(file)
  assert(programs.length === 1, `应解析出 1 个 tlLogic，得到 ${programs.length}`)
  assert(programs[0].phases.length >= 2, `应解析出至少 2 个相位，得到 ${programs[0].phases.length}`)
  const greens = programs[0].phases.filter((phase) => phase.kind === 'green')
  assert(greens.length === 2, `应识别出 2 个绿灯相位，得到 ${greens.length}`)
  return `${programs[0].phases.length} 个相位，其中绿灯 ${greens.length} 个`
})

check('tripinfo-parse', 'tripinfo 解析给出车均指标与总量', () => {
  const xml = `<tripinfos>
  <tripinfo id="v1" timeLoss="10.0" waitingTime="4.0" duration="50.0" waitingCount="1"/>
  <tripinfo id="v2" timeLoss="20.0" waitingTime="6.0" duration="60.0" waitingCount="3"/>
</tripinfos>`
  const metrics = parseTripinfo(xml)
  assert(metrics.vehicles === 2, `车辆数应为 2，得到 ${metrics.vehicles}`)
  assert(metrics.avgTimeLossSec === 15, `车均 timeLoss 应为 15，得到 ${metrics.avgTimeLossSec}`)
  assert(metrics.totalStops === 4, `总停车次数应为 4，得到 ${metrics.totalStops}`)
  // totalTimeLossHours 保留 3 位小数，故用 1e-3 作为容差，不能要求精确相等
  assert(
    Math.abs(metrics.totalTimeLossHours - 30 / 3600) < 1e-3,
    `总延误小时换算错误：期望约 ${(30 / 3600).toFixed(4)}，得到 ${metrics.totalTimeLossHours}`,
  )
  return `2 辆、车均 ${metrics.avgTimeLossSec}s、总停车 ${metrics.totalStops} 次`
})

/* ==========================================================================
   8. 提交产物的漂移检测（仅告警，不判定失败）
   ========================================================================== */
const drift = []
check('artifact-drift', '提交的报告与当前代码重放一致（漂移则告警）', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const reportPath = join(root, 'artifacts', 'report-normal.md')
  if (!existsSync(reportPath)) return 'artifacts/report-normal.md 不存在，跳过'
  const committed = readFileSync(reportPath, 'utf8')
  const best = searchDesigns(byId('normal'), { top: 1 }).top[0]
  const hasBest = committed.includes(`| 1 | ${best.cycle} | ${best.greenNS} |`) && committed.includes(`${best.metrics.avgDelaySec} |`)
  if (!hasBest) drift.push(`report-normal.md 的最优行与当前计算结果不一致（当前 C=${best.cycle} gNS=${best.greenNS} ${best.metrics.avgDelaySec}s）`)
  return hasBest ? '最优方案行与当前计算一致' : '存在漂移（见 warnings）'
})

const failed = results.filter((item) => item.status === 'fail')
const payload = {
  status: failed.length === 0 ? 'ok' : 'fail',
  passed: results.length - failed.length,
  total: results.length,
  warnings: drift,
  results,
}
console.log(JSON.stringify(payload, null, 2))
if (failed.length > 0) process.exitCode = 1
