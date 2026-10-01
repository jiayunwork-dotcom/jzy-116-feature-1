import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runSimulation } from '../src/simulation/engine.js';
import { simulateSegment } from '../src/timevarying/segment-simulation.js';
import { evolveSegment } from '../src/timevarying/transient.js';
import type { SimBoundaryState } from '../src/timevarying/types.js';

/**
 * 验收三（最关键的逐位一致）：只有一段的曲线，首段从空系统按时长停止，
 * 与既有 /api/simulation 引擎对同一组 (lambda, mu, capacity, seed, T)
 * 的结果逐字段完全相等。
 */
test('验收三：单段首段仿真与既有 runSimulation(maxTime=T) 逐位一致', () => {
  const cases = [
    { lambda: 8, mu: 10, capacity: 4, T: 37.5, seed: 20240901 },
    { lambda: 0.01, mu: 5, capacity: 1, T: 12.25, seed: 7 },
    { lambda: 100, mu: 5, capacity: 2, T: 12.25, seed: 7 },
    { lambda: 3.3, mu: 5, capacity: 7, T: 12.25, seed: 7 },
    { lambda: 12, mu: 10, capacity: 30, T: 0.001, seed: 99 }, // 短到没有任何事件
  ];
  for (const c of cases) {
    const old = runSimulation({
      lambda: c.lambda,
      mu: c.mu,
      capacity: c.capacity,
      seed: c.seed,
      maxTime: c.T,
    });
    const seg = simulateSegment({
      lambda: c.lambda,
      mu: c.mu,
      capacity: c.capacity,
      duration: c.T,
      seed: c.seed,
      boundary: null,
    });
    assert.equal(seg.result.totalArrivals, old.totalArrivals, `${JSON.stringify(c)} 到达数`);
    assert.equal(seg.result.accepted, old.accepted, '接纳数');
    assert.equal(seg.result.rejected, old.rejected, '拒绝数');
    assert.equal(seg.result.blockingProbability, old.blockingProbability, '阻塞比例');
    assert.equal(seg.result.meanNumberInSystem, old.meanNumberInSystem, '平均队长');
    assert.equal(seg.result.meanNumberWaiting, old.meanNumberWaiting, '等待人数');
    assert.equal(seg.result.utilization, old.utilization, '利用率');
    assert.equal(seg.result.duration, old.endTime, '时长口径');
  }
});

test('满员即丢弃语义在分段引擎中保持：accepted + rejected = 到达尝试', () => {
  const seg = simulateSegment({
    lambda: 200,
    mu: 1,
    capacity: 3,
    duration: 50,
    seed: 11,
    boundary: null,
  });
  assert.equal(
    seg.result.accepted + seg.result.rejected,
    seg.result.totalArrivals,
  );
  assert.ok(seg.result.rejected > 0);
});

test('λ=0 的时段没有任何到达事件，系统状态只减不增', () => {
  // 手工构造一个非空段初边界
  const first = simulateSegment({
    lambda: 50,
    mu: 1,
    capacity: 5,
    duration: 20,
    seed: 3,
    boundary: null,
  });
  assert.ok(first.boundary.current > 0, '前置高峰段应留下积压');
  const idle = simulateSegment({
    lambda: 0,
    mu: 1,
    capacity: 5,
    duration: 5,
    seed: 3,
    boundary: first.boundary,
  });
  assert.equal(idle.result.totalArrivals, 0);
  assert.equal(idle.result.rejected, 0);
  assert.ok(idle.boundary.current <= first.boundary.current);
  assert.equal(idle.boundary.eventsSnapshot.events.length, idle.boundary.current > 0 ? 1 : 0);
});

/**
 * 分段顺序跑的恒等性：把 N 段依次调用、边界逐段传递，与“每段独立从空
 * 开始”不同，但必须与同一份存档恢复后续跑完全一致（模拟增量场景）。
 */
test('段边界存档恢复后续跑，与不存档顺序跑逐位一致（仿真侧因果局部性）', () => {
  const mu = 10;
  const capacity = 6;
  const seed = 42;
  const segments = [
    { duration: 5, lambda: 8 },
    { duration: 3, lambda: 20 },
    { duration: 8, lambda: 2 },
    { duration: 4, lambda: 12 },
  ];

  // 顺序跑全部
  const sequential: SimBoundaryState[] = [];
  let b: SimBoundaryState | null = null;
  const seqResults = segments.map((s) => {
    const out = simulateSegment({ ...s, mu, capacity, seed, boundary: b });
    b = out.boundary;
    sequential.push(out.boundary);
    return out.result;
  });

  // 增量：只跑到段 1（下标），用其存档（经 JSON 往返，模拟落盘重启）
  // 续跑段 2、3
  const stored: SimBoundaryState = JSON.parse(JSON.stringify(sequential[1]));
  let boundary: SimBoundaryState = stored;
  for (let i = 2; i < segments.length; i++) {
    const out = simulateSegment({
      ...segments[i],
      mu,
      capacity,
      seed,
      boundary,
    });
    assert.deepEqual(out.result, seqResults[i], `段 ${i} 结果逐位一致`);
    assert.deepEqual(out.boundary, sequential[i], `段 ${i} 边界逐位一致`);
    boundary = out.boundary;
  }
});

test('段边界约定：未发生的到达不跨界（按新段 λ 重抽），departure 跨界保留', () => {
  // 极短高峰段：极可能段末仍有积压且有跨界 departure
  const first = simulateSegment({
    lambda: 30,
    mu: 1,
    capacity: 10,
    duration: 0.5,
    seed: 5,
    boundary: null,
  });
  if (first.boundary.current > 0) {
    assert.equal(first.boundary.pendingDeparture !== null, true);
    assert.equal(first.boundary.eventsSnapshot.events.length, 1);
    assert.equal(first.boundary.eventsSnapshot.events[0].kind, 'departure');
    // 存档事件时刻是绝对时间（= 段末之后）
    assert.ok(first.boundary.eventsSnapshot.events[0].time >= 0.5);
  }
  // 存档中绝无 arrival
  for (const ev of first.boundary.eventsSnapshot.events) {
    assert.equal(ev.kind, 'departure');
  }
});

test('同一参数两次运行结果逐位一致', () => {
  const input = { lambda: 9, mu: 10, capacity: 5, duration: 30, seed: 123, boundary: null };
  assert.deepEqual(simulateSegment(input).result, simulateSegment(input).result);
});

/**
 * 验收四（多组参数、固定种子）：先短段预热到准稳态，再跑一段足够长的
 * 时段，该段经验阻塞比例、平均队长、利用率与同口径瞬态时间平均值的差
 * 落在容差内。容差依据样本量（T=1000 约数千~上万个到达尝试）下固定
 * 种子的经验偏差给出，已在 TIMEVARYING.md 写明。
 */
test('验收四：足够长时段的经验值与瞬态解析值一致（多组参数）', () => {
  const cases = [
    { lambda: 8, mu: 10, capacity: 8 },
    { lambda: 6, mu: 10, capacity: 6 },
    { lambda: 20, mu: 10, capacity: 20 },
  ];
  for (const c of cases) {
    for (const seed of [20240901, 777]) {
      // 预热段（40 时间单位）：解析与仿真各自把状态推进到准稳态
      const warmSim = simulateSegment({
        lambda: c.lambda, mu: c.mu, capacity: c.capacity,
        duration: 40, seed, boundary: null,
      });
      const empty = new Array<number>(c.capacity + 1).fill(0);
      empty[0] = 1;
      const warmAn = evolveSegment({
        lambda: c.lambda, mu: c.mu, capacity: c.capacity,
        duration: 40, initial: empty,
      });

      const T = 1000;
      const seg = simulateSegment({
        lambda: c.lambda, mu: c.mu, capacity: c.capacity,
        duration: T, seed, boundary: warmSim.boundary,
      });
      const an = evolveSegment({
        lambda: c.lambda, mu: c.mu, capacity: c.capacity,
        duration: T, initial: warmAn.endDistribution,
      });

      assert.ok(
        Math.abs(seg.result.blockingProbability - an.blockingProbability) < 0.05,
        `${JSON.stringify(c)} seed=${seed} 阻塞差`,
      );
      assert.ok(
        Math.abs(seg.result.meanNumberInSystem - an.meanNumberInSystem) < 0.3,
        `${JSON.stringify(c)} seed=${seed} 队长差`,
      );
      assert.ok(
        Math.abs(seg.result.utilization - an.utilization) < 0.05,
        `${JSON.stringify(c)} seed=${seed} 利用率差`,
      );
    }
  }
});
