/**
 * 时变负荷（负荷曲线）能力的类型定义。
 *
 * 与老接口共用同一套模型语义（见 src/types.ts）：
 * - 状态 n = 系统内顾客数，0..K，含正在服务的那一个；
 * - n === K 时到达立即拒绝（阻塞/丢弃）；
 * - 单服务台，服务时间 Exp(μ)。
 *
 * 时变模型额外约定：
 * - μ 与容量 K 在整条曲线上固定；
 * - 时间轴被切成首尾相接的若干时段（segment），第 k 段有自己的时长 d_k 与
 *   到达率 λ_k，段内到达是速率 λ_k 的齐次 Poisson 过程；
 * - 核算一律从系统为空（n=0、概率分布 δ_0）开始，段与段之间状态连续延续，
 *   绝不逐段清零。
 */

/** 登记曲线 / 新增版本时提交的单个时段 */
export interface SegmentInput {
  /** 时段时长（> 0，上限见 validation） */
  duration: number;
  /** 该时段的名义到达率 λ（允许为 0：该时段没有到达；不允许为负） */
  lambda: number;
}

/** 持久化后的时段（结构与 SegmentInput 相同，语义上不可变） */
export type Segment = SegmentInput;

/** 登记一条新曲线的请求 */
export interface RegisterCurveInput {
  name?: string;
  /** 全曲线固定的服务率 μ（> 0） */
  mu: number;
  /** 全曲线固定的系统总容量 K（正整数） */
  capacity: number;
  /** 仿真固定种子，[0, 2^32-1] 整数，缺省 1；曲线各版本共用同一条随机数流 */
  seed?: number;
  /** 第一个版本的时段表（至少 1 段） */
  segments: SegmentInput[];
}

/** 新增版本的请求：提交完整时段表，服务端按前缀比对判定增量起点 */
export interface AddVersionInput {
  segments: SegmentInput[];
}

/** 曲线的一个不可变版本 */
export interface CurveVersion {
  /** 版本号，从 1 开始单调递增 */
  version: number;
  /** 父版本号；首版为 0 */
  parentVersion: number;
  segments: Segment[];
  createdAt: string;
}

/** 曲线聚合根（含全部版本） */
export interface CurveRecord {
  id: string;
  name: string | null;
  mu: number;
  capacity: number;
  seed: number;
  createdAt: string;
  versions: CurveVersion[];
}

/** 瞬态解析的单段结果（全部为段内时间平均，另附段末分布） */
export interface TransientAnalyticSegment {
  index: number;
  duration: number;
  lambda: number;
  /** 段内时间平均阻塞概率 = 段内 p_K(t) 的时间平均 */
  timeAveragedBlockingProbability: number;
  /** 段内时间平均系统内人数 L̄ */
  timeAveragedMeanNumberInSystem: number;
  /** 段内时间平均排队等待人数 L̄_q */
  timeAveragedMeanNumberWaiting: number;
  /** 段内时间平均利用率 = 1 - p̄_0 */
  timeAveragedUtilization: number;
  /** 段末人数概率分布，下标即系统内顾客数，长度 K+1 */
  endStateProbabilities: number[];
}

/** 分段仿真的单段经验结果，口径对齐老 /api/simulation 的字段定义 */
export interface SegmentSimulationResult {
  index: number;
  duration: number;
  lambda: number;
  /** 段内到达尝试总数（含被拒） */
  totalArrivals: number;
  accepted: number;
  rejected: number;
  /** 段内经验阻塞比例 = rejected / totalArrivals（无样本时为 0） */
  blockingProbability: number;
  /** 段内时间加权平均系统内人数 */
  meanNumberInSystem: number;
  meanNumberWaiting: number;
  utilization: number;
  /** 段内经验有效到达率 = accepted / duration */
  effectiveArrivalRate: number;
  /** 段末系统内人数 */
  endNumberInSystem: number;
}

/** 单段的解析/仿真对照（绝对差） */
export interface SegmentComparison {
  blockingProbability: {
    analytic: number;
    simulation: number;
    absoluteDifference: number;
  };
  meanNumberInSystem: {
    analytic: number;
    simulation: number;
    absoluteDifference: number;
  };
  utilization: {
    analytic: number;
    simulation: number;
    absoluteDifference: number;
  };
}

/** 核算结果中的单段汇总 */
export interface ComputedSegment {
  index: number;
  duration: number;
  lambda: number;
  /** 该段是否直接复用自已持久化的父版本核算结果 */
  reused: boolean;
  analytic: TransientAnalyticSegment;
  simulation: SegmentSimulationResult;
  comparison: SegmentComparison;
}

/**
 * 跨段仿真边界上持久化的“跨界物理状态”。
 *
 * 增量核算能逐位复现所需的全部断点信息：
 * - numberInSystem：段末系统内人数（下一段的初始队长）；
 * - pendingDepartureTime：段末仍在系统中的那个顾客已抽样的离开时刻
 *   （全局绝对时间），单服务台保证至多一个在途离开；null 表示没有。
 *
 * 不保存 RNG 内部状态：每个段的随机数子流由 (曲线种子 seed, 段下标 k)
 * 经确定性函数派生（见 segment-simulation.seedForSegment），任何时候都
 * 能重新算出同样的子流种子。这样“第 k 段抽到的随机数”只取决于
 * (seed, k)，与前缀段的时长/到达率无关，前缀复用不会导致随机数错位。
 *
 * 段边界上跨界的到达事件一律丢弃：分段常数速率的 NHPP 本来就是每段
 * 一条独立 Poisson 到达流，下一段从边界时刻用本子流首个随机数重新抽
 * Exp(λ_k)，因此不需要保存任何到达事件。
 */
export interface CarryState {
  numberInSystem: number;
  pendingDepartureTime: number | null;
}

/** 一次核算的完整记录（与版本绑定、不可变） */
export interface ComputationRecord {
  curveId: string;
  version: number;
  seed: number;
  rngAlgorithm: 'mulberry32';
  /** incremental = 存在复用前缀；full = 从头完整核算（forceFull 或无可用前缀） */
  mode: 'incremental' | 'full';
  /** 首个重算段的下标；整份全部复用时等于时段数 */
  firstRecomputedIndex: number;
  computedAt: string;
  segments: ComputedSegment[];
  /** boundaries[i] = 第 i 段结束时（= 第 i+1 段入口）的跨界物理状态 */
  boundaries: CarryState[];
}

/** 持久化文件里的曲线聚合：元数据 + 版本 + 各版本核算结果 */
export interface PersistedCurve extends CurveRecord {
  computations: Record<number, ComputationRecord>;
}
