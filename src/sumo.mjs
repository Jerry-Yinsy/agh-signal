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

  const lost = 2 * Number(options.lostTimePerPhase ?? 4)
  const greenEW = design.cycle - lost - design.greenNS
  const totals = { NS: design.greenNS, EW: greenEW }
  const perGroup = { NS: 0, EW: 0 }
  for (const phase of greenPhases) perGroup[assignment.get(phase.index)] += 1

  const phases = []
  for (const phase of program.phases) {
    if (phase.kind === 'green') {
      const group = assignment.get(phase.index)
      const duration = Math.max(5, Math.round(totals[group] / Math.max(1, perGroup[group])))
      phases.push(`        <phase duration="${duration}" state="${phase.state}"/>`)
    } else {
      phases.push(`        <phase duration="${phase.duration}" state="${phase.state}"/>`)
    }
  }
  return {
    programId: program.id,
    phases,
    xml: [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<additional xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="http://sumo.dlr.de/xsd/additional_file.xsd">',
      `  <tlLogic id="${program.id}" type="static" programID="${program.id}" offset="0">`,
      ...phases,
      '  </tlLogic>',
      '</additional>',
      '',
    ].join('\n'),
  }
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
    metrics: parseTripinfo(readFileSync(tripinfoFile, 'utf8')),
  }
}
