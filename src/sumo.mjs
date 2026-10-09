// SUMO 适配层：把本项目的配时方案落到 SUMO 微观仿真，并解析 tripinfo 作为独立验证来源。
// 现状：本文件在无 SUMO 的机器上会自动降级（返回 available:false），不会影响主流程。
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildRoutesXml, buildSumoConfig, netgenerateCommand } from './demand.mjs'

function which(binary) {
  try {
    const output = execFileSync(process.platform === 'win32' ? 'where.exe' : 'which', [binary], {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return output.split(/\r?\n/u).find((line) => line.trim())?.trim()
  } catch {
    return undefined
  }
}

export function sumoStatus() {
  const home = process.env.SUMO_HOME
  const sumo = process.env.SUMO_BIN ?? (home ? join(home, 'bin', process.platform === 'win32' ? 'sumo.exe' : 'sumo') : undefined)
  const resolved = sumo && existsSync(sumo) ? sumo : which(process.platform === 'win32' ? 'sumo.exe' : 'sumo')
  const netgenerate = home
    ? join(home, 'bin', process.platform === 'win32' ? 'netgenerate.exe' : 'netgenerate')
    : which(process.platform === 'win32' ? 'netgenerate.exe' : 'netgenerate')
  return {
    available: Boolean(resolved),
    sumo: resolved,
    netgenerate,
    netgenerateAvailable: Boolean(netgenerate && existsSync(netgenerate)),
    sumoHome: home,
  }
}

/** 读取 net 文件里的 tlLogic 相位，供人工一次性确认相位映射（不同 SUMO 版本/路网会不同）。 */
export function inspectTlLogic(netXml) {
  const text = readFileSync(netXml, 'utf8')
  const programs = []
  for (const match of text.matchAll(/<tlLogic\b[^>]*id="([^"]+)"[^>]*>([\s\S]*?)<\/tlLogic>/g)) {
    const phases = [...match[2].matchAll(/<phase\s+duration="([\d.]+)"\s+state="([^"]+)"/g)].map((phase, index) => ({
      index,
      duration: Number(phase[1]),
      state: phase[2],
      kind: /[Gg]/.test(phase[2]) ? 'green' : 'clearance',
    }))
    programs.push({ id: match[1], phases })
  }
  return programs
}

/**
 * 把两相位设计映射为 SUMO 的相位时长。
 *
 * 周期守恒（曾出错，务必不要再改回去）：路网里的黄灯/全红相位时长是固定的，不能改。
 * 因此必须**反推**该路网下真正可分配的绿灯总量：
 *     totalGreen = cycle − 实际清空时间合计
 * 再按设计的 NS:EW 绿灯比例（g_NS : g_EW = g_NS : (C − 模型损失时间 − g_NS)）分配。
 * 历史 bug：直接把 g_NS/g_EW 当成绿灯总量写进去，导致 SUMO 里的周期 = 设计周期 + 清空时间差额，
 * 注入仿真的方案与被分析模型评估的方案不是同一个，交叉验证在方法上不成立。
 *
 * 若路网清空时间与模型假设的 lostTimePerPhase 不一致，两者确实无法同时满足；
 * 此时按路网实际清空时间保证周期守恒，并在返回值里给出 mismatch 供调用方写进报告。
 * 默认约定：把 net 中出现的绿灯相位按顺序分成 NS 组与 EW 组（可通过
 * SIGNAL_LOOP_PHASE_GROUPS="NS,EW" 覆盖）。首次使用请先用 sumo-map 子命令核对。
 */
export function buildTlLogicOverride(netXml, design, options = {}) {
  const programs = inspectTlLogic(netXml)
  if (programs.length === 0) throw new Error('net 文件中找不到 tlLogic，请确认路网包含信号控制')
  const program = programs.sort((a, b) => b.phases.length - a.phases.length)[0]
  const greenPhases = program.phases.filter((phase) => phase.kind === 'green')
  if (greenPhases.length < 2) throw new Error('绿灯相位少于 2 个，无法映射两相位方案')

  const groups = (options.groups ?? process.env.SIGNAL_LOOP_PHASE_GROUPS ?? 'NS,EW').split(',').map((s) => s.trim())
  const half = Math.ceil(greenPhases.length / 2)
  const assignment = new Map()
  greenPhases.forEach((phase, index) => {
    assignment.set(phase.index, index < half ? groups[0] : groups[1])
  })

  const modelLost = 2 * Number(options.lostTimePerPhase ?? 4)
  const greenEW = design.cycle - modelLost - design.greenNS
  const totals = { NS: design.greenNS, EW: greenEW }

  // 周期守恒：绿灯总量 = 设计周期 − 路网实际清空时间合计（清空相位时长保持不变）
  const actualClearance = program.phases
    .filter((phase) => phase.kind !== 'green')
    .reduce((sum, phase) => sum + phase.duration, 0)
  const totalGreen = Math.max(0, design.cycle - actualClearance)

  const requestedGreen = Math.max(0, design.greenNS) + Math.max(0, greenEW)
  const shareNS = requestedGreen > 0 ? Math.max(0, design.greenNS) / requestedGreen : 0.5
  const greenNS = Math.round((totalGreen * shareNS) / 2) * 2
  const greenEW2 = totalGreen - greenNS

  const perGroup = { NS: 0, EW: 0 }
  for (const phase of greenPhases) perGroup[assignment.get(phase.index)] += 1

  const phases = []
  for (const phase of program.phases) {
    if (phase.kind === 'green') {
      const group = assignment.get(phase.index)
      const target = group === groups[0] ? greenNS : greenEW2
      const duration = Math.max(5, Math.round(target / Math.max(1, perGroup[group])))
      phases.push(`        <phase duration="${duration}" state="${phase.state}"/>`)
    } else {
      phases.push(`        <phase duration="${phase.duration}" state="${phase.state}"/>`)
    }
  }

  const actualCycle = phases.reduce((sum, line) => sum + Number(/duration="(\d+)"/.exec(line)[1]), 0)
  const allocations = [perGroup[groups[0]], perGroup[groups[1]]]
  const splitWarning =
    greenPhases.length % 2 === 0
      ? null
      : `绿灯相位 ${greenPhases.length} 个，无法在两个方向间均分（按序前 ${half} 个归 ${groups[0]}、` +
        `其余归 ${groups[1]}，实际 ${allocations[0]}:${allocations[1]}）。相位顺序是按索引猜的，` +
        '请用 sumo-map 核对 state 字符串确认放行方向，必要时用 SIGNAL_LOOP_PHASE_GROUPS 调整。'
  const result = {
    programId: program.id,
    phases,
    designCycle: design.cycle,
    actualCycle,
    actualClearance,
    modelLostTime: modelLost,
    greenShare: { NS: greenNS, EW: greenEW2 },
    greenPhaseAllocation: { [groups[0]]: allocations[0], [groups[1]]: allocations[1] },
    splitWarning,
    mismatch:
      actualClearance === modelLost
        ? null
        : `路网清空时间合计 ${actualClearance}s，模型假设的损失时间 ${modelLost}s，` +
          `差异 ${actualClearance - modelLost}s 已通过调整绿灯总量吸收，周期仍保持 ${actualCycle}s；` +
          `建议把工况的 lostTimePerPhase 改为 ${actualClearance / 2}s 使两者口径一致。`,
  }
  result.xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<additional xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="http://sumo.dlr.de/xsd/additional_file.xsd">',
    `  <tlLogic id="${program.id}" type="static" programID="${program.id}" offset="0">`,
    ...phases,
    '  </tlLogic>',
    '</additional>',
    '',
  ].join('\n')
  return result
}

export function parseTripinfo(xml) {
  const trips = [...xml.matchAll(/<tripinfo\b([^>]*)\/>/g)].map((match) => {
    const attributes = Object.fromEntries(
      [...match[1].matchAll(/(\w+)="([^"]*)"/g)].map((pair) => [pair[1], pair[2]]),
    )
    return attributes
  })
  const count = trips.length
  const sum = (key) => trips.reduce((total, trip) => total + Number(trip[key] ?? 0), 0)
  return {
    vehicles: count,
    avgTimeLossSec: count ? Number((sum('timeLoss') / count).toFixed(2)) : null,
    avgWaitingTimeSec: count ? Number((sum('waitingTime') / count).toFixed(2)) : null,
    avgDurationSec: count ? Number((sum('duration') / count).toFixed(2)) : null,
    totalStops: sum('waitingCount'),
    stopRate: count ? Number((sum('waitingCount') / count).toFixed(4)) : null,
    totalTimeLossHours: Number((sum('timeLoss') / 3600).toFixed(3)),
  }
}

export function simulateWithSumo({ directory, scenario, design, seed, timeoutMs = 600000 }) {
  const status = sumoStatus()
  if (!status.available) return { available: false, reason: `未找到 SUMO 可执行文件（SUMO_HOME=${status.sumoHome ?? '未设置'}）` }
  mkdirSync(directory, { recursive: true })
  const netFile = join(directory, 'net.net.xml')
  const routeFile = join(directory, 'routes.rou.xml')
  const additionalFile = join(directory, 'tls.add.xml')
  const configFile = join(directory, 'sumo.sumocfg')
  const tripinfoFile = join(directory, 'tripinfo.xml')

  if (!existsSync(netFile)) {
    if (!status.netgenerateAvailable) {
      return { available: false, reason: '缺少 netgenerate，无法自动生成路网；请在 docs/03-SUMO接入步骤.md 中按说明生成 net.net.xml' }
    }
    const [command, ...args] = netgenerateCommand(netFile)
    execFileSync(command, args, { cwd: directory, stdio: 'inherit', windowsHide: true, timeout: timeoutMs })
  }

  writeFileSync(routeFile, buildRoutesXml(scenario), 'utf8')
  const override = buildTlLogicOverride(netFile, design, { lostTimePerPhase: scenario.lostTimePerPhase })
  if (override.actualCycle !== design.cycle) {
    // 周期守恒是交叉验证成立的前提；真出现偏差就不要给出"看起来验证过了"的结果。
    return {
      available: false,
      reason:
        `相位映射后 SUMO 周期 ${override.actualCycle}s ≠ 设计周期 ${design.cycle}s，` +
        '注入仿真的方案与模型评估的方案不是同一个，已中止以免给出无效的交叉验证结论。',
      override: { designCycle: override.designCycle, actualCycle: override.actualCycle, phases: override.phases },
    }
  }
  writeFileSync(additionalFile, override.xml, 'utf8')
  writeFileSync(configFile, buildSumoConfig('net.net.xml', 'routes.rou.xml', 'tls.add.xml'), 'utf8')

  execFileSync(status.sumo, ['-c', configFile, '--tripinfo-output', tripinfoFile, '--seed', String(seed)], {
    cwd: directory,
    stdio: 'inherit',
    windowsHide: true,
    timeout: timeoutMs,
  })
  return {
    available: true,
    netFile,
    routeFile,
    additionalFile,
    configFile,
    tripinfoFile,
    programId: override.programId,
    cycle: { design: override.designCycle, actual: override.actualCycle },
    greenShare: override.greenShare,
    clearanceMismatch: override.mismatch,
    metrics: parseTripinfo(readFileSync(tripinfoFile, 'utf8')),
  }
}
