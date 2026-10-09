# SUMO 接入步骤（微观仿真交叉验证）

SUMO 是可免费下载的微观交通仿真器，装好之后本项目会自动使用它复核配时方案。
没装也不影响主流程：`sumo-check` 会返回 available=false，其它命令照常工作。

## 一、安装 SUMO（Windows）

1. 到 SUMO 官网下载 Windows 安装包（或解压版）。
2. 装好后设置环境变量，让本项目能找到它：

```powershell
$env:SUMO_HOME = 'C:\Program Files (x86)\Eclipse\Sumo'   # 换成你的实际安装路径
$env:Path = "$env:SUMO_HOME\bin;$env:Path"
```

3. 验证：

```powershell
Set-Location 'D:\dev\agnes-project\agh-signal'
node src\cli.mjs sumo-check
```

期望看到 available 为 true，并给出 sumo 与 netgenerate 的路径。

## 二、生成路网并核对相位映射

本项目用 netgenerate 自动生成单点四臂路网（不需要画图，也不需要 OSM 数据）：

```powershell
node src\cli.mjs sumo-sim --scenario normal --cycle 70 --green-ns 34
```

首次运行会在 artifacts\sumo\normal\ 下生成 net.net.xml、routes.rou.xml、tls.add.xml 与 sumo.sumocfg。
随后核对相位（关键步骤，不同 SUMO 版本与路网结构会不同）：

```powershell
node src\cli.mjs sumo-map
```

输出会列出 tlLogic 的每个相位（序号、时长、state 字符串、是否绿灯）。默认约定是：

- 绿灯相位按出现顺序分成两组，前一半归南北（NS），后一半归东西（EW）；
- 黄灯等过渡相位保持原时长。

如果你的路网相位顺序不是这样，用环境变量覆盖，然后重新运行：

```powershell
$env:SIGNAL_LOOP_PHASE_GROUPS = 'EW,NS'
```

核对方法：把 net.net.xml 用 sumo-gui 打开，观察哪个方向先放行，与 state 字符串对照。
这一步只需要做一次，做完把结论写进作品说明（"相位映射已核对"本身就是验证证据）。

## 三、与解析模型对照

同一条命令会同时给出两套结果：

- analytic：本项目分析模型给出的车均延误（秒）
- sumo.metrics：SUMO tripinfo 解析出的 avgTimeLossSec（秒/车）、停车次数、总延误小时

判定标准（写进报告用）：

| 差异 | 结论 |
| --- | --- |
| ≤ 30% | 两套独立方法一致，互证通过 |
| 30%–60% | 可接受，但需在说明里解释（例如左转处理方式、饱和流率差异） |
| > 60% | 视为不一致，先检查相位映射、需求单位、仿真时长与是否出现溢出排队 |

注意 tripinfo 里的 timeLoss 是把自由流作为基准的延误，与 Webster 均匀延误的口径不完全相同，
所以两者不要求逐位相等，只看量级与排序是否一致。

## 四、把 SUMO 结果纳入验证报告

建议做法：把每个工况的对照结果整理成一张表（工况、analytic 车均延误、SUMO 车均延误、差异百分比、
结论），附在 artifacts 下，并在报告正文里引用。这张表是"验证严谨性"这一项最直接的证据。

## 五、常见问题

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| sumo-check 仍为 false | PATH 或 SUMO_HOME 没生效 | 重开终端，或直接用绝对路径设置 SUMO_BIN |
| netgenerate 报未知参数 | SUMO 版本参数名不同 | 运行 netgenerate --help 核对车道数参数名，改 src/demand.mjs 的 netgenerateCommand |
| 车流报错找不到 edge | 生成的路网 edge id 与约定不同 | 打开 net.net.xml 核对 edge id，改 src/demand.mjs 的 EDGE_OF 映射 |
| 车辆全部堆积不动 | 相位映射错误（绿灯给了错误方向） | 按第二节重新核对并设置 SIGNAL_LOOP_PHASE_GROUPS |
| 仿真很久不结束 | 需求超过容量导致拥堵 | 换正常工况先跑通，再用 oversaturated 观察溢出现象 |
