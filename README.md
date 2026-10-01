# M/M/1/K 排队核算服务

有限容量单服务台排队（M/M/1/K）的容量评估后端：对同一组到达率 λ、服务率 μ、
系统总容量 K（含正在服务的那一个），同时给出**稳态解析值**与**离散事件仿真值**，
并把阻塞概率、平均队长、利用率三样指标摆到一起互相印证。

## 统一的模型语义

解析与仿真共用同一套状态定义与拒绝语义，不存在“一边按排队人数、一边按缓冲槽位”的错位：

- 系统状态 `n = 系统内顾客数`，取值 `0..K`，**n 已包含正在被服务的顾客**；
- `n === K` 时新到达的请求**立即拒绝（阻塞/丢弃）**，不排队、不改变到达过程；
- 到达间隔 `Exp(λ)`，服务时间 `Exp(μ)`，单服务台。

## 解析模型

生灭过程细致平衡给出几何级数形式的稳态分布：

```
π_n = π_0 · ρ^n,   ρ = λ/μ,   n = 0..K
```

- `ρ = 1` 时退化为均匀分布 `π_n = 1/(K+1)`；
- 阻塞概率 `P_block = π_K`；
- 有效到达率 `λ_e = λ(1 - π_K)`；
- 利用率 `U = λ_e / μ = 1 - π_0`；
- 平均队长 `L = Σ n·π_n`；
- 平均逗留时间 `W = L / λ_e`（`λ_e = 0` 的极端情形定义为 0，不返回无穷）。

几何权重在对数空间计算并平移，ρ > 1、K 较大时也不会上溢成 NaN。

## 仿真模型

- 事件表（最小堆）推进仿真时钟，只含 `arrival` / `departure` 两类事件；
- PRNG 固定为 **mulberry32**（算法名随响应返回 `rngAlgorithm`），
  指数样本由逆变换 `-ln(U)/rate` 得到；**同一 seed 两次运行结果逐位一致**；
- 停止条件 `maxArrivals`（到达尝试数，含被拒）与 `maxTime`（仿真时长）至少给一个，先到先停；
- 平均队长、利用率均为时间加权平均（状态对时间积分 / 时域长度）；
  经验阻塞比例 = 被拒到达数 / 总到达尝试数。

## HTTP 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/api/analytic` | 只算稳态解析 |
| `POST` | `/api/simulation` | 只跑离散事件仿真 |
| `POST` | `/api/compare` | 一次返回两者及三样指标对照表 |
| `GET` | `/health` | 健康检查 |

`/api/analytic` 请求体：

```json
{ "lambda": 8, "mu": 10, "capacity": 4 }
```

`/api/simulation` 与 `/api/compare` 额外需要仿真控制参数：

```json
{
  "lambda": 8, "mu": 10, "capacity": 4,
  "seed": 20240901,
  "maxArrivals": 500000,
  "maxTime": 400
}
```

校验规则：`lambda`、`mu` 必须为正数，`capacity` 必须为正整数，
`seed` 为 `[0, 2^32-1]` 内整数（缺省 1），停止条件至少提供一个。
非法输入返回 `400` 与错误信息。

`/api/compare` 的 `comparison` 字段逐项给出 `analytic`、`simulation`、`absoluteDifference`。

## 时变负荷（负荷曲线）

上面三个接口回答的是“到达率恒定、系统早已平衡”的**稳态**问题。新增的
时变能力回答“按今天这条起起落落的流量曲线走一遍，每个时段实际拒掉多少、
队有多长”：服务率 μ 与容量 K 全曲线固定，时间轴切成若干首尾相接的时段，
每段有自己的时长与到达率；从系统为空开始，状态在段间连续延续，每段同时
给出**瞬态解析**与**固定种子仿真**，并支持“改一段只重算该段之后”的
增量核算（增量结果与从头完整重算**逐位一致**，服务重启后仍成立）。

完整设计（数据模型、瞬态求解方法取舍、分段随机数流、增量判定、边界状态、
持久化与容差）见 **[docs/time-varying.md](docs/time-varying.md)**。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/api/curves` | 登记曲线（含第 1 版） |
| `GET` | `/api/curves` | 列出全部曲线 |
| `GET` | `/api/curves/:curveId` | 取曲线（含全部版本摘要） |
| `POST` | `/api/curves/:curveId/versions` | 新增版本（提交完整时段表，老版本保留） |
| `GET` | `/api/curves/:curveId/versions/:v` | 取指定版本时段表 |
| `POST` | `/api/curves/:curveId/versions/:v/computation` | 发起核算（幂等）；`{"forceFull":true}` 只读完整重算不落盘 |
| `GET` | `/api/curves/:curveId/versions/:v/computation` | 查询核算结果（未核算返回 404） |

登记曲线请求体：

```json
{
  "name": "晚高峰",
  "mu": 10,
  "capacity": 20,
  "seed": 20240901,
  "segments": [
    { "duration": 30, "lambda": 5 },
    { "duration": 20, "lambda": 25 },
    { "duration": 30, "lambda": 6 }
  ]
}
```

约束：时段数 1..64、单段时长 (0, 1000]、曲线总时长 ≤ 10000、容量 ≤ 1000、
λ/μ ≤ 10000、λ 允许为 0；μ、K、seed 在整条曲线上固定，新增版本只能改
时段表。非法输入返回 `400` 与 `{ error, fields }`（`fields` 精确到出错字段，
如 `segments[2].lambda`）；引用不存在的曲线/版本返回 `404`。

每段核算结果含 `analytic`（段内时间平均阻塞概率/平均队长/利用率与
**段末人数分布**）、`simulation`（同口径经验值）、`comparison`（逐项绝对差）
以及 `reused` 标记；顶层 `mode`（`full`/`incremental`）与
`firstRecomputedIndex` 标明复用范围。

### 持久化与数据目录

曲线、版本、核算结果（含增量所需的段末跨界状态）以每条曲线一个 JSON 文件
落在数据目录（原子写、double 逐位往返）。目录由环境变量 `TIMVAR_DATA_DIR`
指定，缺省为进程工作目录下的 `./data`，懒创建。**老的三个接口不读写存储、
不依赖数据目录。**

本地开发：

```bash
TIMVAR_DATA_DIR=./data npm run dev
```

### 瞬态求解方法（一句话）

瞬态解析用**均匀化（uniformization）**解生灭过程向前方程：转移矩阵与
Poisson 权重严格非负，从分布众数展开权重避免 `e^{-αd}` 下溢，配子步与
稳态提前退出；显式 ODE 积分（有负概率风险）与矩阵对角化（O(K³)、临界
敏感）被放弃。上限内段末/时间平均分布绝对误差 ≲ 1e-9。详见
docs/time-varying.md。

## 本地运行（Node.js 20）

```bash
npm ci
npm run build
npm start                 # 默认 8080，可用 PORT 覆盖
npm test                  # node:test 自动化测试（解析/仿真/接口）
npm run typecheck
```

开发模式：`npm run dev`（tsx watch）。

## Docker

```bash
docker build -t mm1k-capacity-service .

# 不挂卷：数据写在容器内 /data，容器删除即丢失（仅适合试用）
docker run --rm -p 8080:8080 mm1k-capacity-service

# 挂命名卷持久化时变负荷数据（推荐）：
docker volume create mm1k-data
docker run --rm -p 8080:8080 \
  -v mm1k-data:/data \
  mm1k-capacity-service

# 或挂载宿主机目录（注意容器内以非 root 用户 node 运行，目录需可写）：
docker run --rm -p 8080:8080 \
  -v "$(pwd)/data:/data" \
  mm1k-capacity-service
```

镜像内把 `TIMVAR_DATA_DIR` 固定为 `/data` 并已交给 `node` 用户；
也可用 `-e TIMVAR_DATA_DIR=/别的路径` 覆盖（需配合相应挂载与权限）。

基于 `node:20-slim`，镜像内完成 TypeScript 编译并裁剪掉开发依赖，单容器启动后即对外应答。

## 模块划分

```
src/
  types.ts                    共享类型与模型语义约定
  analytics/analytic.ts       稳态分布与解析指标
  simulation/
    rng.ts                    mulberry32 随机数发生器 + 指数抽样
    event-list.ts             最小堆事件表
    engine.ts                 离散事件仿真引擎
  metrics/metrics.ts          时间加权累加器与对照表汇总
  validation/validation.ts    输入校验（解析/仿真/路由共用）
  routes/queue-routes.ts      三个业务接口
  timvar/                     时变负荷能力（独立模块，详见 docs/time-varying.md）
    types.ts                  曲线/版本/核算/段边界类型
    validation.ts             时变输入校验（上限、带 fields 的错误）
    transient.ts              瞬态解析：均匀化求解
    segment-simulation.ts     分段 DES：子流派生与跨界状态
    storage.ts                JSON 持久化（原子写）
    service.ts                版本链、增量判定与核算编排
    routes.ts                 /api/curves/... 路由
  app.ts / server.ts          Express 装配与启动
test/                         解析、仿真、HTTP、时变（含真实进程重启）自动化测试
docs/time-varying.md          时变负荷设计与容差说明
```

## 关键回归测试

- 长仿真 + 固定种子：经验阻塞比例/利用率/平均队长落入解析值容差；
- 阻塞概率关于 K 单调不增（ρ<1、=1、>1 三种情形）；
- λ、μ 同比例放大（比值不变）：稳态分布形状不变；
- 预置算例 λ=0.8、μ=1（ρ=0.8）、K=200：平均队长收敛到无限容量
  经典闭式 `L = ρ/(1-ρ) = 4`、`W = 1/(μ-λ) = 5`。
