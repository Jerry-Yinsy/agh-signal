# agh-signal 在 AGH 里的运行手册（步骤 + 指令）

目标：把 agh-signal 项目接到 Agnes Harness 上，让 Agent 能调用 5 个 traffic_* 工具，
并留下可提交的运行证据。

全程只用两条路径：

- AGH 仓库：`D:\dev\agnes-project\agnes-harness`（入口 `packages\cli\dist\local\agnes.mjs`）
- 本项目：`D:\dev\agnes-project\agh-signal`

> 约定：带 `[AGH]` 标记的段落，终端工作目录在 AGH 仓库；带 `[项目]` 标记的在项目目录。

---

## 阶段 0：前置检查（1 分钟）

```powershell
# [AGH] 入口是否就位
Test-Path 'D:\dev\agnes-project\agnes-harness\packages\cli\dist\local\agnes.mjs'

# [AGH] Node 版本（需要 24.10 以上）
node --version

# [项目] 项目是否已经在 D 盘
Test-Path 'D:\dev\agnes-project\agh-signal\src\cli.mjs'
```

第三条如果是 `False`，先做阶段 1。

---

## 阶段 1：把项目放到 D 盘

把交付目录里的 `agh-signal-package.zip` 解压到 `D:\dev\agnes-project\`，
解压后的目录名保持 `agh-signal`（不要变成 `agh-signal-package`，否则后面对不上路径）。

```powershell
# 用资源管理器解压，或：
Expand-Archive -Path '<交付目录>\agh-signal-package.zip' -DestinationPath 'D:\dev\agnes-project' -Force

# 校验目录结构（应输出 True）
Test-Path 'D:\dev\agnes-project\agh-signal\src\cli.mjs'
Test-Path 'D:\dev\agnes-project\agh-signal\plugin\index.mjs'
Test-Path 'D:\dev\agnes-project\agh-signal\configs\scenarios.json'
```

---

## 阶段 2：先让项目本身跑通（不经过 AGH）

```powershell
# [项目]
Set-Location 'D:\dev\agnes-project\agh-signal'

node src\cli.mjs scenarios                  # 列出 6 个工况
node src\cli.mjs selfcheck                  # 各工况最优配时一览
node src\cli.mjs report --scenario normal   # 生成寻优报告 + 验证报告
node src\cli.mjs verify                     # 5 项验证，期望 status: ok
node tools\plugin-selftest.mjs              # 插件免模型自检，期望 status: ok

# 或在项目根直接一键跑
.\run-demo.ps1
```

产物在 `D:\dev\agnes-project\agh-signal\artifacts\`：
`report-normal.md`、`verification.md`、`optimize-normal.json`、`verification.json`。

这一步不认识 AGH，也不花模型额度。**先确认这一步过了再往下做**。

---

## 阶段 3：启动 AGH（带上项目路径变量）

关键点：`AGH_SIGNAL_HOME` 必须对 **daemon 进程**可见。所以要在启动会话里设置它，
并且改过之后要重启后台。

```powershell
# [AGH]
Set-Location 'D:\dev\agnes-project\agnes-harness'
$env:AGH_HOME        = 'D:\dev\agnes-project\agh-home'
$env:AGNES_PROFILE   = 'local-dev'
$env:AGH_SIGNAL_HOME = 'D:\dev\agnes-project\agh-signal'

node .\packages\cli\dist\local\agnes.mjs daemon stop    # 清掉可能残留的旧后台
node .\packages\cli\dist\local\agnes.mjs daemon status   # 期望 running:false
node .\packages\cli\dist\local\agnes.mjs serve           # 前台运行，窗口保持开着
```

浏览器打开终端打印的地址（默认 `http://127.0.0.1:4177`）。

如果模型还没配：左下角设置 → Provider，选服务商、核对 Base URL、填 API key、
点测试连接、选模型、保存。凭证存好后可以这样确认：

```powershell
# [AGH] 另开一个终端，环境变量保持一致
$env:AGH_HOME='D:\dev\agnes-project\agh-home'; $env:AGNES_PROFILE='local-dev'
node .\packages\cli\dist\local\agnes.mjs doctor provider
```

---

## 阶段 4：把工具插件装进 AGH

另开一个 PowerShell（环境变量与阶段 3 完全一致），在 AGH 仓库执行：

```powershell
# [AGH]
Set-Location 'D:\dev\agnes-project\agnes-harness'
$env:AGH_HOME        = 'D:\dev\agnes-project\agh-home'
$env:AGNES_PROFILE   = 'local-dev'
$env:AGH_SIGNAL_HOME = 'D:\dev\agnes-project\agh-signal'

# 4.0 先把插件目录复制进 AGH 工作区根目录
#     file: 来源只接受 ./ 开头的相对路径（绝对路径、反斜杠、.. 、盘符冒号都会被拒绝），
#     并且相对 daemon 的工作区根解析，所以要先把插件放进工作区再引用。
Copy-Item -Recurse -Force 'D:\dev\agnes-project\agh-signal\plugin' 'D:\dev\agnes-project\agnes-harness\examples\packages\traffic-tools'

# 4.1 检查：记录输出的 package ID、version、integrity、capabilityHash，确认没有 blocker
node .\packages\cli\dist\local\agnes.mjs package inspect file:./examples/packages/traffic-tools

# 4.2 安装（会展示预览并要求确认）
node .\packages\cli\dist\local\agnes.mjs install file:./examples/packages/traffic-tools

# 4.3 审核并启用 —— 请到 Web 做，命令行走不完：
#     trust 参数里 capabilityHash 是必填（64 位十六进制），但 CLI 的 inspect 预览不打印它。
#     Web：设置 → 插件 → Install from source（Source type = file，
#          参考填 file:./examples/packages/traffic-tools）→ 检查 → 安装 → 启用
#     说明：Web 启用时会自动绑定完整性摘要与能力摘要，不需要手抄哈希。

# 4.4 核对实际状态：desired 与 actual 都应为 ready
node .\packages\cli\dist\local\agnes.mjs package status
```

也可以走图形界面：Web 左下角设置 → 插件 → Install from source，
**Source type 选 `file`**，Source reference 填 `file:./examples/packages/traffic-tools`，
然后 Check source → 安装 → 启用。（下拉框默认是 `npm`，不改它一定装不上。）

注意两点：

- **不要改插件代码后再跳过检查**。改过内容 integrity 就变了，必须重新 inspect / install / trust / enable。
- 装完不用重启 daemon，新能力在**轮次边界**生效，下一轮对话就能调用。

---

## 阶段 5：在会话里跑通闭环（同时产生运行证据）

在 AGH 里开一个新会话，按顺序发下面 6 条（建议一次一条，方便留证）：

1. `调用 traffic_scenarios 列出所有工况，并说明哪个是失败样例、为什么必须被拒绝。`
2. `调用 traffic_optimize 处理 normal 工况，告诉我最优方案、公平性方案，以及与现状固定配时的差距。`
3. `对 peak 和 incident 两个工况分别调用 traffic_optimize，说明基准配时是否仍然可用；不可用时要怎么处置。`
4. `调用 traffic_optimize 处理 oversaturated 工况，确认它必须被拒绝，并给出降级建议。`
5. `调用 traffic_report 生成报告文件，并把产物路径列出来。`
6. （装了 SUMO 之后）`用 traffic_simulate 给出 normal 工况下 C=70、greenNS=34 的延误，再用 sumo-sim 复核同一方案，比较两者差异并解释原因。`

预期结果：

| 提示 | 期望 |
| --- | --- |
| 1 | 列出 6 个工况，指出 oversaturated 是失败样例 |
| 2 | 车均延误 22.02s → 16.70s（约 −24%），评估 835 个方案 |
| 3 | skew 与 incident 下基准配时失效（饱和度超限），给出重新寻优结果 |
| 4 | 判定不可行，可行方案数为 0，给出扩容/需求管理建议 |
| 5 | 返回 4 个产物路径 |
| 6 | 两套方法的车均延误量级一致（差异 ≤30% 视为互证通过） |

留证做法：把每轮的调用参数与返回 JSON 另存到
`D:\dev\agnes-project\agh-signal\artifacts\evidence\`（截图或复制 JSON 均可）。
会话本身的记录也是有效证据，建议在提交前把关键几轮截图保存。

> **注意（所有权边界）**：上面这几轮是在 Web 界面里跑的，会话归 Web 客户端身份所有，
> 用一次性 CLI 执行 `export` 会被 `CAPABILITY_DENIED` 拒绝——这是 AGH 的设计，不是故障。
> 想要"可导出的会话"，用 CLI 一次性模式重跑同样的提示词即可：
>
> ```powershell
> Set-Location 'D:\dev\agnes-project\agh-signal'
> node 'D:\dev\agnes-project\agnes-harness\packages\cli\dist\local\agnes.mjs' -p '调用 traffic_scenarios 列出所有工况，并说明哪个是失败样例、为什么必须被拒绝。'
> ```
>
> 输出可直接重定向存成 `.md` 文件，比导出更好读。一键版：
> `tools\collect-evidence.ps1`（跑 5 步 + 采集环境信息 + 生成证据索引）。

---

## 阶段 6：常见故障排查

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 工具报 `AGH_SIGNAL_HOME 未设置` | daemon 没继承该变量 | 在启动会话里设置后 `daemon stop` 再 `serve` |
| 工具报找不到 `src/cli.mjs` | 变量指向错误目录，或项目没解压好 | 指向含 `src/` 的项目根目录，并核对阶段 1 的三个 Test-Path |
| `package enable` 失败 | integrity / capabilityHash 与当前版本不符 | 重新 `package inspect` 取新值后重跑 4.3 |
| 模型不调用工具 | 提示词没点名工具；或插件未到轮次边界 | 提示里直接写工具名；`package status` 看 actual 是否 ready |
| `serve` 报 `daemon child exited before readiness (1)` | 后台被私有目录校验拒绝（常见于手工预创建 home 目录） | 删掉手工创建的 home 让 AGH 自己建，或把该目录 ACL 收紧到只有你本人和 SYSTEM |
| `npm.ps1 因为在此系统上禁止运行脚本` | PowerShell 执行策略 | 用 `npm.cmd`，或 `Set-ExecutionPolicy -Scope Process Bypass` |
| 重建 AGH 后报 Node headers 缺失 | 原生 helper 需要头文件 | 设置 `$env:AGNES_NODE_HEADERS='D:\dev\agnes-project\.cache\node-gyp\24.21.0'` 后再 `pnpm --filter @agnes/cli build:local` |

---

## 阶段 7：日常启停与更新

启动（推荐用交付目录里的脚本，已包含阶段 3 的全部变量）：

```powershell
# 把 start-agnes.ps1 放到 D:\dev\agnes-project\ 下
Set-Location 'D:\dev\agnes-project'
.\start-agnes.ps1            # 加 -NoBrowser 则不开浏览器
```

停止：

```powershell
# [AGH]
$env:AGH_HOME='D:\dev\agnes-project\agh-home'; $env:AGNES_PROFILE='local-dev'
node 'D:\dev\agnes-project\agnes-harness\packages\cli\dist\local\agnes.mjs' daemon stop
```

项目侧改动后无需重装插件，除非改了 `plugin\index.mjs`（那时要重走阶段 4）。
重跑工具链直接执行阶段 2 的命令即可。

---

## 附：命令清单（可直接整段复制）

```powershell
# A. 项目自检
Set-Location 'D:\dev\agnes-project\agh-signal'
node src\cli.mjs selfcheck
node src\cli.mjs report --scenario normal
node tools\plugin-selftest.mjs

# B. 启动 AGH
Set-Location 'D:\dev\agnes-project\agnes-harness'
$env:AGH_HOME='D:\dev\agnes-project\agh-home'
$env:AGNES_PROFILE='local-dev'
$env:AGH_SIGNAL_HOME='D:\dev\agnes-project\agh-signal'
node .\packages\cli\dist\local\agnes.mjs daemon stop
node .\packages\cli\dist\local\agnes.mjs serve

# C. 安装插件（另开终端，变量同上）
Copy-Item -Recurse -Force 'D:\dev\agnes-project\agh-signal\plugin' 'D:\dev\agnes-project\agnes-harness\examples\packages\traffic-tools'
node .\packages\cli\dist\local\agnes.mjs package inspect file:./examples/packages/traffic-tools
node .\packages\cli\dist\local\agnes.mjs install file:./examples/packages/traffic-tools
node .\packages\cli\dist\local\agnes.mjs package trust @agh-signal/traffic-tools <INTEGRITY> <CAPABILITY_HASH>
node .\packages\cli\dist\local\agnes.mjs package enable @agh-signal/traffic-tools
node .\packages\cli\dist\local\agnes.mjs package status
```
