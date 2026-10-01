import { randomUUID } from 'node:crypto';
import { JsonCurveStore } from './storage.js';
import { evolveSegment, averageMetrics } from './transient.js';
import { initialCarry, runSegment } from './segment-simulation.js';
import type {
  CarryState,
  ComputationRecord,
  ComputedSegment,
  CurveRecord,
  CurveVersion,
  PersistedCurve,
  Segment,
  TransientAnalyticSegment,
} from './types.js';

/** 引用不存在的曲线 / 版本：路由层据此返回 404（与 400 参数错误区分） */
export class NotFoundError extends Error {
  readonly statusCode = 404;
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}

export interface RegisterCurveData {
  name?: string;
  mu: number;
  capacity: number;
  seed: number;
  segments: Segment[];
}

export interface ComputeResult {
  curve: CurveRecord;
  computation: ComputationRecord;
  /** 该版本此前是否已核算（已核算时返回的是持久化的原样结果） */
  alreadyComputed: boolean;
}

interface CurveFixedParams {
  mu: number;
  capacity: number;
}

/**
 * 时变负荷应用服务：负责曲线/版本的生命周期与“核算”的增量编排。
 *
 * 所有方法都是同步阻塞实现（文件 IO 也是同步的），Node 单线程下一个
 * 请求处理期间不会让出事件循环，因此同一条曲线天然不会出现两个写操作
 * 交错，不需要额外的进程内锁。
 */
export class LoadCurveService {
  constructor(private readonly store: JsonCurveStore) {}

  /** 登记一条曲线（含第 1 版） */
  register(data: RegisterCurveData): CurveRecord {
    const now = new Date().toISOString();
    const record: PersistedCurve = {
      id: randomUUID(),
      name: data.name ?? null,
      mu: data.mu,
      capacity: data.capacity,
      seed: data.seed,
      createdAt: now,
      versions: [
        {
          version: 1,
          parentVersion: 0,
          segments: structuredClone(data.segments),
          createdAt: now,
        },
      ],
      computations: {},
    };
    this.store.save(record);
    return this.asCurveRecord(record);
  }

  getCurve(curveId: string): CurveRecord {
    return this.asCurveRecord(this.requirePersisted(curveId));
  }

  /** 列出全部曲线 */
  listCurves(): CurveRecord[] {
    return this.store
      .list()
      .map((id) => this.asCurveRecord(this.store.load(id)!))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  getVersion(curveId: string, version: number): CurveVersion {
    const curve = this.requirePersisted(curveId);
    return structuredClone(this.requireVersion(curve, version));
  }

  /**
   * 新增版本：提交完整时段表，版本号自增、父版本为当前最新版本。
   * 老版本原样保留，任何核算结果都不被覆盖。
   */
  addVersion(curveId: string, segments: Segment[]): CurveVersion {
    const curve = this.requirePersisted(curveId);
    const next: CurveVersion = {
      version: curve.versions.length + 1,
      parentVersion: curve.versions[curve.versions.length - 1].version,
      segments: structuredClone(segments),
      createdAt: new Date().toISOString(),
    };
    curve.versions.push(next);
    this.store.save(curve);
    return structuredClone(next);
  }

  /** 取已持久化的核算结果；未核算返回 null */
  getComputation(curveId: string, version: number): ComputationRecord | null {
    const curve = this.requirePersisted(curveId);
    this.requireVersion(curve, version);
    const comp = curve.computations[version];
    return comp ? structuredClone(comp) : null;
  }

  /**
   * 对某个版本发起核算（幂等：已核算则原样返回当时那份结果）。
   *
   * 增量复用判定规则：
   * - 首版、或 forceFull、或父版本尚无核算结果 → 从空系统完整核算
   *   （mode='full'，firstRecomputedIndex=0）；
   * - 否则把本版时段表与父版时段表逐段比对（时长或到达率出现差异的最小
   *   下标 k，末尾追加段也视为差异），父版核算结果的第 0..k-1 段原样
   *   复用（reused=true），从第 k 段入口状态接着算；
   * - 判定依据只有“段自己及其之前的段”，任何段都不依赖后续时段，
   *   这是复用合法且能逐位复现的根本原因。
   */
  compute(
    curveId: string,
    version: number,
    options: { forceFull?: boolean } = {},
  ): ComputeResult {
    const curve = this.requirePersisted(curveId);
    const target = this.requireVersion(curve, version);

    const { forceFull = false } = options;

    // forceFull 是只读核对路径：无论是否已核算，都实时从头完整算一遍且不落盘
    if (forceFull) {
      const fixed: CurveFixedParams = { mu: curve.mu, capacity: curve.capacity };
      return {
        curve: this.asCurveRecord(curve),
        computation: runFullComputation(curve.id, fixed, curve.seed, target),
        alreadyComputed: false,
      };
    }

    const existing = curve.computations[version];
    if (existing) {
      return {
        curve: this.asCurveRecord(curve),
        computation: structuredClone(existing),
        alreadyComputed: true,
      };
    }

    const parentComp =
      target.parentVersion > 0
        ? curve.computations[target.parentVersion]
        : undefined;

    let firstRecomputed: number;
    if (!parentComp) {
      firstRecomputed = 0;
    } else {
      const parentVersion = this.requireVersion(curve, target.parentVersion);
      firstRecomputed = firstDifferentIndex(
        parentVersion.segments,
        target.segments,
      );
    }

    const fixed: CurveFixedParams = { mu: curve.mu, capacity: curve.capacity };
    const computation =
      firstRecomputed === 0
        ? runFullComputation(curve.id, fixed, curve.seed, target)
        : runIncremental(
            curve.id,
            fixed,
            curve.seed,
            target,
            parentComp!,
            firstRecomputed,
          );

    curve.computations[version] = computation;
    this.store.save(curve);

    return {
      curve: this.asCurveRecord(curve),
      computation: structuredClone(computation),
      alreadyComputed: false,
    };
  }

  private requirePersisted(curveId: string): PersistedCurve {
    const curve = this.store.load(curveId);
    if (!curve) {
      throw new NotFoundError(`曲线 ${curveId} 不存在`);
    }
    return curve;
  }

  private requireVersion(curve: PersistedCurve, version: number): CurveVersion {
    const found = curve.versions.find((v) => v.version === version);
    if (!found) {
      throw new NotFoundError(
        `曲线 ${curve.id} 不存在版本 ${version}（现有版本：${curve.versions
          .map((v) => v.version)
          .join(', ') || '无'}）`,
      );
    }
    return found;
  }

  private asCurveRecord(record: PersistedCurve): CurveRecord {
    const { computations: _computations, ...rest } = record;
    return structuredClone(rest);
  }
}

/**
 * 计算单个时段：瞬态解析 + 固定种子仿真 + 对照。
 * 纯函数：入口分布、仿真边界状态与本段参数完全决定输出，
 * 同进程调用两次、跨进程重启后调用，结果（含 double 位模式）一致。
 */
function computeSegment(
  fixed: CurveFixedParams,
  seed: number,
  index: number,
  seg: Segment,
  start: number,
  entryDistribution: number[],
  carry: CarryState,
  reused: boolean,
): {
  segment: ComputedSegment;
  endDistribution: number[];
  nextCarry: CarryState;
} {
  const { mu, capacity } = fixed;

  const analyticEvolution = evolveSegment({
    initial: entryDistribution,
    lambda: seg.lambda,
    mu,
    capacity,
    duration: seg.duration,
  });
  const m = averageMetrics(analyticEvolution.timeAveraged);
  const analytic: TransientAnalyticSegment = {
    index,
    duration: seg.duration,
    lambda: seg.lambda,
    timeAveragedBlockingProbability: m.blockingProbability,
    timeAveragedMeanNumberInSystem: m.meanNumberInSystem,
    timeAveragedMeanNumberWaiting: m.meanNumberWaiting,
    timeAveragedUtilization: m.utilization,
    endStateProbabilities: analyticEvolution.end,
  };

  const sim = runSegment({
    index,
    seed,
    start,
    end: start + seg.duration,
    lambda: seg.lambda,
    mu,
    capacity,
    carry,
  });

  const segment: ComputedSegment = {
    index,
    duration: seg.duration,
    lambda: seg.lambda,
    reused,
    analytic,
    simulation: {
      index,
      duration: seg.duration,
      lambda: seg.lambda,
      ...sim.result,
    },
    comparison: {
      blockingProbability: {
        analytic: m.blockingProbability,
        simulation: sim.result.blockingProbability,
        absoluteDifference: Math.abs(
          m.blockingProbability - sim.result.blockingProbability,
        ),
      },
      meanNumberInSystem: {
        analytic: m.meanNumberInSystem,
        simulation: sim.result.meanNumberInSystem,
        absoluteDifference: Math.abs(
          m.meanNumberInSystem - sim.result.meanNumberInSystem,
        ),
      },
      utilization: {
        analytic: m.utilization,
        simulation: sim.result.utilization,
        absoluteDifference: Math.abs(m.utilization - sim.result.utilization),
      },
    },
  };

  return {
    segment,
    endDistribution: analyticEvolution.end,
    nextCarry: sim.nextCarry,
  };
}

/** 第 index 段在全局仿真时钟上的起点（前缀时长之和） */
function segmentStart(segments: Segment[], index: number): number {
  let t = 0;
  for (let i = 0; i < index; i++) t += segments[i].duration;
  return t;
}

/**
 * 从空系统把某个版本完整核算一遍（不读、不写任何已存结果）。
 * 既是首版的计算路径，也是“增量结果必须等于完整重算”这条硬性要求的
 * 逐位比对基准。
 */
export function runFullComputation(
  curveId: string,
  fixed: CurveFixedParams,
  seed: number,
  target: CurveVersion,
): ComputationRecord {
  const segments = target.segments;
  const computedSegments: ComputedSegment[] = [];
  const boundaries: CarryState[] = [];

  // 瞬态解析入口：δ_0（系统为空）
  let entryDistribution = new Array<number>(fixed.capacity + 1).fill(0);
  entryDistribution[0] = 1;
  // 仿真入口：空系统（每段子流由 (seed, 段下标) 派生，第 0 段即 seed）
  let carry = initialCarry();

  let clock = 0;
  for (let i = 0; i < segments.length; i++) {
    const out = computeSegment(
      fixed,
      seed,
      i,
      segments[i],
      clock,
      entryDistribution,
      carry,
      false,
    );
    computedSegments.push(out.segment);
    boundaries.push(out.nextCarry);
    entryDistribution = out.endDistribution;
    carry = out.nextCarry;
    clock += segments[i].duration;
  }

  return {
    curveId,
    version: target.version,
    seed,
    rngAlgorithm: 'mulberry32',
    mode: 'full',
    firstRecomputedIndex: 0,
    computedAt: new Date().toISOString(),
    segments: computedSegments,
    boundaries,
  };
}

/**
 * 从第 firstRecomputed 段的入口状态续算，前缀直接复用父版核算结果。
 * 复用的段结果连同其段末边界状态一起深拷贝，double 位模式不变。
 */
export function runIncremental(
  curveId: string,
  fixed: CurveFixedParams,
  seed: number,
  target: CurveVersion,
  parentComp: ComputationRecord,
  firstRecomputed: number,
): ComputationRecord {
  const segments = target.segments;
  const reusedSegments: ComputedSegment[] = parentComp.segments
    .slice(0, firstRecomputed)
    .map((s) => structuredClone({ ...s, reused: true }));
  const boundaries: CarryState[] = parentComp.boundaries
    .slice(0, firstRecomputed)
    .map((b) => structuredClone(b));

  // 第 k 段入口 = 第 k-1 段段末；k=0 不可能走到这里（那是 full）
  let entryDistribution =
    reusedSegments[reusedSegments.length - 1].analytic.endStateProbabilities;
  let carry = boundaries[boundaries.length - 1];

  let clock = segmentStart(segments, firstRecomputed);
  for (let i = firstRecomputed; i < segments.length; i++) {
    const out = computeSegment(
      fixed,
      seed,
      i,
      segments[i],
      clock,
      entryDistribution,
      carry,
      false,
    );
    reusedSegments.push(out.segment);
    boundaries.push(out.nextCarry);
    entryDistribution = out.endDistribution;
    carry = out.nextCarry;
    clock += segments[i].duration;
  }

  return {
    curveId,
    version: target.version,
    seed,
    rngAlgorithm: 'mulberry32',
    mode: 'incremental',
    firstRecomputedIndex: firstRecomputed,
    computedAt: new Date().toISOString(),
    segments: reusedSegments,
    boundaries,
  };
}

/** 第一个出现差异（时长或到达率不等）的段下标；完全相同返回新表长度 */
export function firstDifferentIndex(
  oldSegments: Segment[],
  newSegments: Segment[],
): number {
  const n = Math.min(oldSegments.length, newSegments.length);
  for (let i = 0; i < n; i++) {
    if (
      oldSegments[i].duration !== newSegments[i].duration ||
      oldSegments[i].lambda !== newSegments[i].lambda
    ) {
      return i;
    }
  }
  // 前 n 段全等：若新表更长（末尾追加），差异从第 n 段开始；
  // 若两表等长则整表相同，差异点等于表长（全部可复用）
  return n;
}
