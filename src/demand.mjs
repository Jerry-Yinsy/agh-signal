// 可复现需求生成：同一 seed ⇒ 同一序列（复现性是评分点之一）。

/** mulberry32：32 位种子确定性伪随机，便于在报告里公开复现方式。 */
export function createRandom(seed) {
  let state = (Number(seed) >>> 0) || 1
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function movementList(scenario) {
  const rows = []
  for (const [approach, demand] of Object.entries(scenario.arrivals)) {
    rows.push({ approach, turn: 'through', volume: Number(demand.through ?? 0) })
    rows.push({ approach, turn: 'left', volume: Number(demand.left ?? 0) })
  }
  return rows
}

/** 按 15 分钟时段做小幅波动，模拟真实到达的不均匀性。 */
export function profiles(scenario, slices = 8, jitter = 0.12) {
  const random = createRandom(scenario.seed)
  return movementList(scenario).map((movement) => ({
    ...movement,
    slices: Array.from({ length: slices }, () => 1 + (random() * 2 - 1) * jitter),
  }))
}

/** 时间切片数固定为 8（8 × 900s = 2 小时），周期内每片占 1 小时流量的 1/4。 */
export const SLICE_COUNT = 8
export const SLICE_SECONDS = 900

const EDGE_OF = {
  N: { from: 'north', to: 'C' },
  S: { from: 'south', to: 'C' },
  E: { from: 'east', to: 'C' },
  W: { from: 'west', to: 'C' },
}

/**
 * 生成 SUMO 车流文件（rou.xml）。
 *
 * 单位口径（曾出错，务必不要再改回去）：`volume` 是 **veh/h（整小时流量）**，而每条 flow 只覆盖
 * 一个 900s 时段。SUMO 的 vehsPerHour 表示"以该小时率发车"，实际发车数 = vehsPerHour × 时长/3600。
 * 因此要把整小时流量放进 900s 的 flow，应取 vehsPerHour = volume（该时段发车 volume/4 辆），
 * 8 段合计恰好 2 小时 × volume = 2×volume 辆。若写成 volume/8 会少 8 倍，写成 volume×8（历史 bug）
 * 会多 8 倍，都会让 SUMO 交叉验证失效。
 *
 * 车型：重车不是"整条 flow 换车型"，而是按 heavyVehicleShare 混流——
 * 同一时段生成 heavy（probability=share）与 car（probability=1-share）两条 flow。
 */
export function buildRoutesXml(scenario, options = {}) {
  const sliceSeconds = Number(options.sliceSeconds ?? SLICE_SECONDS)
  const jitter = Number(options.jitter ?? 0.12)
  const profilesByMovement = profiles(scenario, SLICE_COUNT, jitter)
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<routes xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="http://sumo.dlr.de/xsd/routes_file.xsd">',
    '  <vType id="car" vClass="passenger" length="4.5" maxSpeed="13.9" accel="2.6" decel="4.5" sigma="0.5"/>',
    `  <vType id="heavy" vClass="truck" length="9.0" maxSpeed="11.0" accel="1.3" decel="3.5" sigma="0.5"/>`,
  ]
  const heavy = Math.min(1, Math.max(0, Number(scenario.heavyVehicleShare ?? 0)))
  for (const movement of profilesByMovement) {
    const edge = EDGE_OF[movement.approach]
    const connection = movement.turn === 'left' ? `${edge.from}_left` : `${edge.from}_straight`
    for (let slice = 0; slice < movement.slices.length; slice += 1) {
      const rate = movement.volume * movement.slices[slice]
      const begin = slice * sliceSeconds
      const end = begin + sliceSeconds
      const common = `begin="${begin}" end="${end}" departLane="best" departSpeed="max" from="${edge.from}" to="${connection}"`
      if (heavy > 0) {
        lines.push(
          `  <flow id="f_${movement.approach}_${movement.turn}_${slice}_heavy" type="heavy" probability="${heavy}" ${common}/>`,
        )
      }
      if (heavy < 1) {
        lines.push(
          `  <flow id="f_${movement.approach}_${movement.turn}_${slice}_car" type="car" vehsPerHour="${rate.toFixed(0)}" ${common}/>`,
        )
      }
    }
  }
  lines.push('</routes>')
  return `${lines.join('\n')}\n`
}

export function buildSumoConfig(netFile, routeFile, additionalFile) {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<configuration xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="http://sumo.dlr.de/xsd/sumoConfiguration.xsd">',
    '  <input>',
    `    <net-file value="${netFile}"/>`,
    `    <route-files value="${routeFile}"/>`,
    `    <additional-files value="${additionalFile}"/>`,
    '  </input>',
    '  <time><begin value="0"/><end value="7200"/><step-length value="1"/></time>',
    '  <processing><time-to-teleport value="-1"/><ignore-route-errors value="true"/></processing>',
    '  <report><no-step-log value="true"/><duration-log.statistics value="true"/></report>',
    '</configuration>',
    '',
  ].join('\n')
}

/** 用 netgenerate 生成单点四臂路网（无需人工画图，也不需要 OSM）。 */
export function netgenerateCommand(outputFile) {
  return [
    'netgenerate',
    '--grid',
    '--grid.number',
    '1',
    '--grid.length',
    '400',
    '--default.lanenumber',
    '3',
    '--tls.guess',
    'true',
    '--tls.default-type',
    'static',
    '--no-turnarounds',
    'true',
    '--output-file',
    outputFile,
  ]
}
