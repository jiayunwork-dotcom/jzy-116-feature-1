/**
 * 负荷曲线与增量核算的领域服务。
 *
 * 版本规则：
 * - 登记曲线得到 curveId 与 version=1；mu、capacity 在曲线档案上固定；
 * - 每次提交一整份 segments 创建新版本，版本号 +1，旧版本永不覆盖；
 * - 核算按 (curveId, version, seed) 绑定，结果文件写入后不可变；
 *   同 key 重复发起直接返回当时那份结果。
 *
 * 增量复用判定：
 * - 只在同一曲线内、同一 seed 的已存档核算之间找复用（mu/capacity 天然一致）；
 * - 与候选版本的时段逐个比 (duration, lambda)，取“共享前缀长度 L”最大的；
 * - L 段的结果逐段原样拷贝（reused=true），从第 L 段起重算（reused=false），
 *   L=0 时整份从头算；
 * - 复用正确性的前提是因果局部性：每段输出只依赖本段参数与段初边界状态，
 *   不看后续时段。瞬态演化的初值取上一段段末分布；仿真的初值取上一段
 *   simBoundary。拷贝的段与其在完整重算中逐位相同（JSON 对 double 逐位
 *   保真，存档边界状态与内存对象位级一致），因此增量整份结果 = 完整重算。
 */
import { NotFoundError } from '../validation/validation.js';
import { evolveSegment } from './transient.js';
import { simulateSegment } from './segment-simulation.js';
import { JsonStore } from './store.js';
import type {
  ComputationRecord,
  ComputationSegmentRecord,
  CurveRecord,
  CurveSegment,
  CurveVersion,
  SimBoundaryState,
  TransientSegmentResult,
} from './types.js';

export interface VersionSpec {
  mu: number;
  capacity: number;
  segments: CurveSegment[];
}

/** 空系统的段初人数分布 */
function emptyDistribution(capacity: number): number[] {
  const p = new Array<number>(capacity + 1).fill(0);
  p[0] = 1;
  return p;
}

/** 计算单个时段（解析 + 仿真），reused 标记统一为 false */
function computeSegment(
  index: number,
  segment: CurveSegment,
  mu: number,
  capacity: number,
  seed: number,
  analyticInitial: number[],
  simBoundary: SimBoundaryState | null,
): ComputationSegmentRecord {
  const transient = evolveSegment({
    lambda: segment.lambda,
    mu,
    capacity,
    duration: segment.duration,
    initial: analyticInitial,
  });
  const analytic: TransientSegmentResult = {
    blockingProbability: transient.blockingProbability,
    meanNumberInSystem: transient.meanNumberInSystem,
    meanNumberWaiting: transient.meanNumberWaiting,
    utilization: transient.utilization,
    endDistribution: transient.endDistribution,
  };

  const sim = simulateSegment({
    lambda: segment.lambda,
    mu,
    capacity,
    duration: segment.duration,
    seed,
    boundary: simBoundary,
  });

  return {
    index,
    duration: segment.duration,
    lambda: segment.lambda,
    reused: false,
    analytic,
    simulation: sim.result,
    difference: {
      blockingProbability: Math.abs(
        analytic.blockingProbability - sim.result.blockingProbability,
      ),
      meanNumberInSystem: Math.abs(
        analytic.meanNumberInSystem - sim.result.meanNumberInSystem,
      ),
      utilization: Math.abs(analytic.utilization - sim.result.utilization),
    },
    simBoundary: sim.boundary,
  };
}

/**
 * 从空系统开始把一整版时段完整算一遍（不落盘）。
 * 增量路径与本函数共用 computeSegment，唯一区别只是前段从存档拷贝，
 * 因此两者结果必然逐位相同。
 */
export function computeVersionFull(
  spec: VersionSpec,
  seed: number,
): ComputationSegmentRecord[] {
  const { mu, capacity, segments } = spec;
  const records: ComputationSegmentRecord[] = [];
  let analyticInitial = emptyDistribution(capacity);
  let simBoundary: SimBoundaryState | null = null;

  for (let i = 0; i < segments.length; i++) {
    const record = computeSegment(
      i,
      segments[i],
      mu,
      capacity,
      seed,
      analyticInitial,
      simBoundary,
    );
    records.push(record);
    analyticInitial = record.analytic.endDistribution;
    simBoundary = record.simBoundary;
  }
  return records;
}

/** 两个版本的时段前缀是否在第 i 段一致（首段不同即 L=0） */
function segmentsEqual(a: CurveSegment, b: CurveSegment): boolean {
  return a.duration === b.duration && a.lambda === b.lambda;
}

export class CurveService {
  constructor(private readonly store: JsonStore) {}

  async registerCurve(input: {
    mu: number;
    capacity: number;
    segments: CurveSegment[];
    name?: string;
  }): Promise<CurveRecord> {
    const now = new Date().toISOString();
    const id = JsonStore.newCurveId();
    const version: CurveVersion = {
      version: 1,
      mu: input.mu,
      capacity: input.capacity,
      segments: input.segments.map((s) => ({ ...s })),
      name: input.name,
      createdAt: now,
    };
    const record: CurveRecord = {
      id,
      name: input.name,
      mu: input.mu,
      capacity: input.capacity,
      versions: [version],
      createdAt: now,
      updatedAt: now,
    };
    await this.store.saveCurve(record);
    return record;
  }

  async getCurve(curveId: string): Promise<CurveRecord> {
    const curve = await this.store.loadCurve(curveId);
    if (!curve) {
      throw new NotFoundError(`曲线 ${curveId} 不存在`, 'curveId');
    }
    return curve;
  }

  async listCurves() {
    return this.store.listCurves();
  }

  getVersion(curve: CurveRecord, version: number): CurveVersion {
    const v = curve.versions.find((x) => x.version === version);
    if (!v) {
      throw new NotFoundError(
        `曲线 ${curve.id} 不存在版本 ${version}（当前共 ${curve.versions.length} 版）`,
        'version',
      );
    }
    return v;
  }

  async createVersion(
    curveId: string,
    input: { segments: CurveSegment[]; name?: string },
  ): Promise<CurveRecord> {
    return this.store.withLock(curveId, async () => {
      const curve = await this.getCurve(curveId);
      const now = new Date().toISOString();
      const next: CurveVersion = {
        version: curve.versions.length + 1,
        mu: curve.mu,
        capacity: curve.capacity,
        segments: input.segments.map((s) => ({ ...s })),
        name: input.name,
        createdAt: now,
      };
      curve.versions.push(next);
      curve.updatedAt = now;
      if (input.name !== undefined) curve.name = input.name;
      await this.store.saveCurve(curve);
      return curve;
    });
  }

  /**
   * 对指定版本发起核算（增量复用）。
   * @returns 核算记录与是否新算（false 表示返回既有存档）
   */
  async runComputation(
    curveId: string,
    version: number,
    seed: number,
  ): Promise<{ record: ComputationRecord; created: boolean }> {
    return this.store.withLock(curveId, async () => {
      const curve = await this.getCurve(curveId);
      const target = this.getVersion(curve, version);

      const existing = await this.store.loadComputation(curveId, version, seed);
      if (existing) {
        return { record: existing, created: false };
      }

      // ---- 挑选共享前缀最长的同 seed 存档核算 --------------------------
      const candidates = await this.store.listComputations(curveId);
      let best: { record: ComputationRecord; prefix: number } | null = null;
      for (const cand of candidates) {
        if (cand.seed !== seed) continue;
        const candVersion = curve.versions.find(
          (v) => v.version === cand.version,
        );
        if (!candVersion) continue;
        let prefix = 0;
        const limit = Math.min(
          candVersion.segments.length,
          target.segments.length,
        );
        while (
          prefix < limit &&
          segmentsEqual(candVersion.segments[prefix], target.segments[prefix])
        ) {
          prefix++;
        }
        if (prefix > 0 && (best === null || prefix > best.prefix)) {
          best = { record: cand, prefix };
        }
      }

      const segmentRecords: ComputationSegmentRecord[] = [];
      let analyticInitial = emptyDistribution(curve.capacity);
      let simBoundary: SimBoundaryState | null = null;
      let firstRecomputed = 0;
      let reusedFrom: ComputationRecord['reusedFrom'] = null;

      if (best) {
        const prefix = best.prefix;
        firstRecomputed = prefix;
        reusedFrom = {
          curveId,
          version: best.record.version,
          seed,
        };
        for (let i = 0; i < prefix; i++) {
          const src = best.record.segments[i];
          // 原样拷贝（JSON 语义的纯数据），只把复用标记改成 true
          segmentRecords.push({ ...src, reused: true });
        }
        analyticInitial = best.record.segments[prefix - 1].analytic.endDistribution;
        simBoundary = best.record.segments[prefix - 1].simBoundary;
      }

      for (let i = firstRecomputed; i < target.segments.length; i++) {
        const record = computeSegment(
          i,
          target.segments[i],
          curve.mu,
          curve.capacity,
          seed,
          analyticInitial,
          simBoundary,
        );
        segmentRecords.push(record);
        analyticInitial = record.analytic.endDistribution;
        simBoundary = record.simBoundary;
      }

      const totalDuration = target.segments.reduce(
        (sum, s) => sum + s.duration,
        0,
      );
      const record: ComputationRecord = {
        id: `${curveId}-v${version}-s${seed}`,
        curveId,
        version,
        seed,
        rngAlgorithm: 'mulberry32',
        createdAt: new Date().toISOString(),
        reusedFrom,
        firstRecomputedIndex: firstRecomputed,
        segments: segmentRecords,
        totalDuration,
      };

      await this.store.saveComputation(record);
      return { record, created: true };
    });
  }

  async getComputation(
    curveId: string,
    version: number,
    seed: number,
  ): Promise<ComputationRecord> {
    // 先确认曲线与版本存在，给出 404 语义而不是笼统的“核算不存在”
    const curve = await this.getCurve(curveId);
    this.getVersion(curve, version);
    const record = await this.store.loadComputation(curveId, version, seed);
    if (!record) {
      throw new NotFoundError(
        `曲线 ${curveId} 版本 ${version} 尚无用 seed=${seed} 发起的核算`,
        'seed',
      );
    }
    return record;
  }

  async listComputations(curveId: string): Promise<ComputationRecord[]> {
    await this.getCurve(curveId);
    const records = await this.store.listComputations(curveId);
    records.sort((a, b) =>
      a.version === b.version ? a.seed - b.seed : a.version - b.version,
    );
    return records;
  }
}
