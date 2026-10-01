import { ValidationError } from '../validation/validation.js';
import type {
  AddVersionInput,
  RegisterCurveInput,
  SegmentInput,
} from './types.js';

/**
 * 时变负荷能力的输入校验。
 *
 * 容量上限刻意比老接口（100_000）收得更紧：时变瞬态要传播整条 K+1 维
 * 概率分布，成本随 K 线性增长；仿真在 λ≫μ 的拥塞段里也会跑出极多事件。
 * 上限的取值理由详见 docs/time-varying.md。
 */
export const TIMVAR_LIMITS = {
  /** 一条曲线（一个版本）允许的最小时段数 */
  MIN_SEGMENTS: 1,
  /** 一条曲线（一个版本）允许的最大时段数 */
  MAX_SEGMENTS: 64,
  /** 单段时长上限（时间单位） */
  MAX_SEGMENT_DURATION: 1_000,
  /** 曲线总时长上限（时间单位），防止 λ 大时事件数失控 */
  MAX_TOTAL_DURATION: 10_000,
  /** 容量 K 上限（含正在服务的顾客） */
  MAX_CAPACITY: 1_000,
  /** 到达率 / 服务率上限 */
  MAX_RATE: 10_000,
  /** 种子上限 2^32-1 */
  MAX_SEED: 0xffffffff,
} as const;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** 字段级校验失败：除 message 外带上字段说明，供调用方定位是哪个参数 */
export class TimvarValidationError extends ValidationError {
  readonly fields: Record<string, string>;
  constructor(fields: Record<string, string>) {
    const message = Object.entries(fields)
      .map(([field, reason]) => `${field}: ${reason}`)
      .join('；');
    super(message);
    this.name = 'TimvarValidationError';
    this.fields = { ...fields };
  }
}

function validateSegment(raw: unknown, index: number): SegmentInput {
  const field = (name: string) => `segments[${index}].${name}`;
  if (typeof raw !== 'object' || raw === null) {
    throw new TimvarValidationError({
      [`segments[${index}]`]: '时段必须是对象',
    });
  }
  const seg = raw as Record<string, unknown>;
  const fields: Record<string, string> = {};

  if (!isFiniteNumber(seg.duration)) {
    fields[field('duration')] = '时长必须是有限数';
  } else if (seg.duration <= 0) {
    fields[field('duration')] = '时段时长必须为正数';
  } else if (seg.duration > TIMVAR_LIMITS.MAX_SEGMENT_DURATION) {
    fields[field('duration')] =
      `时段时长不能超过 ${TIMVAR_LIMITS.MAX_SEGMENT_DURATION}`;
  }

  if (!isFiniteNumber(seg.lambda)) {
    fields[field('lambda')] = '到达率必须是有限数';
  } else if (seg.lambda < 0) {
    fields[field('lambda')] = '到达率不能为负（允许为 0，表示该时段无到达）';
  } else if (seg.lambda > TIMVAR_LIMITS.MAX_RATE) {
    fields[field('lambda')] =
      `到达率不能超过 ${TIMVAR_LIMITS.MAX_RATE}`;
  }

  if (Object.keys(fields).length > 0) {
    throw new TimvarValidationError(fields);
  }
  return { duration: seg.duration as number, lambda: seg.lambda as number };
}

function validateSegments(raw: unknown): SegmentInput[] {
  if (!Array.isArray(raw)) {
    throw new TimvarValidationError({ segments: '时段表必须是数组' });
  }
  if (raw.length < TIMVAR_LIMITS.MIN_SEGMENTS) {
    throw new TimvarValidationError({
      segments: `至少包含 ${TIMVAR_LIMITS.MIN_SEGMENTS} 个时段`,
    });
  }
  if (raw.length > TIMVAR_LIMITS.MAX_SEGMENTS) {
    throw new TimvarValidationError({
      segments: `时段数不能超过 ${TIMVAR_LIMITS.MAX_SEGMENTS}`,
    });
  }
  const segments = raw.map((seg, i) => validateSegment(seg, i));

  let total = 0;
  for (const seg of segments) total += seg.duration;
  if (total > TIMVAR_LIMITS.MAX_TOTAL_DURATION) {
    throw new TimvarValidationError({
      segments:
        `曲线总时长不能超过 ${TIMVAR_LIMITS.MAX_TOTAL_DURATION}（当前 ${total}）`,
    });
  }
  return segments;
}

function validateMu(raw: unknown): number {
  if (!isFiniteNumber(raw) || (raw as number) <= 0) {
    throw new TimvarValidationError({ mu: '服务率必须为正数' });
  }
  if ((raw as number) > TIMVAR_LIMITS.MAX_RATE) {
    throw new TimvarValidationError({
      mu: `服务率不能超过 ${TIMVAR_LIMITS.MAX_RATE}`,
    });
  }
  return raw as number;
}

function validateCapacity(raw: unknown): number {
  if (!isFiniteNumber(raw) || !Number.isInteger(raw) || (raw as number) <= 0) {
    throw new TimvarValidationError({
      capacity: '系统总容量必须为正整数',
    });
  }
  if ((raw as number) > TIMVAR_LIMITS.MAX_CAPACITY) {
    throw new TimvarValidationError({
      capacity: `容量不能超过 ${TIMVAR_LIMITS.MAX_CAPACITY}`,
    });
  }
  return raw as number;
}

function validateSeed(raw: unknown): number {
  if (raw === undefined) return 1;
  if (
    !isFiniteNumber(raw) ||
    !Number.isInteger(raw) ||
    (raw as number) < 0 ||
    (raw as number) > TIMVAR_LIMITS.MAX_SEED
  ) {
    throw new TimvarValidationError({
      seed: `种子必须是 [0, ${TIMVAR_LIMITS.MAX_SEED}] 内的整数`,
    });
  }
  return raw as number;
}

/** 校验登记曲线请求；缺省种子已在这里落实为 1，返回值中 seed 必有 */
export function parseRegisterInput(
  body: Record<string, unknown>,
): RegisterCurveInput & { seed: number; name?: string } {
  if (typeof body !== 'object' || body === null) {
    throw new TimvarValidationError({ body: '请求体必须是对象' });
  }
  const mu = validateMu(body.mu);
  const capacity = validateCapacity(body.capacity);
  const seed = validateSeed(body.seed);
  const segments = validateSegments(body.segments);
  let name: string | undefined;
  if (body.name !== undefined) {
    if (typeof body.name !== 'string') {
      throw new TimvarValidationError({ name: '曲线名称必须是字符串' });
    }
    name = body.name;
  }
  return { mu, capacity, seed, segments, name };
}

/** 校验新增版本请求（μ、K、seed 属于曲线，版本提交里不允许改） */
export function parseAddVersionInput(
  body: Record<string, unknown>,
): AddVersionInput {
  if (typeof body !== 'object' || body === null) {
    throw new TimvarValidationError({ body: '请求体必须是对象' });
  }
  if ('mu' in body || 'capacity' in body || 'seed' in body) {
    throw new TimvarValidationError({
      segments:
        '服务率、容量、种子在整条曲线上固定；新版本只能修改时段表（时长/到达率）',
    });
  }
  const segments = validateSegments(body.segments);
  return { segments };
}

/** 宽松的曲线 id 校验（避免奇怪路径/文件名） */
export function validateCurveId(raw: unknown): string {
  if (typeof raw !== 'string' || !/^[0-9a-f-]{8,64}$/i.test(raw)) {
    throw new TimvarValidationError({ curveId: '曲线 id 非法' });
  }
  return raw;
}

/** 版本号校验：正整数（NaN 也在此挡下，路由里 Number(undefined) 会产生 NaN） */
export function validateVersion(raw: unknown): number {
  if (
    !isFiniteNumber(raw) ||
    !Number.isInteger(raw) ||
    (raw as number) <= 0
  ) {
    throw new TimvarValidationError({ version: '版本号必须是正整数' });
  }
  return raw as number;
}
