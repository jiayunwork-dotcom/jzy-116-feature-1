import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonCurveStore } from '../src/timvar/storage.js';
import {
  LoadCurveService,
  runFullComputation,
  firstDifferentIndex,
} from '../src/timvar/service.js';
import type {
  ComputationRecord,
  CurveRecord,
  Segment,
} from '../src/timvar/types.js';

function makeService(): { service: LoadCurveService; store: JsonCurveStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'timvar-'));
  const store = new JsonCurveStore(dir);
  return { service: new LoadCurveService(store), store, dir };
}

const SEGS_V1: Segment[] = [
  { duration: 10, lambda: 4 },
  { duration: 8, lambda: 25 },
  { duration: 12, lambda: 6 },
  { duration: 6, lambda: 18 },
  { duration: 9, lambda: 3 },
];

/** 剥掉 reused 标记后逐位比较两份核算（指标 + 跨界状态） */
function assertComputationsBitEqual(
  actual: ComputationRecord,
  expected: ComputationRecord,
) {
  const strip = (comps: ComputationRecord['segments']) =>
    comps.map(({ reused: _r, ...rest }) => rest);
  assert.equal(
    JSON.stringify(strip(actual.segments)),
    JSON.stringify(strip(expected.segments)),
    '解析+仿真分段结果（除 reused 标记外）必须逐位相同',
  );
  assert.equal(
    JSON.stringify(actual.boundaries),
    JSON.stringify(expected.boundaries),
    '段末跨界状态必须逐位相同',
  );
}

test('firstDifferentIndex：改中间段、末尾追加、完全相同、改首段', () => {
  const v1 = SEGS_V1;
  const changedMid = v1.map((s, i) => (i === 2 ? { ...s, lambda: 99 } : s));
  assert.equal(firstDifferentIndex(v1, changedMid), 2);

  const appended = [...v1, { duration: 5, lambda: 7 }];
  assert.equal(firstDifferentIndex(v1, appended), 5);

  const changedFirst = v1.map((s, i) => (i === 0 ? { ...s, duration: 11 } : s));
  assert.equal(firstDifferentIndex(v1, changedFirst), 0);

  assert.equal(firstDifferentIndex(v1, v1.map((s) => ({ ...s }))), v1.length);

  // 缩短（删段）也正确：删到第 4 段，新表是旧表前缀 → 差异点在新表长度
  const shortened = v1.slice(0, 3);
  assert.equal(firstDifferentIndex(v1, shortened), 3);
});

test('验收五：改中间段，增量结果与从头完整重算逐位一致，复用标记正确', () => {
  const { service, dir } = makeService();
  try {
    const curve = service.register({
      name: '晚高峰',
      mu: 10,
      capacity: 12,
      seed: 20240901,
      segments: SEGS_V1,
    });

    const v1 = service.compute(curve.id, 1).computation;
    assert.equal(v1.mode, 'full');
    assert.equal(v1.firstRecomputedIndex, 0);
    assert.ok(v1.segments.every((s) => s.reused === false));

    // 改第 2 段（index=2）的到达率
    const segsV2 = SEGS_V1.map((s, i) =>
      i === 2 ? { duration: 12, lambda: 40 } : { ...s },
    );
    service.addVersion(curve.id, segsV2);
    const inc = service.compute(curve.id, 2).computation;
    assert.equal(inc.mode, 'incremental');
    assert.equal(inc.firstRecomputedIndex, 2);
    assert.deepEqual(
      inc.segments.map((s) => s.reused),
      [true, true, false, false, false],
    );

    // 与从头完整重算 v2 逐位一致
    const version2 = service.getVersion(curve.id, 2);
    const full = runFullComputation(
      curve.id,
      { mu: 10, capacity: 12 },
      curve.seed,
      version2,
    );
    assertComputationsBitEqual(inc, full);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('验收五：末尾追加时段，旧段全部复用、只算新段，且逐位等于完整重算', () => {
  const { service, dir } = makeService();
  try {
    const curve = service.register({ mu: 5, capacity: 20, seed: 7, segments: SEGS_V1 });
    service.compute(curve.id, 1);

    const segsV2 = [...SEGS_V1, { duration: 4, lambda: 50 }, { duration: 4, lambda: 2 }];
    service.addVersion(curve.id, segsV2);
    const inc = service.compute(curve.id, 2).computation;
    assert.equal(inc.firstRecomputedIndex, 5);
    assert.deepEqual(
      inc.segments.map((s) => s.reused),
      [true, true, true, true, true, false, false],
    );

    const full = runFullComputation(
      curve.id,
      { mu: 5, capacity: 20 },
      7,
      service.getVersion(curve.id, 2),
    );
    assertComputationsBitEqual(inc, full);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('复用的前缀段结果与父版本完全相同（同一批 double 位模式，含解析和仿真）', () => {
  const { service, dir } = makeService();
  try {
    const curve = service.register({ mu: 10, capacity: 10, seed: 99, segments: SEGS_V1 });
    const v1 = service.compute(curve.id, 1).computation;

    const segsV2 = SEGS_V1.map((s, i) => (i === 3 ? { ...s, lambda: 2 } : { ...s }));
    service.addVersion(curve.id, segsV2);
    const v2 = service.compute(curve.id, 2).computation;

    for (let i = 0; i < 3; i++) {
      assert.equal(
        JSON.stringify(v2.segments[i].analytic),
        JSON.stringify(v1.segments[i].analytic),
        `第 ${i} 段解析结果应原样复用`,
      );
      assert.equal(
        JSON.stringify(v2.segments[i].simulation),
        JSON.stringify(v1.segments[i].simulation),
        `第 ${i} 段仿真结果应原样复用`,
      );
      assert.equal(
        JSON.stringify(v2.boundaries[i]),
        JSON.stringify(v1.boundaries[i]),
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('版本一只读不被版本二覆盖：v1 结果事后按版本号查到的仍是当时那份', () => {
  const { service, dir } = makeService();
  try {
    const curve = service.register({ mu: 10, capacity: 10, seed: 5, segments: SEGS_V1 });
    const v1Before = service.compute(curve.id, 1).computation;
    service.addVersion(
      curve.id,
      SEGS_V1.map((s, i) => (i === 1 ? { ...s, lambda: 1 } : { ...s })),
    );
    service.compute(curve.id, 2);

    const v1After = service.getComputation(curve.id, 1)!;
    assert.ok(v1After);
    assert.equal(JSON.stringify(v1After), JSON.stringify(v1Before));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('核算幂等：重复发起同一版本返回同一份持久化结果（alreadyComputed）', () => {
  const { service, dir } = makeService();
  try {
    const curve = service.register({ mu: 10, capacity: 10, seed: 5, segments: SEGS_V1 });
    const first = service.compute(curve.id, 1);
    assert.equal(first.alreadyComputed, false);
    const second = service.compute(curve.id, 1);
    assert.equal(second.alreadyComputed, true);
    assert.equal(
      JSON.stringify(second.computation),
      JSON.stringify(first.computation),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('父版本未核算时新版本从头算（mode=full），不做复用', () => {
  const { service, dir } = makeService();
  try {
    const curve = service.register({ mu: 10, capacity: 10, seed: 5, segments: SEGS_V1 });
    service.addVersion(curve.id, SEGS_V1.map((s, i) => (i === 2 ? { ...s, lambda: 1 } : { ...s })));
    const comp = service.compute(curve.id, 2).computation;
    assert.equal(comp.mode, 'full');
    assert.equal(comp.firstRecomputedIndex, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('验收六：新进程/丢弃缓存后重新打开数据目录，曲线、版本、结果、跨界状态都在', () => {
  const dir = mkdtempSync(join(tmpdir(), 'timvar-restart-'));
  try {
    let curveId: string;
    let v1Snapshot: string;
    {
      const store = new JsonCurveStore(dir);
      const service = new LoadCurveService(store);
      const curve = service.register({ mu: 10, capacity: 12, seed: 20240901, segments: SEGS_V1 });
      curveId = curve.id;
      service.compute(curveId, 1);
      service.addVersion(
        curveId,
        SEGS_V1.map((s, i) => (i === 2 ? { duration: 12, lambda: 40 } : { ...s })),
      );
      service.compute(curveId, 2);
      v1Snapshot = JSON.stringify(service.getComputation(curveId, 1));
    }
    // 模拟进程重启：全新 store 实例（空读缓存）指向同一数据目录
    {
      const store = new JsonCurveStore(dir);
      const service = new LoadCurveService(store);
      const curve: CurveRecord = service.getCurve(curveId!);
      assert.equal(curve.versions.length, 2);
      assert.equal(service.getVersion(curveId!, 2).segments[2].lambda, 40);

      const v1 = service.getComputation(curveId!, 1)!;
      assert.ok(v1);
      assert.equal(JSON.stringify(v1), v1Snapshot);

      // 重启后做增量核算 v3：改第 4 段，前缀复用必须仍逐位等于完整重算
      service.addVersion(
        curveId!,
        service.getVersion(curveId!, 2).segments.map((s, i) =>
          i === 4 ? { ...s, lambda: 99 } : { ...s },
        ),
      );
      const inc = service.compute(curveId!, 3).computation;
      assert.equal(inc.mode, 'incremental');
      assert.equal(inc.firstRecomputedIndex, 4);
      const full = runFullComputation(
        curveId!,
        { mu: 10, capacity: 12 },
        curve.seed,
        service.getVersion(curveId!, 3),
      );
      assertComputationsBitEqual(inc, full);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('forceFull 只读核算不落盘：之后普通核算仍正常生成持久化结果', () => {
  const { service, dir } = makeService();
  try {
    const curve = service.register({ mu: 10, capacity: 10, seed: 5, segments: SEGS_V1 });
    const probe = service.compute(curve.id, 1, { forceFull: true });
    assert.equal(probe.alreadyComputed, false);
    assert.equal(service.getComputation(curve.id, 1), null, 'forceFull 不应落盘');
    const normal = service.compute(curve.id, 1);
    assert.equal(normal.alreadyComputed, false);
    assert.ok(service.getComputation(curve.id, 1));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('引用不存在的曲线 / 版本抛 NotFoundError', () => {
  const { service, dir } = makeService();
  try {
    assert.throws(() => service.getCurve('00000000-0000-0000-0000-000000000000'), /不存在/);
    const curve = service.register({ mu: 10, capacity: 10, seed: 1, segments: SEGS_V1 });
    assert.throws(() => service.getVersion(curve.id, 99), /不存在版本/);
    assert.throws(() => service.compute(curve.id, 99), /不存在版本/);
    assert.equal(service.getComputation(curve.id, 1), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
