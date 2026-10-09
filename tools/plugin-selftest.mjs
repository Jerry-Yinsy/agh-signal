// 插件自检：不需要模型、不需要 AGH，直接加载插件并把 5 个工具各调用一次。
// 用法：node tools/plugin-selftest.mjs
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
process.env.AGH_SIGNAL_HOME ??= projectRoot

const registered = []
const ctx = {
  extension: () => ({
    registerTool: (definition) => registered.push(definition),
    on: () => {},
    ctx: { log: { info: () => {} } },
  }),
}

const expected = ['traffic_scenarios', 'traffic_simulate', 'traffic_optimize', 'traffic_verify', 'traffic_report']
const modulePath = join(projectRoot, 'plugin', 'index.mjs')
readFileSync(modulePath, 'utf8')
const mod = await import(pathToFileURL(modulePath).href)
mod.trafficTools.apply(ctx)

const failures = []
const names = registered.map((tool) => tool.name)
for (const name of expected) if (!names.includes(name)) failures.push(`缺少工具 ${name}`)

const argumentsOf = (name) => {
  if (name === 'traffic_simulate') return { scenario: 'normal', cycle: 70, greenNS: 34 }
  if (name === 'traffic_optimize' || name === 'traffic_report') return { scenario: 'normal' }
  return {}
}

for (const tool of registered) {
  try {
    const result = await tool.execute(argumentsOf(tool.name))
    const text = result?.content?.[0]?.text
    if (typeof text !== 'string' || text.length === 0) failures.push(`${tool.name} 没有返回文本结果`)
    else JSON.parse(text)
  } catch (error) {
    failures.push(`${tool.name} 调用失败：${error.message}`)
  }
}

console.log(JSON.stringify({ projectRoot, tools: names, failures, status: failures.length === 0 ? 'ok' : 'fail' }, null, 2))
process.exitCode = failures.length === 0 ? 0 : 1
