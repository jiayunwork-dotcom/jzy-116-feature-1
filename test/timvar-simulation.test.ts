import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  runSegment,
  initialCarry,
  seedForSegment,
  runWholeCurve,
} from '../src/timvar/segment-simulation.js';
import { runSimulation } from '../src/simulation/engine.js';
import { Rng } from '../src/simulation/rng.js';

/** 老仿真引擎结果中与分段仿真同口径的数值字段（endNumberInSystem 老接口没有） */
const SHARED_FIELDS = [
  'totalArrivals',
  'accepted',
  'rejected',
  'blockingProbability',
  'meanNumberInSystem',
  'meanNumberWaiting',
  'utilization',
  'effectiveArrivalRate',
] as const;

test('验收三：单段曲线分段仿真与老仿真接口 maxTime 停止的结果逐位一致', () => {
  const cases = [
    { lambda: 8, mu: 10, capacity: 4, seed: 20240901, duration: 40 },
    { lambda: 3, mu: 5, capacity: 1, seed: 1, duration: 12.5 },
    { lambda: 50, mu: 1, capacity: 2, seed: 7, duration: 30 },
    { lambda: 600, mu: 1000, capacity: 3, seed: 99, duration: 0.5 },
    { lambda: 2, mu: 10, capacity: 20, seed: 1234567, duration: 100 },
  ];
  for (const params of cases) {
    const old = runSimulation({
      lambda: params.lambda,
      mu: params.mu,
      capacity: params.capacity,
      seed: params.seed,
      maxTime: params.duration,
    });
    assert.equal(old.stopReason, 'maxTime');
    assert.equal(old.endTime, params.duration);

    const seg = runSegment({
      index: 0,
      seed: params.seed,
      start: 0,
      end: params.duration,
      lambda: params.lambda,
      mu: params.mu,
      capacity: params.capacity,
      carry: initialCarry(),
    });

    for (const field of SHARED_FIELDS) {
      assert.equal(
        seg.result[field],
        old[field],
        `${field} 不一致（参数 ${JSON.stringify(params)}）：seg=${seg.result[field]} old=${old[field]}`,
      );
    }
  }
});

test('seedForSegment：第 0 段恒等返回原种子；其余段确定性、可复现、不同段不同', () => {
  const seed = 20240901;
  assert.equal(seedForSegment(seed, 0), seed);
  const a = seedForSegment(seed, 1);
  assert.equal(a, seedForSegment(seed, 1));
  assert.equal(seedForSegment(seed, 2), seedForSegment(seed, 2));
  assert.notEqual(a, seedForSegment(seed, 2));
  assert.notEqual(a, seedForSegment(seed + 1, 1));
  // 落在 uint32
  for (let k = 0; k < 10; k++) {
    const s = seedForSegment(seed, k);
    assert.ok(Number.isInteger(s) && s >= 0 && s <= 0xffffffff);
  }
});

test('分段仿真跨段：accepted/rejected/totalArrivals 守恒，段末人数等于跨界状态', () => {
  const { segmentResults, carries } = runWholeCurve({
    mu: 10,
    capacity: 6,
    seed: 77,
    segments: [
      { duration: 5, lambda: 20 },
      { duration: 5, lambda: 2 },
      { duration: 5, lambda: 30 },
    ],
  });
  for (let i = 0; i < segmentResults.length; i++) {
    const r = segmentResults[i];
    assert.equal(r.accepted + r.rejected, r.totalArrivals);
    assert.equal(r.endNumberInSystem, carries[i].numberInSystem);
    assert.ok(r.utilization >= 0 && r.utilization <= 1 + 1e-12);
    assert.ok(r.blockingProbability >= 0 && r.blockingProbability <= 1 + 1e-12);
  }
  // 第 2 段（低到达）结束时积压应比第 1 段高峰结束时少
  assert.ok(
    carries[1].numberInSystem <= carries[0].numberInSystem,
  );
});

test('跨界在途离开：服务不被段边界打断，离开时刻是绝对时间且被下一段保留', () => {
  // 构造一个段末恰好有在途顾客的情形：高峰短段
  const first = runSegment({
    index: 0,
    seed: 5,
    start: 0,
    end: 2,
    lambda: 30,
    mu: 1,
    capacity: 10,
    carry: initialCarry(),
  });
  if (first.nextCarry.pendingDepartureTime !== null) {
    // 在途离开时刻必须落在第一段之后（跨界）
    assert.ok(first.nextCarry.pendingDepartureTime >= 2 - 1e-12);
    // 下一段以该 carry 起跑：同一 carry 再跑一次结果逐位一致
    const a = runSegment({
      index: 1, seed: 5, start: 2, end: 4, lambda: 1, mu: 1, capacity: 10,
      carry: first.nextCarry,
    });
    const b = runSegment({
      index: 1, seed: 5, start: 2, end: 4, lambda: 1, mu: 1, capacity: 10,
      carry: first.nextCarry,
    });
    assert.deepEqual(a.result, b.result);
    // 段末人数初值承接
    assert.ok(a.result.endNumberInSystem <= first.nextCarry.numberInSystem + 2);
  }
});

test('λ=0 时段没有到达事件：totalArrivals=0、阻塞比例定义为 0', () => {
  const first = runSegment({
    index: 0, seed: 9, start: 0, end: 1, lambda: 20, mu: 1, capacity: 5,
    carry: initialCarry(),
  });
  const quiet = runSegment({
    index: 1, seed: 9, start: 1, end: 6, lambda: 0, mu: 1, capacity: 5,
    carry: first.nextCarry,
  });
  assert.equal(quiet.result.totalArrivals, 0);
  assert.equal(quiet.result.rejected, 0);
  assert.equal(quiet.result.blockingProbability, 0);
  // 只出不进：人数单调不增
  assert.ok(quiet.result.endNumberInSystem <= first.nextCarry.numberInSystem);
});

test('同一种子重复核算整条曲线结果逐位一致', () => {
  const params = {
    mu: 4,
    capacity: 9,
    seed: 31337,
    segments: [
      { duration: 3, lambda: 2 },
      { duration: 2, lambda: 19 },
      { duration: 4, lambda: 5 },
    ],
  };
  assert.deepEqual(runWholeCurve(params), runWholeCurve(params));
});

test('分段子流彼此独立：第 k 段随机数只取决于 (seed, k)，与前缀 λ 无关', () => {
  const seed = 4242;
  // 子流种子函数是无状态的：(seed, k) 相同，mulberry32 的首个均匀数就相同，
  // 无论第 0 段历史上以什么 λ 跑过、消耗过多少随机数。
  const r1 = new Rng(seedForSegment(seed, 1)).next();
  const r1Again = new Rng(seedForSegment(seed, 1)).next();
  assert.equal(r1, r1Again);
  assert.notEqual(r1, new Rng(seedForSegment(seed, 0)).next());
  assert.notEqual(r1, new Rng(seedForSegment(seed, 2)).next());

  // 端到端：固定第 1 段入口跨界状态，无论“假想第 0 段 λ”是多少，
  // 第 1 段从同一种子子流起跑，结果逐位相同
  const carry = { numberInSystem: 3, pendingDepartureTime: 1.75 };
  const seg1 = runSegment({
    index: 1, seed, start: 1, end: 3, lambda: 8, mu: 10, capacity: 8, carry,
  }).result;
  for (const seg0Lambda of [2, 50, 0]) {
    // 跑完一个第 0 段（只是为了制造“历史”），再用固定 carry 起跑第 1 段
    runSegment({
      index: 0, seed, start: 0, end: 1, lambda: seg0Lambda, mu: 10, capacity: 8,
      carry: initialCarry(),
    });
    const again = runSegment({
      index: 1, seed, start: 1, end: 3, lambda: 8, mu: 10, capacity: 8, carry,
    }).result;
    assert.deepEqual(again, seg1, `第 0 段 λ=${seg0Lambda} 不应影响第 1 段随机数`);
  }
});
