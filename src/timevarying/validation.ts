/**
 * 时变负荷层的输入校验。规则与上限（同时写进 TIMEVARYING.md 与错误信息）：
 *
 * - 时段数 1..MAX_SEGMENTS（默认 200）；
 * - 单段时长 (0, MAX_SEGMENT_DURATION]（默认 1e6）；
 * - 容量为正整数且 <= MAX_CURVE_CAPACITY（500，瞬态按 K+1 维演化，
 *   再大时单次核算的 CPU 代价不划算；稳态老接口仍允许到 10 万）；
 * - 服务率 mu 为正数、<= MAX_RATE（1e4）；
 * - 每段到达率 lambda 为非负数、<= MAX_RATE（允许 0 = 该时段无到达）；
 * - 每段 (lambda+mu)*duration <= 均匀化上限（见 transient.ts，2e5）；
 * - seed 为 [0, 2^32-1] 内整数（缺省 1）。
 */
import { ValidationError } from '../validation/validation.js';
import type {
  CurveSegmentInput,
} from './types.js';
import { MAX_ALPHA_T } from './transient.js';

export const MAX_SEGMENTS = 200;
export const MAX_SEGMENT_DURATION = 1_000_000;
export const MAX_CURVE_CAPACITY = 500;
export const MAX_RATE = 10_000;
const MAX_SEED = 0xffffffff;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** 校验并归一化时段列表；返回逐段字段说明，便于错误响应指出具体字段 */
export function validateSegments(
  rawSegments: unknown,
  mu: number,
): CurveSegmentInput[] {
  if (!Array.isArray(rawSegments) || rawSegments.length === 0) {
    throw new ValidationError(
      `字段 segments：必须为非空数组，时段数在 1..${MAX_SEGMENTS} 之间`,
      'segments',
    );
  }
  if (rawSegments.length > MAX_SEGMENTS) {
    throw new ValidationError(
      `字段 segments：时段数 ${rawSegments.length} 超过上限 ${MAX_SEGMENTS}`,
      'segments',
    );
  }

  const segments: CurveSegmentInput[] = [];
  rawSegments.forEach((raw, i) => {
    const prefix = `segments[${i}]`;
    if (typeof raw !== 'object' || raw === null) {
      throw new ValidationError(`字段 ${prefix}：必须是对象 {duration, lambda}`, prefix);
    }
    const seg = raw as Record<string, unknown>;
    const { duration, lambda } = seg;

    if (!isFiniteNumber(duration) || duration <= 0) {
      throw new ValidationError(
        `字段 ${prefix}.duration：时段时长必须为正数`,
        `${prefix}.duration`,
      );
    }
    if (duration > MAX_SEGMENT_DURATION) {
      throw new ValidationError(
        `字段 ${prefix}.duration：单段时长不能超过 ${MAX_SEGMENT_DURATION}`,
        `${prefix}.duration`,
      );
    }
    if (!isFiniteNumber(lambda) || lambda < 0) {
      throw new ValidationError(
        `字段 ${prefix}.lambda：到达率必须为非负数（0 表示该时段无到达）`,
        `${prefix}.lambda`,
      );
    }
    if (lambda > MAX_RATE) {
      throw new ValidationError(
        `字段 ${prefix}.lambda：到达率不能超过 ${MAX_RATE}`,
        `${prefix}.lambda`,
      );
    }
    const workload = (lambda + mu) * duration;
    if (workload > MAX_ALPHA_T) {
      throw new ValidationError(
        `字段 ${prefix}：(lambda+mu)*duration = ${workload} 超过瞬态求解上限 ${MAX_ALPHA_T}，请缩短该段或降低速率`,
        prefix,
      );
    }
    segments.push({ duration, lambda });
  });

  return segments;
}

/** 校验登记曲线请求：mu、capacity 整条曲线固定 */
export function validateRegisterBody(body: Record<string, unknown>): {
  mu: number;
  capacity: number;
  segments: CurveSegmentInput[];
  name?: string;
} {
  const { mu, capacity, name } = body;

  if (!isFiniteNumber(mu) || mu <= 0) {
    throw new ValidationError('字段 mu：服务率必须为正数', 'mu');
  }
  if (mu > MAX_RATE) {
    throw new ValidationError(`字段 mu：服务率不能超过 ${MAX_RATE}`, 'mu');
  }
  if (!isFiniteNumber(capacity) || !Number.isInteger(capacity) || capacity <= 0) {
    throw new ValidationError(
      '字段 capacity：系统总容量必须为正整数',
      'capacity',
    );
  }
  if (capacity > MAX_CURVE_CAPACITY) {
    throw new ValidationError(
      `字段 capacity：负荷曲线容量上限为 ${MAX_CURVE_CAPACITY}`,
      'capacity',
    );
  }

  const segments = validateSegments(body.segments, mu);

  let resolvedName: string | undefined;
  if (name !== undefined) {
    if (typeof name !== 'string' || name.length === 0 || name.length > 100) {
      throw new ValidationError('字段 name：必须为 1..100 字符的字符串', 'name');
    }
    resolvedName = name;
  }

  return { mu, capacity, segments, name: resolvedName };
}

/** 校验新版本请求（mu/capacity 沿用曲线档案，不在请求里出现） */
export function validateVersionBody(
  body: Record<string, unknown>,
  mu: number,
): { segments: CurveSegmentInput[]; name?: string } {
  const segments = validateSegments(body.segments, mu);
  let resolvedName: string | undefined;
  if (body.name !== undefined) {
    if (typeof body.name !== 'string' || body.name.length === 0 || body.name.length > 100) {
      throw new ValidationError('字段 name：必须为 1..100 字符的字符串', 'name');
    }
    resolvedName = body.name;
  }
  return { segments, name: resolvedName };
}

/** 校验核算请求 */
export function validateComputationBody(body: Record<string, unknown>): {
  seed: number;
} {
  const { seed } = body;
  let resolvedSeed = 1;
  if (seed !== undefined) {
    if (!isFiniteNumber(seed) || !Number.isInteger(seed) || seed < 0 || seed > MAX_SEED) {
      throw new ValidationError(
        `字段 seed：必须为 [0, ${MAX_SEED}] 内的整数`,
        'seed',
      );
    }
    resolvedSeed = seed;
  }
  return { seed: resolvedSeed };
}

/** 路径参数中的曲线 id / 版本号校验 */
export function validateCurveId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(value)) {
    throw new ValidationError('curveId 格式非法（允许字母、数字、_、-，长度 1..64）', 'curveId');
  }
  return value;
}

export function validateVersionNumber(value: unknown): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new ValidationError('version 必须为正整数', 'version');
  }
  return n;
}

/** 路径参数中的 seed（允许 0，上限 2^32-1） */
export function validateSeedNumber(value: unknown): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > MAX_SEED) {
    throw new ValidationError(`seed 必须为 [0, ${MAX_SEED}] 内的整数`, 'seed');
  }
  return n;
}
