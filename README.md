# agh-signal｜基于 Agnes Harness 的信号配时自动寻优与验证闭环

2026 江苏省 AI+科学与工程创新实践黑客松（高校组）参赛项目工程骨架。
一句话定位：**用 AGH 编排"仿真调用—参数寻优—边界工况验证—异常重试"闭环，把路口信号配时的寻优与验证从人工数小时压缩到秒级，并自动产出可复现的验证报告。**

## 为什么这个选题

| 评分维度（本科生组） | 权重 | 本项目对应做法 |
| --- | --- | --- |
| 任务完成度与结果正确性 | 25% | 确定性评估模型 + 网格全局寻优 + 与 SUMO 微观仿真交叉验证 |
| 问题价值与学科融合 | 20% | 交通工程真实问题：延误、饱和度、公平性，均为可计量指标 |
| Agnes Harness 与模型执行闭环 | 20% | 5 个 AGH 工具 + 会话内完整执行记录，见 docs/02 |
| 创新性与发展价值 | 15% | "寻优 + 边界验证 + 失败拒绝"三件套自动化，可迁移到其它工程仿真 |
| 技术深度与系统实现 | 10% | 分析模型、优化器、验证器、SUMO 适配分层解耦 |
| 验证严谨性与异常处理 | 10% | 5 项自动检查 + 三类测试样例，见 `artifacts/verification.md` |

## 目录结构

```
agh-signal/
├─ src/
│  ├─ model.mjs        确定性交叉口分析模型（Webster 延误、通行能力、饱和度、排队、停车率）
│  ├─ scenarios.mjs    工况装载与派生（放大、偏斜、重车、事故降容）
│  ├─ demand.mjs       可复现需求生成 + SUMO 车流/配置生成
│  ├─ optimize.mjs     全局网格寻优 + Pareto 前沿 + 基线对比
│  ├─ verify.mjs       5 项自动验证（自洽、交叉、复现、边界、失败样例）
│  ├─ sumo.mjs         SUMO 适配层（相位映射、tripinfo 解析、缺失时自动降级）
│  └─ cli.mjs          统一命令入口（AGH 通过它调用全部能力）
├─ plugin/             AGH 后端工具插件（注册 5 个 traffic_* 工具）
├─ configs/scenarios.json  工况定义（正常 / 边界 / 失败样例）
├─ tools/plugin-selftest.mjs  插件免模型自检
├─ artifacts/          运行产物（报告、证据），由命令生成
└─ docs/               方案、AGH 接入、SUMO 接入、路演脚本
```

## 快速开始（Windows PowerShell）

```powershell
Set-Location 'D:\dev\agnes-project\agh-signal'
node --version                                   # 需要 Node 24+
node src\cli.mjs scenarios                       # 1. 看工况
node src\cli.mjs selfcheck                       # 2. 各工况最优配时一览
node src\cli.mjs report --scenario normal        # 3. 生成报告与验证证据
node tools\plugin-selftest.mjs                   # 4. 插件免模型自检
.\run-demo.ps1                                   # 等价的一键流程
```

产物落在 `artifacts/`：`report-normal.md`（寻优报告）、`verification.md`（验证报告）、`optimize-normal.json`、`verification.json`。

## 命令一览

| 命令 | 作用 |
| --- | --- |
| `node src/cli.mjs scenarios` | 列出工况 |
| `node src/cli.mjs simulate --scenario normal --cycle 70 --green-ns 34` | 评估单个配时方案 |
| `node src/cli.mjs optimize --scenario normal` | 寻优 + 基线对比 + Pareto |
| `node src/cli.mjs verify` | 运行 5 项验证 |
| `node src/cli.mjs report --scenario normal` | 生成 Markdown/JSON 报告 |
| `node src/cli.mjs sumo-check` | 检查 SUMO 是否可用 |
| `node src/cli.mjs sumo-sim --scenario normal --cycle 70 --green-ns 34` | 用 SUMO 复核方案 |

## 已知限制（写进作品说明更专业）

1. 分析模型是确定性宏观模型（Webster 延误），不含随机到达波动、行人相位、公交优先、干线协调。
2. 左转按允许式处理，饱和流率取经验值，未做车道级几何标定。
3. SUMO 交叉验证需要本机安装 SUMO，且相位映射需人工核对一次（见 docs/03）。
4. 该工具链输出的是"配时建议 + 验证证据"，不直接下发到信号机，不承诺现场直接可用。
