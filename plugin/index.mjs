// AGH 后端工具插件：把本项目的配时寻优工具链注册成 Agent 可调用的工具。
// 约定：项目根目录由环境变量 AGH_SIGNAL_HOME 指定（例如 D:\dev\agnes-project\agh-signal）。
// 工具实现统一通过 `node <root>/src/cli.mjs <子命令> [--参数 值]` 调用，stdout 必须是 JSON。
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const Kind = Symbol.for('TypeBox.Kind')

const objectSchema = (properties, required = Object.keys(properties)) => ({
  [Kind]: 'Object',
  type: 'object',
  properties,
  required,
  additionalProperties: false,
})
const stringSchema = (description, extras = {}) => ({ [Kind]: 'String', type: 'string', description, ...extras })
const numberSchema = (description, extras = {}) => ({ [Kind]: 'Number', type: 'number', description, ...extras })

const READ_ONLY = {
  isReadOnly: true,
  isDestructive: false,
  isConcurrencySafe: true,
  isOpenWorld: false,
  replay: 'safe',
  costHint: undefined,
  deferLoading: false,
  requiresApproval: 'never',
}
const WRITES_ARTIFACTS = { ...READ_ONLY, isReadOnly: false, isConcurrencySafe: false }

function projectRoot() {
  const root = process.env.AGH_SIGNAL_HOME
  if (!root) {
    throw new Error(
      'AGH_SIGNAL_HOME 未设置。请把它指向 agn-signal 项目根目录，例如在启动 AGH 的环境中设置 ' +
        'AGH_SIGNAL_HOME=D:\\dev\\agnes-project\\agh-signal，然后重启 daemon。',
    )
  }
  const cli = join(root, 'src', 'cli.mjs')
  if (!existsSync(cli)) throw new Error(`AGH_SIGNAL_HOME=${root} 下找不到 src/cli.mjs，请检查路径是否正确。`)
  return { root, cli }
}

function runCli(cli, args, timeout = 120000) {
  const output = execFileSync(process.execPath, [cli, ...args], {
    encoding: 'utf8',
    windowsHide: true,
    timeout,
    maxBuffer: 32 * 1024 * 1024,
  })
  return JSON.parse(output)
}

/** 精简结果，避免把整份 JSON 灌进模型上下文；完整数据留在 artifacts/。 */
function summarizeOptimization(report) {
  if (!report.feasible) {
    return {
      scenario: report.scenario.id,
      feasible: false,
      evaluated: report.evaluated,
      conclusion: '该工况在信号配时可解范围之外，需要扩容或需求管理，不能给出配时方案',
    }
  }
  const best = report.top[0]
  const baselineDesign = report.comparison?.baselines?.current?.design
  const current = report.comparison?.baselines?.current?.metrics
  return {
    scenario: report.scenario.id,
    feasible: true,
    evaluated: report.evaluated,
    best,
    fairness: report.fairness,
    // 基线的完整参数必须一起返回，否则模型会自行假设绿灯时长去复算，造成口径不一致。
    baseline: current && baselineDesign
      ? {
          cycle: baselineDesign.cycle,
          greenNS: baselineDesign.greenNS,
          greenEW: current.greenEW,
          avgDelaySec: current.avgDelaySec,
          totalDelayVehHours: current.totalDelayVehHours,
          maxVc: current.maxVc,
          note: '这就是"现状固定配时"基线参数，复算请用同一组 cycle/greenNS，不要自行改绿灯',
        }
      : null,
    improvement: report.comparison?.improvement ?? null,
  }
}

export const trafficTools = {
  inject: ['extension'],
  apply(ctx) {
    const agnes = ctx.extension()

    agnes.registerTool({
      name: 'traffic_scenarios',
      description: '列出信号交叉口仿真工况（正常/边界/失败样例）及其需求构成。',
      parameters: objectSchema({}),
      meta: READ_ONLY,
      async execute() {
        const { cli } = projectRoot()
        const result = runCli(cli, ['scenarios'])
        return {
          content: [{ type: 'text', text: JSON.stringify(result) }],
          structured: result,
        }
      },
    })

    agnes.registerTool({
      name: 'traffic_simulate',
      description:
        '用确定性交叉口模型评估一个配时方案，返回车均延误、总延误、饱和度、排队与停车率，并给出约束违例。',
      parameters: objectSchema({
        scenario: stringSchema('工况 id，例如 normal/peak/skew/heavy/incident/oversaturated'),
        cycle: numberSchema('周期长度（秒）'),
        greenNS: numberSchema('南北方向绿灯时长（秒）'),
      }),
      meta: READ_ONLY,
      async execute({ scenario, cycle, greenNS }) {
        const { cli } = projectRoot()
        const result = runCli(cli, ['simulate', '--scenario', String(scenario), '--cycle', String(cycle), '--green-ns', String(greenNS)])
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                scenario: result.scenario,
                design: result.design,
                feasible: result.feasible,
                violations: result.violations,
                metrics: result.metrics,
              }),
            },
          ],
          structured: { feasible: result.feasible, violations: result.violations, metrics: result.metrics },
        }
      },
    })

    agnes.registerTool({
      name: 'traffic_optimize',
      description:
        '在给定工况下搜索最优配时（周期 60–160s、绿灯分配），并与现状固定配时、Webster 经典配时对比，返回最优方案、公平性方案与提升幅度。',
      parameters: objectSchema({ scenario: stringSchema('工况 id，例如 normal/peak/skew/incident/oversaturated') }),
      meta: READ_ONLY,
      async execute({ scenario }) {
        const { cli } = projectRoot()
        const result = summarizeOptimization(runCli(cli, ['optimize', '--scenario', String(scenario)]))
        return { content: [{ type: 'text', text: JSON.stringify(result) }], structured: result }
      },
    })

    agnes.registerTool({
      name: 'traffic_verify',
      description:
        '运行完整验证：模型自洽性、与 Webster 公式交叉验证、复现性、边界工况鲁棒性、失败样例必须被拒绝。返回逐项结论。',
      parameters: objectSchema({}),
      meta: READ_ONLY,
      async execute() {
        const { cli } = projectRoot()
        const result = runCli(cli, ['verify'])
        const summary = {
          status: result.status,
          checks: result.checks.map((check) => ({ id: check.id, status: check.status, detail: check.detail })),
        }
        return { content: [{ type: 'text', text: JSON.stringify(summary) }], structured: summary }
      },
    })

    agnes.registerTool({
      name: 'traffic_report',
      description:
        '生成寻优报告与验证报告文件（Markdown + JSON）到项目 artifacts/ 目录，作为作品提交所需的运行证据。',
      parameters: objectSchema({ scenario: stringSchema('工况 id') }),
      meta: WRITES_ARTIFACTS,
      async execute({ scenario }) {
        const { cli } = projectRoot()
        const result = runCli(cli, ['report', '--scenario', String(scenario)])
        return { content: [{ type: 'text', text: JSON.stringify(result) }], structured: result }
      },
    })
  },
}
