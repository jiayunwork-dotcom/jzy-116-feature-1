import { Rng } from '../simulation/rng.js';
import { EventList } from '../simulation/event-list.js';
import { TimeWeightedAccumulator } from '../metrics/metrics.js';
import type { Segment, CarryState } from './types.js';

export type { CarryState };

/**
 * 跨时段连续的 M/M/1/K 离散事件仿真（分段推进版）。
 *
 * 与老仿真引擎 src/simulation/engine.ts 共用同一套模型语义和同一个
 * mulberry32 发生器，差异只在于：时间轴按负荷曲线的时段边界切开，
 * 每段用自己的到达率 λ_k，段间状态连续延续、绝不重新清零。
 *
 * 随机数流：每段一条确定性派生的独立子流（segment-seeded streams）。
 * - 第 k 段的 RNG 由 (曲线种子 seed, 段下标 k) 经 seedForSegment 派生，
 *   第 0 段直接用 seed 本身（因此单段曲线与老引擎 maxTime 停止的结果
 *   逐位相同）；
 * - 这是“改一段只重算该段之后，且增量结果与完整重算逐位一致”的关键：
 *   若所有段共用一条顺序消耗的随机数流，第 k 段 λ 一改，本段消耗的
 *   随机数个数就变（事件个数变），后面每一段拿到的随机数全部错位，
 *   前缀就无法复用；子流派生让“第 k 段抽到的随机数”只取决于
 *     (seed, k)，与任何前缀段的时长/到达率无关。
 * - 这不是人为重抽：分段常数速率的 NHPP 本来就是“每段一条互相独立的
 *   Poisson 到达流”，各段 Exp 间隔抽样彼此独立正是模型本身的语义；
 *   子流只是把“独立性”实现成了可寻址、可复现的形式。
 *
 * 段边界的处理规则（增量重算逐位一致的仿真侧基础）：
 *
 * 1. 跨界的“待处理到达”一律丢弃，下一段从边界时刻 t* 用本子流的
 *    第一个随机数抽 Exp(λ_{k+1}) 作为首个到达间隔。这不是近似：
 *    段内到达按定义就是速率 λ_k 的独立齐次 Poisson 过程，相邻段是
 *    两条互相独立的到达流，条件独立增量本来就不该跨界携带。
 * 2. “在途离开”必须跨界保留：服务不被时段边界打断，正在服务的顾客
 *    的离开时刻在它开工时就已抽定。单服务台保证任意时刻至多一个待处理
 *    离开，因此边界上只需存一个 pendingDepartureTime（绝对时刻）。
 *    这个离开时刻是在前一段的子流里抽出的，作为确定性的“状态”跨界
 *    传递，不需要重抽。
 * 3. 段 k+1 用全新的事件表开跑：先放入保留下来的离开（若有），再排
 *    本段第一个到达（用第 k+1 段子流的第一个随机数）。
 *
 * 同时刻平局裁决（EventList 的 seq）每段从 0 开始：跨界的两个事件在
 * 连续分布下相等的概率为 0，且完整重算与增量重算都走同一条重建路径，
 * 裁决顺序一致，故结果逐位相同。
 */

/**
 * 由曲线种子与段下标派生该段的 32 位子流种子。
 *
 * 第 0 段恒等返回 seed，保证“单段曲线 == 老引擎 maxTime”逐位一致；
 * k ≥ 1 用 splitmix32 风格的整数混合把 (seed, k) 搅成 uint32。
 * 纯整数运算、确定性、无状态，重启后算出同样的子流种子。
 */
export function seedForSegment(seed: number, index: number): number {
  if (index === 0) return seed >>> 0;
  let z = ((seed >>> 0) ^ Math.imul(index + 1, 0x9e3779b9)) >>> 0;
  z = (z + 0x9e3779b9) >>> 0;
  z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
  z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
  return (z ^ (z >>> 16)) >>> 0;
}

export interface SegmentSimInput {
  /** 段下标（用于派生子流种子） */
  index: number;
  /** 曲线级固定种子 */
  seed: number;
  /** 本段在全局仿真时钟上的起止时刻（绝对时间，end - start = duration） */
  start: number;
  end: number;
  /** 本段到达率 */
  lambda: number;
  /** 全曲线固定的服务率与容量 */
  mu: number;
  capacity: number;
  /**
   * 上一段末（= 本段初）跨界延续下来的物理状态：当前人数与在途离开
   * 时刻。随机数不在此续接——本段 RNG 由 (seed, index) 重新派生。
   */
  carry: CarryState;
}


export interface SegmentSimOutput {
  result: {
    totalArrivals: number;
    accepted: number;
    rejected: number;
    blockingProbability: number;
    meanNumberInSystem: number;
    meanNumberWaiting: number;
    utilization: number;
    effectiveArrivalRate: number;
    endNumberInSystem: number;
  };
  /** 段末跨界状态，交给下一段或持久化 */
  nextCarry: CarryState;
}

/** 首段入口：系统为空，没有在途离开 */
export function initialCarry(): CarryState {
  return { numberInSystem: 0, pendingDepartureTime: null };
}

/** 跑一个时段；纯函数：同样的入参（含跨界状态与段下标）必然产出同样的结果 */
export function runSegment(input: SegmentSimInput): SegmentSimOutput {
  const { index, seed, start, end, lambda, mu, capacity: k, carry } = input;

  const rng = new Rng(seedForSegment(seed, index));
  const events = new EventList();
  const stats = new TimeWeightedAccumulator();

  let current = carry.numberInSystem;
  let pendingDeparture = carry.pendingDepartureTime;
  let arrivals = 0;
  let accepted = 0;
  let rejected = 0;

  // 登记本段初态（含上一段跨界留下的在途顾客），区间 [start, 首个事件)
  // 里系统保持该人数，必须计入时间加权面积
  stats.start(start, current);

  // 上一段在途的离开事件先入表（seq 更小），再排本段第一个到达
  if (pendingDeparture !== null && current > 0) {
    events.push('departure', pendingDeparture);
  }
  events.push('arrival', start + rng.exponential(lambda));

  for (;;) {
    const event = events.pop();
    if (!event) break;

    // 与老引擎一致：时刻 >= 段末即停（边界上的到达不在本段处理）
    if (event.time >= end) {
      break;
    }

    const clock = event.time;

    if (event.kind === 'arrival') {
      arrivals += 1;
      if (current === k) {
        rejected += 1;
      } else {
        accepted += 1;
        current += 1;
        stats.observe(clock, current);
        if (current === 1) {
          pendingDeparture = clock + rng.exponential(mu);
          events.push('departure', pendingDeparture);
        }
      }
      // 到达流不因阻塞或边界改变：照常抽下一个到达（λ_k）；
      // 若它落在段末之后，段结束时随事件表一起丢弃（随机数已消耗在
      // 本段子流内，不影响别的段）
      events.push('arrival', clock + rng.exponential(lambda));
    } else {
      current -= 1;
      stats.observe(clock, current);
      if (current > 0) {
        pendingDeparture = clock + rng.exponential(mu);
        events.push('departure', pendingDeparture);
      } else {
        pendingDeparture = null;
      }
    }
  }

  const horizon = end;
  // 分段用全局绝对时钟，平均分母必须是本段时长 (end - start)
  const averages = stats.settle(horizon, start);

  return {
    result: {
      totalArrivals: arrivals,
      accepted,
      rejected,
      blockingProbability: arrivals > 0 ? rejected / arrivals : 0,
      ...averages,
      effectiveArrivalRate: horizon - start > 0 ? accepted / (horizon - start) : 0,
      endNumberInSystem: current,
    },
    nextCarry: {
      numberInSystem: current,
      pendingDepartureTime: current > 0 ? pendingDeparture : null,
    },
  };
}

/**
 * 从空系统开始把整条曲线顺序跑完——主要用于测试里的“完整重算”参照。
 * 返回每段结果与每段末跨界状态。
 */
export function runWholeCurve(params: {
  segments: Segment[];
  mu: number;
  capacity: number;
  seed: number;
}): {
  segmentResults: SegmentSimOutput['result'][];
  carries: CarryState[];
} {
  const { segments, mu, capacity, seed } = params;
  let carry = initialCarry();
  let clock = 0;
  const segmentResults = [];
  const carries: CarryState[] = [];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const start = clock;
    const end = clock + seg.duration;
    const out = runSegment({
      index: i,
      seed,
      start,
      end,
      lambda: seg.lambda,
      mu,
      capacity,
      carry,
    });
    segmentResults.push(out.result);
    carries.push(out.nextCarry);
    carry = out.nextCarry;
    clock = end;
  }
  return { segmentResults, carries };
}
