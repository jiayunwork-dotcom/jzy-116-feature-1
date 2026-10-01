/**
 * 时变负荷曲线的分段离散事件仿真。
 *
 * 设计目标（最硬性的一条）：
 *   同一条曲线，用"每段独立调用本引擎、段间传 boundary"的方式顺序跑一遍，
 *   与"先跑前 k-1 段、存档、日后再从存档续跑后面的段"得到的结果逐位相同；
 *   并且首段从空系统开始、按时长停止时，与既有 runSimulation 的结果逐位相同。
 *
 * 逐位一致的三条约定（与 TIMEVARYING.md 对应）：
 *
 * 1. RNG 是一条不断的流。每个段边界保存 mulberry32 的 32 位内部 state；
 *    续跑用 Rng.fromState 恢复，而不是用种子重放。段内每次抽样的顺序、
 *    参数、次数与既有引擎完全一致（接纳空台到达先抽 departure 再抽下一个
 *    arrival；拒绝只抽下一个 arrival；离开后仍忙则抽下一个 departure）。
 *
 * 2. 段边界对"下一个到达"的统一处理：丢弃未发生的到达事件，按新段 λ 重新
 *    抽一个首到达（新段 λ=0 则不安排任何到达）。这对应分段常数的非齐次
 *    Poisson 到达过程——每段在边界处用新速率独立开启一条指数间隔。
 *    服务时间不重抽：μ 整条曲线恒定，跨界的那次 departure 原样带入下一段。
 *
 * 3. 段是半开区间 [start, end)：时刻恰等于段末的事件不在本段处理，留给
 *    下一段（departure 保留在事件表里跨界，arrival 按约定 2 重抽）。
 *
 * 段内时钟用相对本段起点的局部时间（首段即从 0 开始，与既有引擎一致）；
 * 存档时把事件时刻换算回绝对时间，恢复时再减去段初绝对时刻。增量与全量
 * 走的是完全相同的这组浮点运算，JSON 序列化又对 double 逐位保真，因此
 * 重启前后增量续算与从头整算结果逐位相同。
 */
import { Rng } from '../simulation/rng.js';
import { EventList } from '../simulation/event-list.js';
import { TimeWeightedAccumulator } from '../metrics/metrics.js';
import type {
  SimBoundaryState,
  SimulationSegmentResult,
} from './types.js';

export interface SegmentSimulationInput {
  /** 本段到达率（可为 0） */
  lambda: number;
  /** 整条曲线固定的服务率 */
  mu: number;
  /** 系统总容量 K */
  capacity: number;
  /** 本段时长 T */
  duration: number;
  /** 首段且从空系统开始时提供种子；提供了 boundary 时忽略 */
  seed: number;
  /** 上一段段末存档；null 表示曲线首段、系统从空开始 */
  boundary: SimBoundaryState | null;
}

export interface SegmentSimulationOutput {
  result: SimulationSegmentResult;
  /** 本段段末存档（供下一段增量续跑 / 持久化） */
  boundary: SimBoundaryState;
}

export function simulateSegment(
  input: SegmentSimulationInput,
): SegmentSimulationOutput {
  const { lambda, mu, capacity: k, duration: T } = input;

  let rng: Rng;
  let events: EventList;
  let current: number;
  /** 本段起点对应的绝对时钟（存档换算用） */
  let baseClock: number;

  if (input.boundary === null) {
    // 曲线首段：空系统、新 RNG、空事件表
    rng = new Rng(input.seed);
    events = new EventList();
    current = 0;
    baseClock = 0;
    if (lambda > 0) {
      events.push('arrival', rng.exponential(lambda));
    }
  } else {
    const b = input.boundary;
    rng = Rng.fromState(b.rngState);
    current = b.current;
    baseClock = b.clock;

    // 约定 2：未发生的到达一律丢弃；跨界 departure 的时刻换算成本段局部
    // 时间后保留（服务不重抽）。插入序号水位沿用存档，同时刻平局裁决不变。
    const remaining = b.eventsSnapshot.events
      .filter((ev) => ev.kind === 'departure')
      .map((ev) => ({ ...ev, time: ev.time - baseClock }));
    events = EventList.restore({
      events: remaining,
      counter: b.eventsSnapshot.counter,
    });
    if (lambda > 0) {
      events.push('arrival', rng.exponential(lambda));
    }
  }

  const stats = new TimeWeightedAccumulator();
  // 先立住段初状态：首段 observe(0,0) 不积累任何面积（0 乘任何 dt），
  // 与既有引擎"首个事件才开始记区间"在浮点上完全等价；续跑段则从段初
  // 状态 n 开始正确积累。
  stats.observe(0, current);

  let clock = 0; // 局部时间
  let arrivals = 0;
  let accepted = 0;
  let rejected = 0;

  for (;;) {
    const upcoming = events.peek();
    // 半开区间：最早事件已落在段末（含恰好相等）即停止本段
    if (!upcoming || upcoming.time >= T) {
      clock = T;
      break;
    }
    const event = events.pop() as NonNullable<ReturnType<EventList['peek']>>;
    clock = event.time;

    if (event.kind === 'arrival') {
      arrivals += 1;
      if (current === k) {
        rejected += 1;
      } else {
        accepted += 1;
        current += 1;
        stats.observe(clock, current);
        if (current === 1) {
          events.push('departure', clock + rng.exponential(mu));
        }
      }
      // 到达过程不受阻塞影响；λ=0 时本段不再有到达
      if (lambda > 0) {
        events.push('arrival', clock + rng.exponential(lambda));
      }
    } else {
      current -= 1;
      stats.observe(clock, current);
      if (current > 0) {
        events.push('departure', clock + rng.exponential(mu));
      }
    }
  }

  const averages = stats.settle(T);

  // ---- 段末存档：剥离未发生的 arrival，保留至多一个跨界 departure ------
  const finalSnapshot = events.snapshot();
  const keptEvents = finalSnapshot.events
    .filter((ev) => ev.kind === 'departure')
    .map((ev) => ({ ...ev, time: ev.time + baseClock })); // 换算回绝对时间
  const endSnapshot = {
    events: keptEvents,
    counter: finalSnapshot.counter,
  };

  const boundary: SimBoundaryState = {
    rngState: rng.internalState,
    current,
    clock: baseClock + T,
    pendingDeparture: keptEvents.length > 0 ? keptEvents[0].time : null,
    eventsSnapshot: endSnapshot,
    arrivals,
    accepted,
    rejected,
  };

  const result: SimulationSegmentResult = {
    totalArrivals: arrivals,
    accepted,
    rejected,
    blockingProbability: arrivals > 0 ? rejected / arrivals : 0,
    meanNumberInSystem: averages.meanNumberInSystem,
    meanNumberWaiting: averages.meanNumberWaiting,
    utilization: averages.utilization,
    duration: T,
  };

  return { result, boundary };
}
