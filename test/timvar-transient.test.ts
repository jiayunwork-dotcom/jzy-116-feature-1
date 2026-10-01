import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  evolveSegment,
  averageMetrics,
  steadyState,
} from '../src/timvar/transient.js';
import { analyzeQueue } from '../src/analytics/analytic.js';

/** δ_0：系统为空的入口分布 */
function emptyInitial(K: number): number[] {
  const p = new Array<number>(K + 1).fill(0);
  p[0] = 1;
  return p;
}

function assertIsDistribution(p: number[], tol = 1e-9) {
  let sum = 0;
  for (const x of p) {
    assert.ok(Number.isFinite(x), '概率必须有限（无 NaN/Infinity）');
    assert.ok(x >= -1e-12, `概率不能为显著负数：${x}`);
    sum += x;
  }
  assert.ok(Math.abs(sum - 1) <= tol, `概率和应为 1，实际 ${sum}`);
}

test('验收一：单段长时长、到达率不变，段末瞬态分布与稳态解析接口落在容差内', () => {
  const cases = [
    { lambda: 8, mu: 10, K: 4, d: 2000 },
    { lambda: 10, mu: 10, K: 6, d: 2000 },
    { lambda: 12, mu: 10, K: 8, d: 3000 },
  ];
  for (const { lambda, mu, K: capacity, d } of cases) {
    const { end } = evolveSegment({
      initial: emptyInitial(capacity),
      lambda,
      mu,
      capacity,
      duration: d,
    });
    const steady = analyzeQueue({ lambda, mu, capacity }).stateProbabilities;
    let maxDiff = 0;
    for (let n = 0; n <= capacity; n++) {
      maxDiff = Math.max(maxDiff, Math.abs(end[n] - steady[n]));
    }
    assert.ok(
      maxDiff < 1e-7,
      `λ=${lambda} μ=${mu} 段末与稳态最大偏差 ${maxDiff}`,
    );
    // 长时段的时间平均分布同样应贴近稳态（时间平均含一小段爬坡，
    // 容差比段末略宽；段末只反映“到没到”，时间平均还带着爬坡期）
    const avg = evolveSegment({
      initial: emptyInitial(capacity),
      lambda,
      mu,
      capacity,
      duration: d,
    }).timeAveraged;
    let avgDiff = 0;
    for (let n = 0; n <= capacity; n++) {
      avgDiff = Math.max(avgDiff, Math.abs(avg[n] - steady[n]));
    }
    assert.ok(avgDiff < 1e-3, `时间平均与稳态偏差 ${avgDiff}`);
  }
});

test('验收一：空系统起步，最初一小段时间内的时间平均阻塞概率接近零', () => {
  // 即便到达率极高，系统从空填满到 K 需要时间，极短窗口里几乎不可能满员
  const cases = [
    { lambda: 100, mu: 1, K: 5, d: 0.001 },
    { lambda: 50, mu: 10, K: 20, d: 0.005 },
    { lambda: 8, mu: 10, K: 4, d: 0.01 },
  ];
  for (const { lambda, mu, K, d } of cases) {
    const { timeAveraged } = evolveSegment({
      initial: emptyInitial(K),
      lambda,
      mu,
      capacity: K,
      duration: d,
    });
    const pb = averageMetrics(timeAveraged).blockingProbability;
    assert.ok(pb < 1e-6, `λ=${lambda} d=${d} 起步阻塞概率应≈0，实际 ${pb}`);
  }
});

test('阻塞概率随时间单调上升并趋近稳态（从空系统起步）', () => {
  const lambda = 8, mu = 10, K = 4;
  const steadyPb = analyzeQueue({ lambda, mu, capacity: K })
    .blockingProbability;
  let dist = emptyInitial(K);
  let prevEndPb = 0;
  let lastTime = 0;
  const checkpoints = [0.02, 0.1, 0.5, 2, 10, 60];
  for (const t of checkpoints) {
    const { end } = evolveSegment({
      initial: dist,
      lambda,
      mu,
      capacity: K,
      duration: t - lastTime,
    });
    assert.ok(
      end[K] >= prevEndPb - 1e-12,
      `t=${t} 段末阻塞概率应非降：${end[K]} < ${prevEndPb}`,
    );
    prevEndPb = end[K];
    dist = end;
    lastTime = t;
  }
  assert.ok(Math.abs(prevEndPb - steadyPb) < 1e-6);
});

test('验收二：任意段末/时间平均分布非负且归一（常规参数）', () => {
  const grid: Array<[number, number, number, number]> = [
    [1, 10, 5, 3],
    [8, 10, 4, 20],
    [10, 10, 7, 15],
    [20, 10, 10, 8],
    [0, 10, 6, 12], // λ=0：只出不进
  ];
  for (const [lambda, mu, K, d] of grid) {
    const { end, timeAveraged } = evolveSegment({
      initial: emptyInitial(K),
      lambda,
      mu,
      capacity: K,
      duration: d,
    });
    assertIsDistribution(end);
    assertIsDistribution(timeAveraged);
  }
});

test('验收二：到达率远大于服务率、容量数百也无 NaN/负数且归一', () => {
  const cases = [
    { lambda: 5000, mu: 1, K: 500, d: 5 },
    { lambda: 10000, mu: 1, K: 800, d: 2 },
    { lambda: 10000, mu: 10000, K: 700, d: 1 },
    { lambda: 0, mu: 1, K: 500, d: 5 },
  ];
  for (const { lambda, mu, K, d } of cases) {
    const { end, timeAveraged } = evolveSegment({
      initial: emptyInitial(K),
      lambda,
      mu,
      capacity: K,
      duration: d,
    });
    assertIsDistribution(end, 1e-8);
    assertIsDistribution(timeAveraged, 1e-8);
    const metrics = averageMetrics(end);
    assert.ok(Number.isFinite(metrics.meanNumberInSystem));
    assert.ok(metrics.utilization >= 0 && metrics.utilization <= 1 + 1e-9);
    assert.ok(metrics.blockingProbability >= 0 && metrics.blockingProbability <= 1 + 1e-9);
  }
});

test('λ=0 时段：分布质量只向低状态移动，平均队长只降不升', () => {
  const K = 6;
  // 从一个非空入口出发（手工构造合法分布）
  const initial = new Array<number>(K + 1).fill(0);
  initial[4] = 0.5;
  initial[5] = 0.5;
  const { end, timeAveraged } = evolveSegment({
    initial,
    lambda: 0,
    mu: 2,
    capacity: K,
    duration: 10,
  });
  assertIsDistribution(end);
  const mEnd = averageMetrics(end);
  const mInit = averageMetrics(initial);
  assert.ok(mEnd.meanNumberInSystem < mInit.meanNumberInSystem);
  // 足够长时间后几乎排空
  assert.ok(end[0] > 0.9, `无到达长时段应基本排空，p0=${end[0]}`);
  assertIsDistribution(timeAveraged);
});

test('段间连续：前一段段末分布作为后一段入口，分布严格承接（不归零）', () => {
  const K = 5;
  const seg1 = evolveSegment({
    initial: emptyInitial(K),
    lambda: 20,
    mu: 1,
    capacity: K,
    duration: 2,
  });
  // 高峰段结束时系统应已明显积压，p0 远小于 1
  assert.ok(seg1.end[0] < 0.1);
  // 下一段以 seg1.end 为入口（而不是重新 δ_0）：短 λ=0 段的时间平均
  // 队长应显著高于从空系统起跑
  const fromBacklog = evolveSegment({
    initial: seg1.end,
    lambda: 0,
    mu: 1,
    capacity: K,
    duration: 0.5,
  });
  const fromEmpty = evolveSegment({
    initial: emptyInitial(K),
    lambda: 0,
    mu: 1,
    capacity: K,
    duration: 0.5,
  });
  assert.ok(
    averageMetrics(fromBacklog.timeAveraged).meanNumberInSystem >
      averageMetrics(fromEmpty.timeAveraged).meanNumberInSystem,
  );
});

test('纯函数性：同一入口与参数两次求解逐位一致（增量复用的解析侧保证）', () => {
  const initial = emptyInitial(20);
  initial[0] = 0.3;
  initial[10] = 0.7;
  const a = evolveSegment({ initial, lambda: 13, mu: 7, capacity: 20, duration: 3.33 });
  const b = evolveSegment({ initial, lambda: 13, mu: 7, capacity: 20, duration: 3.33 });
  assert.deepEqual(a, b);
});

test('稳态参考：steadyState 与老解析接口一致（ρ<1、=1、>1、λ=0、μ=0）', () => {
  for (const [lambda, mu, K] of [
    [8, 10, 6],
    [10, 10, 6],
    [12, 10, 6],
  ] as const) {
    const mine = steadyState(lambda, mu, K);
    const ref = analyzeQueue({ lambda, mu, capacity: K }).stateProbabilities;
    for (let n = 0; n <= K; n++) {
      assert.ok(Math.abs(mine[n] - ref[n]) < 1e-12);
    }
  }
  // λ=0：稳态空系统
  const empty = steadyState(0, 3, 5);
  assert.ok(Math.abs(empty[0] - 1) < 1e-12);
  // μ=0、λ>0：质量堆在 K
  const full = steadyState(3, 0, 5);
  assert.ok(Math.abs(full[5] - 1) < 1e-12);
});

test('利用率=1-时间平均p0，阻塞=时间平均pK（口径锁定）', () => {
  const K = 6;
  const { timeAveraged } = evolveSegment({
    initial: emptyInitial(K),
    lambda: 9,
    mu: 11,
    capacity: K,
    duration: 4,
  });
  const m = averageMetrics(timeAveraged);
  assert.ok(Math.abs(m.utilization - (1 - timeAveraged[0])) < 1e-14);
  assert.ok(Math.abs(m.blockingProbability - timeAveraged[K]) < 1e-14);
});
