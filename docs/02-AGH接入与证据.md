# AGH 接入与证据留存

本文命令都在 AGH 源码仓库根目录执行（你的环境是 D:\dev\agnes-project\agnes-harness），
本地分发入口是 node packages\cli\dist\local\agnes.mjs。

## 一、先确认 AGH 能跑

```powershell
Set-Location 'D:\dev\agnes-project\agnes-harness'
$env:AGH_HOME = 'D:\dev\agnes-project\agh-home'
$env:AGNES_PROFILE = 'local-dev'
node .\packages\cli\dist\local\agnes.mjs daemon status
```

## 二、让 AGH 知道项目在哪

插件通过环境变量 AGH_SIGNAL_HOME 定位项目根目录。这个变量必须对 daemon 进程可见，
所以要在启动或重启 daemon 的那个会话里设置：

```powershell
$env:AGH_SIGNAL_HOME = 'D:\dev\agnes-project\agh-signal'
```

改过这个变量后必须重启后台，否则 daemon 里还是旧值：

```powershell
node .\packages\cli\dist\local\agnes.mjs daemon stop
node .\packages\cli\dist\local\agnes.mjs serve
```

## 三、安装并启用工具插件

插件目录是 D:\dev\agnes-project\agh-signal\plugin，包名 @agh-signal/traffic-tools，版本 1.0.0。

```powershell
Set-Location 'D:\dev\agnes-project\agnes-harness'
$env:AGH_HOME = 'D:\dev\agnes-project\agh-home'
$env:AGNES_PROFILE = 'local-dev'
$env:AGH_SIGNAL_HOME = 'D:\dev\agnes-project\agh-signal'

# 1) 把插件目录复制到 AGH 工作区根目录下
#    file: 来源只接受 ./ 开头的相对路径（不能绝对路径、不能反斜杠、不能有 .. 或盘符冒号），
#    且相对 daemon 的工作区根解析，所以先把插件放进工作区里再引用。
Copy-Item -Recurse -Force 'D:\dev\agnes-project\agh-signal\plugin' 'D:\dev\agnes-project\agnes-harness\examples\packages\traffic-tools'

# 2) 检查：看包 ID、版本、来源、integrity、capabilityHash、警告与 blocker
node .\packages\cli\dist\local\agnes.mjs package inspect file:./examples/packages/traffic-tools

# 3) 安装：会展示预览并要求确认
node .\packages\cli\dist\local\agnes.mjs install file:./examples/packages/traffic-tools

# 4) 核对实际状态：desired 与 actual 都要看
node .\packages\cli\dist\local\agnes.mjs package status
```

**注意：CLI 只能走到"安装"这一步。** `package trust` 的参数里 `capabilityHash` 是必填
（schema 要求 64 位十六进制），但 CLI 的 `package inspect` 预览只打印 `id / integrity /
contributions / warnings`，**不打印 capabilityHash**，所以纯命令行无法完成审核绑定。
审核与启用请走 Web：

「设置 → 插件 → Install from source」→ Source type 选 `file` → Source reference 填
`file:./examples/packages/traffic-tools` → Check source → 安装 → 启用。
（下拉框默认是 `npm`，必须改成 `file`；Web 流程会在启用时自动绑定完整性摘要与能力摘要，
不需要手抄哈希。）

装完不用重启 daemon，新能力在轮次边界生效：下一轮对话即可调用。

## 四、免模型自检（不花额度）

插件本身能不能跑通，和模型会不会选它，是两件事。先确认前者：

```powershell
Set-Location 'D:\dev\agnes-project\agh-signal'
node tools\plugin-selftest.mjs
```

预期输出 status 为 ok，并列出 5 个工具。这一步不需要 AGH，也不需要模型。

## 五、产生"运行证据"的会话脚本

官方提交要求里有 AGH 执行记录、至少 1 条工具调用链、Agnes 模型参与核心任务的证据。
建议在一个会话里按下面顺序跑，让证据自然形成，不要事后补：

1. 看工况
   > 调用 traffic_scenarios 列出所有工况，并说明哪个是失败样例、为什么必须被拒绝。
2. 寻优
   > 调用 traffic_optimize 处理 normal 工况，告诉我最优方案、公平性方案，以及与现状固定配时的差距。
3. 边界复核
   > 对 peak 和 incident 两个工况分别调用 traffic_optimize，说明基准配时是否仍然可用；不可用时要怎么处置。
4. 失败路径
   > 调用 traffic_optimize 处理 oversaturated 工况，确认它必须被拒绝，并给出降级建议。
5. 出报告
   > 调用 traffic_report 生成报告文件，并列出产物路径。
6. 交叉验证（装了 SUMO 之后）
   > 用 traffic_simulate 给出 normal 工况下 C=70、greenNS=34 的延误，再用 sumo-sim 复核同一方案，比较两者车均延误差异并解释原因。

每一步的调用参数、返回 JSON 和你的判断都会留在 AGH 会话记录里，可直接作为运行证据。
另外把每轮结果另存一份到 D:\dev\agnes-project\agh-signal\artifacts\evidence\（截图或 JSON 都行）。

## 六、备选接入方式：MCP

如果以后希望把仿真环境做成独立进程（例如换成真实信号机接口），可以走 MCP：

```powershell
node .\packages\cli\dist\local\agnes.mjs mcp add agh-signal --name agh-signal --stdio node --arg 'D:\dev\agnes-project\agh-signal\mcp-server.mjs'
node .\packages\cli\dist\local\agnes.mjs mcp get agh-signal
node .\packages\cli\dist\local\agnes.mjs mcp trust agh-signal --expected-revision REVISION
node .\packages\cli\dist\local\agnes.mjs mcp enable agh-signal --expected-revision REVISION
node .\packages\cli\dist\local\agnes.mjs mcp tools agh-signal
```

三个注意点：--stdio 只接受可执行文件，不要把整条 shell 命令塞进去；每次写操作前用 mcp get 取最新 revision；
MCP 服务需要自己实现按行分隔的 stdio JSON-RPC。当前项目默认走插件路径，MCP 只在需要独立进程时再启用。

## 七、排错

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 工具报 AGH_SIGNAL_HOME 未设置 | daemon 没继承该变量 | 在启动会话设置后 daemon stop 再 serve |
| 工具报找不到 src/cli.mjs | 变量指错目录 | 指向含 src 的项目根目录 |
| package enable 失败 | integrity 或 capabilityHash 与当前版本不符 | 重新 package inspect 取新值；改过插件代码就要重装并重新审核 |
| 模型不调用工具 | 提示词没点名工具，或插件尚未到轮次边界 | 提示里直接写工具名，并确认 package status 的 actual 是 ready |
| 报告中文显示异常 | 终端代码页问题 | 报告是 UTF-8 文件，用编辑器打开即可 |
| `export` 报 `CAPABILITY_DENIED (-32006)` | 该会话是 **Web 界面**创建的，归 Web 客户端身份所有；一次性 CLI 是另一个身份，AGH 的所有权隔离会拒绝跨身份读取 | 用 CLI 一次性模式 `-p` 重跑取证（会话就归 CLI 所有，可导出），或直接截图 Web 会话；推荐直接跑 `tools\collect-evidence.ps1` |
| 脚本里 `ConvertFrom-Json` 报"应为 : 或 }" | PowerShell 按控制台代码页解码 node 输出，UTF-8 中文变乱码 | 脚本开头加 `[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)` |
