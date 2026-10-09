import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const configPath = join(here, '..', 'configs', 'scenarios.json')

export function loadRawScenarios() {
  return JSON.parse(readFileSync(configPath, 'utf8'))
}

/** 把派生工况（放大倍数、偏斜、重车、事故降容）展开成自洽的完整工况。 */
export function resolveScenarios() {
  const raw = loadRawScenarios()
  const byId = new Map(raw.map((item) => [item.id, item]))
  return raw.map((item) => {
    if (!item.base) return item
    const base = byId.get(item.base)
    if (!base) throw new Error(`工况 ${item.id} 引用了不存在的基准 ${item.base}`)
    const scale = Number(item.scale ?? 1)
    const arrivals = Object.fromEntries(
      Object.entries(base.arrivals).map(([approach, demand]) => {
        const factor = scale * Number(item.scaleByApproach?.[approach] ?? 1)
        return [
          approach,
          {
            through: Math.round(demand.through * factor),
            left: Math.round(demand.left * factor),
          },
        ]
      }),
    )
    return {
      ...base,
      ...item,
      arrivals,
      heavyVehicleShare: Number(item.heavyVehicleShare ?? base.heavyVehicleShare),
      saturationScaleByApproach: item.saturationScaleByApproach ?? {},
      seed: Number(item.seed ?? base.seed),
    }
  })
}

export function getScenario(id) {
  const scenario = resolveScenarios().find((item) => item.id === id)
  if (!scenario) throw new Error(`未知工况 ${id}，可用：${resolveScenarios().map((s) => s.id).join(', ')}`)
  return scenario
}

export function totalDemand(scenario) {
  return Object.values(scenario.arrivals).reduce((sum, item) => sum + item.through + item.left, 0)
}
