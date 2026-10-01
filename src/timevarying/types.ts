/**
 * 时变负荷（负荷曲线）相关的数据模型。
 *
 * 一条负荷曲线：
 * - 整条曲线上服务率 mu 与系统总容量 capacity 固定；
 * - 时间轴切成若干首尾相接的时段 segment，每段有自己的时长 duration
 *   与到达率 lambda（允许为 0，表示该时段无到达流）；
 * - 每次修改记成新版本（version），旧版本原样保留；
 * - 对某版本发起一次核算（computation，按 seed 区分），结果与版本绑定。
 *
 * 核算始终从系统为空（n=0）开始，状态在时段之间连续延续，绝不逐段清零。
 */

/** 负荷曲线的一个时段 */
export interface CurveSegmentInput {
  /** 时段时长（> 0） */
  duration: number;
  /** 该时段到达率 λ（>= 0，0 表示无到达） */
  lambda: number;
}

/** 已登记的时段（归一化后，字段与输入一致） */
export interface CurveSegment extends CurveSegmentInput {}

/** 曲线的一个版本（不可变存档） */
export interface CurveVersion {
  version: number;
  mu: number;
  capacity: number;
  segments: CurveSegment[];
  name?: string;
  createdAt: string;
}

/** 曲线档案 */
export interface CurveRecord {
  id: string;
  name?: string;
  mu: number;
  capacity: number;
  versions: CurveVersion[];
  createdAt: string;
  updatedAt: string;
}

/**
 * 仿真跨越段边界时必须续存的状态。
 *
 * 段末快照只保存“下一段开工所需的最小信息”：
 * - rngState：mulberry32 的 32 位内部状态，保证随机数流逐位续上；
 * - current：段末系统内人数；
 * - clock：段末绝对仿真时钟（段时长逐段累加）；
 * - pendingDeparture：段末系统非空时，正在进行的那次服务计划完成的绝对时刻；
 *   系统为空时为 null。服务率整条曲线不变，服务时间样本跨界不重抽；
 * - eventsSnapshot：事件表（只可能残留至多一个已越过段末的 departure）
 *   及其插入序号水位，恢复后堆结构与平局裁决完全一致；
 * - counters：本段的到达/接纳/拒绝计数（下一段从零开始，但留档便于核对）。
 *
 * 段末残留的“下一个到达”不保存：每个段边界都按新段到达率重新抽一个
 * 首到达（λ=0 时不安排到达）。这正是分段仿真与一次性整跑逐位一致的关键
 * 约定，详见 TIMEVARYING.md。
 */
export interface SimBoundaryState {
  rngState: number;
  current: number;
  clock: number;
  pendingDeparture: number | null;
  eventsSnapshot: {
    events: Array<{ kind: 'arrival' | 'departure'; time: number; seq: number }>;
    counter: number;
  };
  arrivals: number;
  accepted: number;
  rejected: number;
}

/** 单段瞬态解析结果 */
export interface TransientSegmentResult {
  /** 段内时间平均阻塞概率 = (1/T)∫ p_K(t) dt */
  blockingProbability: number;
  /** 段内时间平均平均队长 L = (1/T)∫ Σ n·p_n(t) dt */
  meanNumberInSystem: number;
  /** 段内时间平均排队等待人数 */
  meanNumberWaiting: number;
  /** 段内时间平均利用率 = (1/T)∫(1 - p_0(t)) dt */
  utilization: number;
  /** 段末人数分布 p_n(T)，n = 0..K */
  endDistribution: number[];
}

/** 单段仿真经验结果（口径与解析侧一致，均为段内时间平均） */
export interface SimulationSegmentResult {
  totalArrivals: number;
  accepted: number;
  rejected: number;
  /** 段内经验阻塞比例 = 被拒到达 / 到达尝试（无样本定义为 0） */
  blockingProbability: number;
  meanNumberInSystem: number;
  meanNumberWaiting: number;
  utilization: number;
  /** 段长（仿真统计时域长度，即该段 duration） */
  duration: number;
}

/** 解析与仿真的逐项差距 */
export interface SegmentDifference {
  blockingProbability: number;
  meanNumberInSystem: number;
  utilization: number;
}

/** 核算结果中的一个时段记录（含复用所需的续算状态） */
export interface ComputationSegmentRecord {
  index: number;
  duration: number;
  lambda: number;
  /** true = 该段直接复用上一版核算的存档，未重新计算 */
  reused: boolean;
  analytic: TransientSegmentResult;
  simulation: SimulationSegmentResult;
  difference: SegmentDifference;
  /** 段末仿真边界状态：下一段增量续跑或重启后续跑所依赖的中间状态 */
  simBoundary: SimBoundaryState;
}

/** 一次核算的完整记录（与 curve/version/seed 绑定，不可变） */
export interface ComputationRecord {
  id: string;
  curveId: string;
  version: number;
  seed: number;
  rngAlgorithm: 'mulberry32';
  createdAt: string;
  /** 复用来源：{curveId,version,seed}（首算或全重算时为 null） */
  reusedFrom: { curveId: string; version: number; seed: number } | null;
  /** 第一个被重新计算的段下标；全量计算为 0 */
  firstRecomputedIndex: number;
  segments: ComputationSegmentRecord[];
  /** 曲线总时长（各段时长之和） */
  totalDuration: number;
}
