# 时变负荷（负荷曲线）能力说明

本文档说明在原有 M/M/1/K 核算服务上新增的"按一条一天内起伏的到达率曲线走一遍"
能力：数据模型、瞬态求解方法的取舍、增量复用规则、段边界状态保存与持久化。

老的三个接口 `POST /api/analytic`、`/api/simulation`、`/api/compare` 与
`GET /health` **路径、请求/响应字段、错误语义全部不变**，同一组参数与种子
结果逐位一致，且依旧**完全无状态、不读写磁盘**；存储只服务于下列新接口。

---

## 1. 模型与口径

一条曲线（curve）上：

- **服务率 μ 与系统总容量 K 在整条曲线上固定**（登记时给出，之后不变）；
- 时间轴切成若干首尾相接的时段（segment），第 i 段有时长 `duration_i > 0`
  与该段恒定到达率 `lambda_i ≥ 0`（0 表示这段时间没有到达流）；
- 状态 `n = 系统内顾客数，0..K`，含正在服务的顾客，与老接口同一套语义；
- `n === K` 时到达立即拒绝；
- **核算从系统为空（n=0）开始，段与段之间状态连续延续，绝不逐段清零。**

每段同时产出两份同口径指标（都是**段内时间平均**，不是段末瞬时值）：

| 指标 | 瞬态解析 | 固定种子仿真 |
| --- | --- | --- |
| 阻塞概率 | `(1/T)∫₀ᵀ p_K(t)dt` | 被拒到达 / 到达尝试数 |
| 平均队长 L（含服务中） | `(1/T)∫₀ᵀ Σ n·p_n(t)dt` | n 的时间加权平均 |
| 利用率 | `(1/T)∫₀ᵀ (1-p_0(t))dt` | 服务台忙的时间比例 |

解析侧另外返回**段末人数分布** `p_n(T)`（长度 K+1），它既是本段产物，也是
下一段演化的初值。仿真侧返回本段计数与段末续算状态。`difference` 给出每段
解析与仿真三样指标的绝对差。

---

## 2. 数据模型与版本

- **Curve（曲线档案）**：`id`、固定的 `mu`/`capacity`、一个只增不改的
  `versions` 数组。
- **CurveVersion（版本）**：`version`（从 1 起）、完整的一份 `segments`、
  创建时间。修改曲线 = 提交一整份新 segments → 生成新版本；旧版本永不覆盖，
  凭 `(curveId, version)` 随时原样调出。
- **Computation（核算记录）**：按 `(curveId, version, seed)` 绑定，结果
  一旦生成即不可变；事后按版本号（和种子）查到的永远是当时那份。同一 key
  重复发起核算直接返回存档（HTTP 200，首次为 201）。
- 一条版本可以用不同 seed 发起多份核算；**增量复用只在同曲线、同 seed 的
  存档之间发生**。

核算记录的每段保存：入参（duration、lambda）、`reused` 标记、解析结果、
仿真结果、差距，以及增量续算所需的 `simBoundary`（见第 5 节）。

### HTTP 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/api/curves` | 登记曲线，得到 id 与 version=1 |
| `GET` | `/api/curves` | 曲线清单 |
| `GET` | `/api/curves/:curveId` | 曲线档案（含全部版本） |
| `POST` | `/api/curves/:curveId/versions` | 提交新 segments，创建新版本 |
| `GET` | `/api/curves/:curveId/versions/:version` | 调出任一版本 |
| `POST` | `/api/curves/:curveId/versions/:version/computations` | 发起核算（body `{"seed": 42}`，缺省 1） |
| `GET` | `/api/curves/:curveId/versions/:version/computations/:seed` | 按版本+种子取当时结果 |
| `GET` | `/api/curves/:curveId/computations` | 该曲线全部核算存档 |

登记请求体：

```json
{
  "mu": 10,
  "capacity": 6,
  "name": "evening-peak",
  "segments": [
    { "duration": 1800, "lambda": 120 },
    { "duration": 1800, "lambda": 360 },
    { "duration": 3600, "lambda": 90 }
  ]
}
```

核算响应（节选）：

```json
{
  "id": "ab12..-v2-s42",
  "curveId": "ab12..",
  "version": 2,
  "seed": 42,
  "rngAlgorithm": "mulberry32",
  "reusedFrom": { "curveId": "ab12..", "version": 1, "seed": 42 },
  "firstRecomputedIndex": 2,
  "totalDuration": 7200,
  "segments": [
    {
      "index": 0, "duration": 1800, "lambda": 120, "reused": true,
      "analytic": {
        "blockingProbability": 0.05,
        "meanNumberInSystem": 2.31,
        "meanNumberWaiting": 1.52,
        "utilization": 0.79,
        "endDistribution": [0.21, 0.18, 0.15, 0.13, 0.11, 0.10, 0.12]
      },
      "simulation": { "totalArrivals": 216123, "accepted": 215900,
        "rejected": 223, "blockingProbability": 0.00103,
        "meanNumberInSystem": 2.29, "meanNumberWaiting": 1.50,
        "utilization": 0.79, "duration": 1800 },
      "difference": { "blockingProbability": 0.049, "meanNumberInSystem": 0.02,
        "utilization": 0.003 },
      "simBoundary": { "rngState": 31415926, "current": 3, "clock": 1800,
        "pendingDeparture": 1800.04, "eventsSnapshot": { "events": [ ... ],
        "counter": 432200 }, "arrivals": 216123, "accepted": 215900,
        "rejected": 223 }
    }
  ]
}
```

错误响应统一为 `400/404` + `{"error": "中文说明", "field": "出错字段"}`，
字段名指到具体段（如 `segments[2].duration`）。

---

## 3. 瞬态求解方法：均匀化（uniformization）

### 3.1 选用的方法

生灭过程的状态 `n=0..K`，生成元 Q 的非对角元为 `q_{n,n+1}=λ`、
`q_{n,n−1}=μ`（端点截断）。取 **α = λ + μ**（不小于任何 `-q_nn`），定义
行随机矩阵

```
P = I + Q/α:  P_{n,n+1}=λ/α, P_{n,n−1}=μ/α,
P_00 = μ/α,   P_KK = λ/α     （端点处被截断的质量落到对角线）
```

Kolmogorov 方程的解为 Poisson 混合：

```
p(T) = p(0) · Σ_{m≥0} a_m P^m,   a_m = e^{−αT}(αT)^m/m!
```

段内时间平均量由积分形式得到（令 `w_m = P{N(αT)>m}/(αT)`，N~Poisson(αT)，
可证 `Σ_m w_m = 1`）：

```
(1/T) ∫₀ᵀ p(t)dt = Σ_{m≥0} w_m p(0) P^m
```

实现上从 `v=p(0)` 出发反复 `v ← v·P`（三对角稀疏乘法，每步 O(K)），同一条
递推链上分别用 `a_m`、`w_m` 加权累加，一次算出**段末分布与段内平均分布**，
再由平均分布读 `p_K`、`Σ n p_n`、`1−p_0` 得到三样指标。

截断：取最小的 M 使 Poisson(αT) 的尾部 `P{N>M}` ≤ **1e-14**（用 Chernoff
界外探、再回收精确位置），这是唯一的截断误差。权重在众数处置 1、向两侧按
比值递推后归一化，避免 `e^{−αT}` 在 αT 很大时下溢成 0。每步只做非负的随机
矩阵乘法，分布天然保持非负、行和为 1；实现末尾再做一次"夹掉 ≤1e-9 量级的
舍入负值并重新归一化"的防御性清理，若出现明显负值或非有限值则直接报错。

**误差量级**：截断误差 ≤ 1e-14（分布每一项的被忽略总质量），双精度舍入误差
累计约为 M·ε 量级（M 万级时约 1e-11），归一化后实测段末分布与稳态闭式解的
逐分量差在 1e-15 量级（见 `test/transient.test.ts`）。

### 3.2 放弃的方法与理由

- **显式 Euler / Runge–Kutta 直接积 Q**：稳定性要求步长 `Δt ≲ 1/(λ+μ)`，
  αT 大时需要海量小步；显式更新还会把概率推出负数（尤其端点和大 K），需要
  不断修补，不满足"λ≫μ、K 几百不能出负数/NaN"的硬指标。
- **矩阵指数 `e^{QT}`（缩放-平方 + Padé）**：稠密矩阵乘法代价 O(K³)，K 到
  几百时单段就上亿次浮点运算；Padé 逼近在非对称 Q 上同样可能给出微小负概率。
- **Q 的特征分解**：非对称三对角矩阵的特征向量矩阵可能病态（ρ≫1 时尤甚），
  重建分布数值不稳，还要特徵值重根（ρ=1 等）的退化处理。

均匀化把"矩阵指数"化成随机矩阵上的概率迭代，无条件稳定、保非负、保质量，
每步只有 O(K)，且截断误差显式可控，因此中选。

### 3.3 上限（超限返回 400）

| 项 | 上限 | 理由 |
| --- | --- | --- |
| 时段数 | **200** | 单次核算与存档大小的工程上限 |
| 单段时长 | **1,000,000** | 防止误传单位（秒/毫秒）拖垮求解 |
| 曲线容量 K | **500**（正整数） | 瞬态按 K+1 维向量演化；稳态老接口仍允许到 100,000 |
| μ、单段 λ | μ>0；λ≥0，均 ≤ **10,000** | 与工作量上限配套 |
| 单段工作量 `(λ+μ)·duration` | **200,000** | = 均匀化迭代步数量级，单段最坏约数千万次浮点运算（实测 K=500、2 万步约 50ms） |

时段时长非正、到达率为负、容量非正整数、超任一上限，都返回带 `field` 的
400 错误。

---

## 4. 分段仿真与"逐位一致"的三条约定

仿真沿用老引擎的事件表（最小堆）与 **mulberry32** RNG，段间不断流。为了让
"分段顺序跑""存档后续跑（含重启）""只有一段"三种走法严格逐位一致，定死
三条约定：

1. **RNG 是一条不断的流。** 段边界保存 mulberry32 的 32 位内部 state
   （`Rng.fromState` 恢复，不是用种子重放）。段内抽样顺序/参数与老引擎完全
   一致：接纳一个让服务台从闲变忙的到达时，先抽这次服务的 departure、再抽
   下一个 arrival；拒绝只抽下一个 arrival；离开后仍有顾客则抽下一个
   departure。因此**单段、空系统、按时长停止**时，分段仿真与既有
   `runSimulation(maxTime=T)` 的每个浮点输出逐位相等（验收三有逐字段测试）。

2. **段边界统一重抽"下一个到达"；跨界 departure 原样保留。** 每个段是
   半开区间 `[start, end)`：段末还没发生的到达事件一律丢弃，新段用自己的 λ
   重新抽第一条到达间隔（新段 λ=0 则不安排任何到达）。这正是分段常数
   非齐次 Poisson 过程的合法构造（每段在边界处以新速率独立开启指数间隔），
   统计无偏。服务时间不重抽——μ 整条曲线恒定，跨界那次服务的 departure
   时刻换算到新段局部时间后继续留在事件表里。

3. **时刻恰等于段末的事件不在本段处理**（先 `peek` 最早事件，`time ≥ T`
   即停），留给下一段。同时刻事件的平局裁决仍靠插入序号 seq，seq 水位也随
   边界存档带走。

段内时钟用**相对段初的局部时间**：存档时把残留事件时刻加回累计绝对时钟，
恢复时再减去段初绝对时钟。增量路径与全量路径执行的是同一组浮点运算；存档
用 JSON 落盘，而 JSON 对 IEEE-754 double 逐位保真，所以**重启前后、增量
与全量结果逐位相同**。

---

## 5. 增量复用规则与边界状态

### 5.1 判定规则

发起对版本 V 的核算（seed=s）时：

1. 若 `(V,s)` 已有存档，直接返回（幂等，不算也不写）。
2. 否则扫描同曲线、同 s 的全部已存档核算，取其对应版本与 V 的时段序列逐个
   比较 `(duration, lambda)`，找到**共享前缀长度 L 最大**的那份
   （没有任何共享前缀或无存档时 L=0）。
3. 前 L 段的段记录从存档**原样拷贝**（`reused=true`，含解析结果、仿真结果
   与 `simBoundary`）；从第 L 段起重算（`reused=false`）。响应里
   `firstRecomputedIndex = L`、`reusedFrom` 标明来源版本。
4. 改中间第 k 段 → L=k（第 k 段起重算）；末尾追加 → L=旧段数；改第一段 →
   L=0 全量重算。

### 5.2 为什么这样能保证逐位相同

关键是**因果局部性**：每段的输出只取决于"本段的 (duration,λ,μ,K)"和"段初
边界状态"，完全不看后面的时段。

- 解析侧：第 i 段的唯一外部输入是第 i−1 段的段末分布 `p_n(T)`。共享前缀里
  每段的入参与段初状态都没变，存档的段末分布与全量重算产生的是同一个 double
  数组，重算段从同一个分布出发 → 后面全部相同。
- 仿真侧：第 i 段的外部输入是第 i−1 段的 `simBoundary`（见下）。存档边界与
  内存对象位级一致（JSON double 保真），RNG 从同一 32 位状态续跑，事件表、
  seq 水位、系统人数、未完成服务时刻全部相同，且"边界重抽到达"用掉的随机数
  在增量与全量两条路径上位置一致 → 逐事件轨迹、逐段统计、再下游的边界全部
  逐位相同。

### 5.3 段边界保存了什么（`simBoundary`）

只保留下一段开工所需的最小信息：

| 字段 | 作用 |
| --- | --- |
| `rngState` | mulberry32 的 32 位内部状态，随机数流逐位续上 |
| `current` | 段末系统内人数 |
| `clock` | 段末绝对仿真时钟（段时长逐段累加），事件时刻换算用 |
| `eventsSnapshot` | 残留事件表（只可能含至多一个跨界 departure，无 arrival）+ 插入序号水位 |
| `pendingDeparture` | 残留 departure 的绝对时刻（冗余的可读字段，current=0 时为 null） |
| `arrivals/accepted/rejected` | 本段计数（下一段从零计数，留档便于核对） |

解析侧的段间状态就是段记录里的 `analytic.endDistribution`，无需额外结构。

---

## 6. 持久化与重启

- 形式：**本地 JSON 文件，无外部数据库**（数据目录由 `DATA_DIR` 指定，
  缺省 `./data`）。老接口不引用存储模块，性能与依赖不受影响。
- 布局：`curves/<id>.json`（曲线与全部版本，写入为整档案替换）；
  `computations/<id>__v<n>__s<seed>.json`（每份核算一个不可变文件，含全部
  段结果与 `simBoundary`）。
- 写入：临时文件 `write` + `rename` 原子替换，崩溃不会留下半截 JSON；
  进程内按曲线加异步互斥锁，同曲线的登记/建版/核算串行化。
- 重启后：曲线、版本、核算结果、增量中间状态全部从文件读回；再次增量核算
  与从头完整重算仍逐位一致（`test/restart.test.ts` 用两次真实拉起
  `dist/server.js` 验证）。

Docker（仍以 `node:20-slim` 为底）挂数据卷：

```bash
docker build -t mm1k-capacity-service .
docker volume create mm1k-data
docker run --rm -p 8080:8080 \
  -v mm1k-data:/app/data -e DATA_DIR=/app/data \
  mm1k-capacity-service
```

本地：

```bash
npm ci && npm run build
DATA_DIR=./data npm start     # 缺省就是 ./data
npm test                      # 含解析/仿真/接口 + 时变全部验收（先 build 再起停真实进程）
```

---

## 7. 模块划分（新能力独立成模块，不改老路由/引擎的职责）

```
src/
  timevarying/
    types.ts               曲线、版本、核算、段边界的数据模型
    validation.ts          曲线/版本/核算入参校验与上限（错误带 field）
    transient.ts           均匀化瞬态求解（段末分布 + 段内时间平均指标）
    segment-simulation.ts  分段 DES：段边界续跑、三条逐位一致约定
    curve-service.ts       版本管理、增量复用判定、computeVersionFull 全量参照
    store.ts               JSON 文件持久化（原子写、按曲线互斥）
  routes/
    curve-routes.ts        新接口的 HTTP 适配（老 queue-routes.ts 未动）
  simulation/
    rng.ts                 仅增量：internalState 读取与 fromState 恢复
    event-list.ts          仅增量：peek / snapshot / restore
  validation/validation.ts 仅增量：可选 field 与 NotFoundError（老语义不变）
test/
  transient.test.ts              验收一/二/四（解析侧）
  segment-simulation.test.ts     验收三（逐位一致）与边界约定
  curve-service.test.ts          验收五（服务层增量=全量）
  curve-api.test.ts              HTTP 全流程 + 验收三/四/七错误语义
  restart.test.ts                验收六（真实进程重启）
```
