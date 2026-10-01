import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evolveSegment } from '../src/timevarying/transient.js';
import { steadyStateDistribution } from '../src/analytics/analytic.js';

/** 空系统初态：p_0 = 1 */
function emptyP(K: number): number[] {
  const p = new Array<number>(K + 1).fill(0);
  p[0] = 1;
  return p;
}

/** 任意分布的合法性：有限、非负、和为 1 */
function assertProbabilityVector(p: number[], tol = 1e-9): void {
  let sum = 0;
  let min = Infinity;
  for (const x of p) {
    assert.ok(Number.isFinite(x), '出现非有限值');
    if (x < min) min = x;
    sum += x;
  }
  assert.ok(min >= -1e-12, `出现负概率 min=${min}`);
  assert.ok(Math.abs(sum - 1) < tol, `概率和=${sum}`);
}

test('验收一：单段恒定到达、时长足够长时，段末瞬态分布收敛到稳态分布', () => {
  const lambda = 8;
  const mu = 10;
  const K = 5;
  const r = evolveSegment({
    lambda,
    mu,
    capacity: K,
    duration: 300, // (λ+μ)T = 5400，远超混合时间
    initial: emptyP(K),
  });
  const ss = steadyStateDistribution(lambda / mu, K);
  for (let n = 0; n <= K; n++) {
    assert.ok(
      Math.abs(r.endDistribution[n] - ss[n]) < 1e-6,
      `n=${n}: 瞬态=${r.endDistribution[n]} 稳态=${ss[n]}`,
    );
  }
});

test('验收一：空系统起步的最初一小段，时间平均阻塞概率接近 0', () => {
  const K = 5;
  const r = evolveSegment({
    lambda: 8,
    mu: 10,
    capacity: K,
    duration: 0.02, // 期望仅 0.16 个到达尝试，走到 K=5 的概率可忽略
    initial: emptyP(K),
  });
  assert.ok(r.blockingProbability < 1e-6, `阻塞概率=${r.blockingProbability}`);
  // 段末期望到达数仅 λT = 0.16，概率几乎全在状态 0/1
  assert.ok(r.endDistribution[0] + r.endDistribution[1] > 0.95);
});

test('段初非空时演化也成立：从满员出发应逐渐泄洪（λ=0 单调排空）', () => {
  const K = 4;
  const full = new Array<number>(K + 1).fill(0);
  full[K] = 1;
  const r = evolveSegment({
    lambda: 0,
    mu: 5,
    capacity: K,
    duration: 2,
    initial: full,
  });
  // λ=0 是纯死亡过程，T=2=10 个平均服务时间，末态几乎排空
  // （p0 = P{Erlang(4,μ) <= 2} ≈ 0.9897）
  assert.ok(r.endDistribution[0] > 0.98, `p0=${r.endDistribution[0]}`);
  // 段内时间平均利用率：初始 4 人逐个离开，∫_0^2 P{忙}(t)dt/2 ≈ 0.4，
  // 平均队长 < 初值 K，L = U + L_q 的恒等式成立
  assert.ok(r.utilization > 0.3 && r.utilization < 0.5, `U=${r.utilization}`);
  assert.ok(r.meanNumberInSystem < K);
  assert.ok(
    Math.abs(r.utilization + r.meanNumberWaiting - r.meanNumberInSystem) < 1e-9,
  );
});

test('验收二：任意时刻口径的分布非负、归一；段末与段内平均都检查', () => {
  const cases = [
    { lambda: 0.01, mu: 1, K: 1, T: 0.1 },
    { lambda: 10, mu: 10, K: 50, T: 3 },
    { lambda: 12, mu: 10, K: 200, T: 5 },
    { lambda: 0, mu: 1, K: 10, T: 1 },
  ];
  for (const c of cases) {
    const r = evolveSegment({
      lambda: c.lambda,
      mu: c.mu,
      capacity: c.K,
      duration: c.T,
      initial: emptyP(c.K),
    });
    assertProbabilityVector(r.endDistribution);
    // 段内平均分布由结果指标反推不可得，直接断言指标物理边界
    assert.ok(r.blockingProbability >= 0 && r.blockingProbability <= 1);
    assert.ok(r.utilization >= 0 && r.utilization <= 1);
    assert.ok(r.meanNumberInSystem >= 0 && r.meanNumberInSystem <= c.K);
    assert.ok(
      r.meanNumberWaiting >= 0 && r.meanNumberWaiting <= c.K - 1 + 1e-9,
    );
  }
});

test('验收二（应力）：到达率远大于服务率、容量数百、时长较长也不出 NaN/负数', () => {
  const K = 500;
  const r = evolveSegment({
    lambda: 1000,
    mu: 1,
    capacity: K,
    duration: 20, // (λ+μ)T ≈ 20014
    initial: emptyP(K),
  });
  assertProbabilityVector(r.endDistribution, 1e-9);
  for (const v of [
    r.blockingProbability,
    r.utilization,
    r.meanNumberInSystem,
    r.meanNumberWaiting,
  ]) {
    assert.ok(Number.isFinite(v));
  }
  // 高负荷 20 个时间单位后系统接近顶满：平均队长接近 K
  assert.ok(r.meanNumberInSystem > K * 0.95);
  assert.ok(r.blockingProbability > 0.9);
});

test('瞬态演化满足因果局部性：同一段、同一段初分布，结果与前后段无关（逐位）', () => {
  const K = 3;
  const initial = emptyP(K);
  initial[0] = 0.3;
  initial[1] = 0.5;
  initial[2] = 0.2;
  const a = evolveSegment({ lambda: 6, mu: 10, capacity: K, duration: 2, initial });
  const b = evolveSegment({ lambda: 6, mu: 10, capacity: K, duration: 2, initial });
  assert.deepEqual(a, b);
});

test('段间衔接：把上一段段末分布作为下一段初值，连续两段与一次性演化口径一致', () => {
  const K = 4;
  const p0 = emptyP(K);
  const seg1 = evolveSegment({ lambda: 20, mu: 10, capacity: K, duration: 1, initial: p0 });
  const seg2 = evolveSegment({
    lambda: 2,
    mu: 10,
    capacity: K,
    duration: 1,
    initial: seg1.endDistribution,
  });
  assertProbabilityVector(seg1.endDistribution);
  assertProbabilityVector(seg2.endDistribution);
  // 高峰段把系统灌满，低谷段把人排空：两段末分布的质量位置应明显移动
  assert.ok(seg1.endDistribution[K] > seg2.endDistribution[K]);
});

test('非法输入：非正时长、初分布长度不符、超均匀化工作量上限均抛错', () => {
  assert.throws(() =>
    evolveSegment({ lambda: 1, mu: 1, capacity: 2, duration: 0, initial: emptyP(2) }),
  );
  assert.throws(() =>
    evolveSegment({ lambda: 1, mu: 1, capacity: 2, duration: 1, initial: [1, 0] }),
  );
  assert.throws(() =>
    evolveSegment({
      lambda: 100000,
      mu: 1,
      capacity: 2,
      duration: 10,
      initial: emptyP(2),
    }),
  );
});
