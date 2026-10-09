# agh-signal｜基于 Agnes Harness 的信号配时自动寻优与验证闭环

2026 江苏省 AI+科学与工程创新实践黑客松（高校组）参赛作品。
主赛道 B（数学计算与科研智能体）· 具体方向 B4（科研 Agent 与 Harness 工程）+ D4（环境能源与城市系统）

> **一句话**：用 Agnes Harness（AGH）编排"仿真调用 → 参数寻优 → 边界工况验证 → 异常重试"的智能体闭环，
> 把路口信号配时的寻优与验证从人工数小时压缩到秒级，并自动产出可复现的验证报告。

环境要求：**Node.js ≥ 24.10**（无第三方依赖、无需联网、无需安装仿真软件即可跑通主流程）。

---

## 一、30 秒复现（评审快速核对）

```bash
git clone https://github.com/Jerry-Yinsy/agh-signal.git
cd agh-signal
node --version                 # 需 >= 24.10

node src/cli.mjs selfcheck                 # 六个工况的最优配时一览
node src/cli.mjs report --scenario normal  # 生成报告 + 验证证据
node tools/plugin-selftest.mjs             # AGH 插件免模型自检
```

期望结果（与本仓库 `artifacts/` 中已提交的产物一致）：

| 命令 | 期望输出 |
| --- | --- |
| `selfcheck` | 6 个工况：normal/peak/skew/heavy/incident 可行，oversaturated 不可行（可行方案数 0） |
| `report` | 生成 `artifacts/report-normal.md` 与 `artifacts/verification.md`；normal 车均延误 **16.70s**、评估 **835** 个可行方案、较现状固定配时 **−24.16%** |
| `plugin-selftest` | `"status": "ok"`，列出 5 个 `traffic_*` 工具 |

复现性：所有随机的部分都由 `configs/scenarios.json` 里的 `seed` 固定（默认 `20261005`），
同一命令、同一 seed、同一 Node 大版本，结果应逐字节一致。

---

## 二、问题 → 方法 → 结果

**问题**：路口信号配时通常靠工程师手工试算，一轮几十分钟，而且往往只验证"正常工况"；
真正会出事的是高峰、潮汐偏斜、事故降容这些边界工况。作品要求"可执行、可验证"，纯概念与界面原型不被接受。

**方法**：把"配时好不好"变成机器可调用的工具，再让 AGH 上的智能体驱动它闭环：

1. 确定性分析模型（Webster 延误 + 通行能力 + 饱和度 + 排队 + 停车率）做毫秒级快速筛选；
2. 网格穷举设计空间（周期 60–160s × 绿灯分配），单工况评估 200–900 个可行方案，即为全局最优；
3. 与两个基线对照（现状固定配时 90s、Webster 经典公式），并给出效率/公平性 Pareto 前沿；
4. 边界工况批量复核：不可行时**显式拒绝并给出降级建议**，绝不输出"看起来能跑"的坏方案；
5. 可选：用 SUMO 微观仿真对最终方案做独立交叉验证（见 `docs/03-SUMO接入步骤.md`）。

**结果**：

| 工况 | 结论 |
| --- | --- |
| normal（2580 veh/h） | 车均延误 22.02s → **16.70s（−24.16%）**，总延误 −3.81 veh·h/h，最大饱和度 0.693 |
| 公平性方案 | 平均延误仅 +1.38%，最差进口延误 20.57s → **17.66s（−14.2%）** |
| peak（需求 ×1.3） | 基准配时仍可行，重新寻优 27.10s |
| skew（北进口 ×1.6） | 基准配时**失效**（最大饱和度 1.109 超限），重新寻优 28.43s |
| heavy（重车 12%） | 基准配时可行，16.95s |
| incident（北进口 −40% 通行能力） | 基准配时**失效**（1.155），重新寻优 35.16s |
| oversaturated（需求 ×2.0） | **正确拒绝**：可行方案 0 个，给出"需求管理 / 通行能力扩容 / 应急过渡"三条降级建议 |

---

## 三、六个工况一览

| 工况 ID | 名称 | 类型 | 用途 | 总需求(veh/h) |
| --- | --- | --- | --- | --- |
| normal | 平峰基准 | 设计工况 | 寻优与基线对比 | 2580 |
| peak | 晚高峰（×1.3） | 边界 | 整体需求放大 | 3354 |
| skew | 潮汐偏斜（北进口 ×1.6） | 边界 | 方向不均衡 | 2972 |
| heavy | 重车比例 12% | 边界 | 饱和流率下降 | 2580 |
| incident | 事故降容（−40%） | 边界 | 单进口能力下降 | 2580 |
| oversaturated | 过饱和（×2.0） | **失败样例** | 必须被拒绝 | 5160 |

对应官方要求的三类测试样例：**正常 = normal，边界 = peak/skew/heavy/incident，失败 = oversaturated**。

---

## 四、验证怎么复核

`node src/cli.mjs verify` 会跑 5 项检查并写入 `artifacts/verification.md`：

| 检查 | 做法 | 通过判据 |
| --- | --- | --- |
| 自洽性 | 总延误/车均延误由流向明细重算 | 误差 < 0.01s |
| 交叉验证 | 网格最优 vs Webster 经典公式 | 周期差 ≤ 20s、延误差 ≤ 25% |
| 复现性 | 同 seed 两次生成 + 换 seed 对比 | 哈希一致且可区分 |
| 边界工况 | 基准配时在 4 个扰动工况下的可行性与收益 | 每个工况都有明确结论 |
| 失败样例 | 过饱和必须被拒绝 | 可行方案数为 0 且给出原因 |

SUMO 交叉验证（可选，需要自行安装 SUMO）：`node src/cli.mjs sumo-check` → `node src/cli.mjs sumo-sim --scenario normal --cycle 70 --green-ns 34`，
判定标准是两套独立方法给出的车均延误差异 ≤ 30% 即视为互证通过（口径差异见 `docs/03`）。

---

## 五、目录结构

```
agh-signal/
├─ src/
│  ├─ model.mjs        确定性交叉口分析模型（Webster 延误、通行能力、排队、停车率）
│  ├─ scenarios.mjs    工况装载与派生（放大、偏斜、重车、事故降容）
│  ├─ demand.mjs       可复现需求生成 + SUMO 车流/配置生成
│  ├─ optimize.mjs     网格全局寻优 + Pareto 前沿 + 基线对比
│  ├─ verify.mjs       5 项自动验证
│  ├─ sumo.mjs         SUMO 适配层（相位映射、tripinfo 解析、缺失时自动降级）
│  └─ cli.mjs          统一命令入口（AGH 通过它调用全部能力）
├─ plugin/             AGH 后端工具插件，注册 5 个 traffic_* 工具
├─ configs/scenarios.json   六个工况定义
├─ tools/              plugin-selftest.mjs、preflight-publish.ps1、publish-github.ps1 等
├─ artifacts/          运行产物（报告与验证结果；evidence/ 不入库）
└─ docs/               01 项目方案 / 02 AGH 接入 / 03 SUMO / 04 路演脚本 / 05 交付说明 / 06 运行手册 / 07 发布手册
```

## 六、命令一览

| 命令 | 作用 |
| --- | --- |
| `node src/cli.mjs scenarios` | 列出工况 |
| `node src/cli.mjs simulate --scenario normal --cycle 70 --green-ns 34` | 评估单个配时方案 |
| `node src/cli.mjs optimize --scenario normal` | 寻优 + 基线对比 + Pareto |
| `node src/cli.mjs verify` | 运行 5 项验证 |
| `node src/cli.mjs report --scenario normal` | 生成 Markdown/JSON 报告 |
| `node src/cli.mjs sumo-check` / `sumo-sim …` | SUMO 可用性检查 / 微观仿真复核 |
| `powershell -File run-demo.ps1` | Windows 一键流程 |

## 七、在 AGH 里使用（可选）

插件把 CLI 包装成 5 个 Agent 工具（`traffic_scenarios` / `traffic_simulate` / `traffic_optimize` /
`traffic_verify` / `traffic_report`），让模型直接驱动整条闭环。安装、审核、启用与会话取证步骤见
`docs/02-AGH接入与证据.md`；插件通过环境变量 `AGH_SIGNAL_HOME` 定位本仓库。

## 八、已知限制（如实说明）

1. 分析模型是确定性宏观模型（Webster 延误），不含随机到达波动、行人相位、公交优先、干线协调；
2. 左转按允许式处理，饱和流率取经验值，未做车道级几何标定；
3. 工况流量目前为占位数（正常工况 2580 veh/h），正式使用前应替换为目标路口的公开或实测流量；
4. SUMO 交叉验证需要本机安装 SUMO，且相位映射需人工核对一次；
5. 本工具输出的是"配时建议 + 验证证据"，**不直接下发信号机**，不承诺现场直接可用；
6. 运行环境为 Windows + Node 24，AGH 官方记录的验证平台是 macOS，跨平台差异见 `docs/05`。

## 九、许可

MIT，见 [LICENSE](LICENSE)。
