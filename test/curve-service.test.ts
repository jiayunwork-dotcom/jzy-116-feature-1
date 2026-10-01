import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CurveService, computeVersionFull } from '../src/timevarying/curve-service.js';
import { JsonStore } from '../src/timevarying/store.js';
import type { CurveSegment } from '../src/timevarying/types.js';

let dataDir: string;
let service: CurveService;
let store: JsonStore;

before(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'tv-service-'));
  store = new JsonStore(dataDir);
  service = new CurveService(store);
});

after(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

const MU = 10;
const CAPACITY = 6;
const SEED = 42;
const V1: CurveSegment[] = [
  { duration: 5, lambda: 8 },
  { duration: 3, lambda: 20 },
  { duration: 8, lambda: 2 },
  { duration: 4, lambda: 12 },
];

function assertSegmentBitEqual(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  a: Record<string, any>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  b: Record<string, any>,
  label: string,
): void {
  assert.deepEqual(a.analytic, b.analytic, `${label} analytic`);
  assert.deepEqual(a.simulation, b.simulation, `${label} simulation`);
  assert.deepEqual(a.simBoundary, b.simBoundary, `${label} simBoundary`);
  assert.deepEqual(a.difference, b.difference, `${label} difference`);
}

test('登记曲线得到 version=1，mu/capacity 固定在档案上', async () => {
  const curve = await service.registerCurve({
    mu: MU,
    capacity: CAPACITY,
    segments: V1,
    name: 'peak',
  });
  assert.equal(curve.versions.length, 1);
  assert.equal(curve.versions[0].version, 1);
  assert.equal(curve.mu, MU);
  assert.equal(curve.capacity, CAPACITY);
});

test('验收五：改中间段，v2 增量结果与 v2 从头完整重算逐位相同，复用标记正确', async () => {
  const curve = await service.registerCurve({
    mu: MU,
    capacity: CAPACITY,
    segments: V1,
  });
  const cid = curve.id;

  // 先核算 v1
  const v1 = await service.runComputation(cid, 1, SEED);
  assert.equal(v1.created, true);
  assert.equal(v1.record.firstRecomputedIndex, 0);
  assert.equal(v1.record.reusedFrom, null);
  assert.ok(v1.record.segments.every((s) => !s.reused));

  // 改第 3 段（下标 2），得到 v2
  const v2Segments: CurveSegment[] = V1.map((s, i) =>
    i === 2 ? { duration: 8, lambda: 9.5 } : s,
  );
  await service.createVersion(cid, { segments: v2Segments });

  // 增量核算 v2
  const inc = await service.runComputation(cid, 2, SEED);
  assert.equal(inc.created, true);
  assert.equal(inc.record.firstRecomputedIndex, 2, '从被改的段开始重算');
  assert.deepEqual(inc.record.reusedFrom, { curveId: cid, version: 1, seed: SEED });
  assert.deepEqual(
    inc.record.segments.map((s) => s.reused),
    [true, true, false, false],
  );

  // 同一版本从头完整重算（纯函数，不落盘）
  const full = computeVersionFull(
    { mu: MU, capacity: CAPACITY, segments: v2Segments },
    SEED,
  );

  assert.equal(full.length, inc.record.segments.length);
  for (let i = 0; i < full.length; i++) {
    assertSegmentBitEqual(
      inc.record.segments[i],
      full[i],
      `v2 段 ${i}（${i < 2 ? '复用' : '重算'}）`,
    );
  }

  // 被复用的前两段必须与 v1 当时存档逐位相同
  for (const i of [0, 1]) {
    assert.deepEqual(
      inc.record.segments[i].analytic,
      v1.record.segments[i].analytic,
    );
    assert.deepEqual(
      inc.record.segments[i].simulation,
      v1.record.segments[i].simulation,
    );
  }

  // v1 结果原样可查，未被 v2 盖掉
  const v1Again = await service.getComputation(cid, 1, SEED);
  assert.deepEqual(v1Again, v1.record);
});

test('末尾追加时段：只有新段重算，前段全部复用', async () => {
  const curve = await service.registerCurve({
    mu: MU,
    capacity: CAPACITY,
    segments: V1,
  });
  await service.runComputation(curve.id, 1, SEED);
  const appended = [...V1, { duration: 6, lambda: 15 }];
  await service.createVersion(curve.id, { segments: appended });
  const inc = await service.runComputation(curve.id, 2, SEED);
  assert.equal(inc.record.firstRecomputedIndex, 4);
  assert.deepEqual(
    inc.record.segments.map((s) => s.reused),
    [true, true, true, true, false],
  );
  const full = computeVersionFull(
    { mu: MU, capacity: CAPACITY, segments: appended },
    SEED,
  );
  for (let i = 0; i < full.length; i++) {
    assertSegmentBitEqual(inc.record.segments[i], full[i], `追加场景段 ${i}`);
  }
});

test('改第一段：没有可复用前缀，整份重算', async () => {
  const curve = await service.registerCurve({
    mu: MU,
    capacity: CAPACITY,
    segments: V1,
  });
  await service.runComputation(curve.id, 1, SEED);
  const changed = V1.map((s, i) => (i === 0 ? { duration: 5, lambda: 8.1 } : s));
  await service.createVersion(curve.id, { segments: changed });
  const inc = await service.runComputation(curve.id, 2, SEED);
  assert.equal(inc.record.firstRecomputedIndex, 0);
  assert.equal(inc.record.reusedFrom, null);
  assert.ok(inc.record.segments.every((s) => !s.reused));
});

test('不同 seed 之间不互相复用', async () => {
  const curve = await service.registerCurve({
    mu: MU,
    capacity: CAPACITY,
    segments: V1,
  });
  await service.runComputation(curve.id, 1, 7);
  const appended = [...V1, { duration: 6, lambda: 15 }];
  await service.createVersion(curve.id, { segments: appended });
  const otherSeed = await service.runComputation(curve.id, 2, 999);
  assert.equal(otherSeed.record.firstRecomputedIndex, 0, 'seed 不同必须从头算');
  assert.equal(otherSeed.record.reusedFrom, null);
});

test('同一 (版本, seed) 重复发起返回当时存档（幂等），结果不被重算覆盖', async () => {
  const curve = await service.registerCurve({
    mu: MU,
    capacity: CAPACITY,
    segments: V1,
  });
  const first = await service.runComputation(curve.id, 1, SEED);
  const again = await service.runComputation(curve.id, 1, SEED);
  assert.equal(again.created, false);
  assert.deepEqual(again.record, first.record);
  assert.equal(again.record.createdAt, first.record.createdAt);
});

test('引用不存在的曲线 / 版本 / 核算分别抛 NotFoundError', async () => {
  await assert.rejects(
    () => Promise.resolve(service.getCurve('does-not-exist')),
    { name: 'NotFoundError' },
  );
  const curve = await service.registerCurve({
    mu: MU,
    capacity: CAPACITY,
    segments: V1,
  });
  assert.throws(
    () => service.getVersion(curve, 5),
    { name: 'NotFoundError', message: /不存在版本/ },
  );
  await assert.rejects(
    () => service.getComputation(curve.id, 1, SEED),
    { name: 'NotFoundError', message: /尚无/ },
  );
});

test('重启等价性（直接换一个新 store 实例指到同一目录）：读档后增量仍与全量逐位一致', async () => {
  const curve = await service.registerCurve({
    mu: MU,
    capacity: CAPACITY,
    segments: V1,
  });
  const cid = curve.id;
  await service.runComputation(cid, 1, SEED);

  const v2Segments = V1.map((s, i) =>
    i === 2 ? { duration: 8, lambda: 9.5 } : s,
  );
  await service.createVersion(cid, { segments: v2Segments });

  // “重启”：丢弃服务实例，用同一数据目录重新构造
  const restartedService = new CurveService(new JsonStore(dataDir));
  const curveAfter = await restartedService.getCurve(cid);
  assert.equal(curveAfter.versions.length, 2);
  const inc = await restartedService.runComputation(cid, 2, SEED);
  assert.equal(inc.record.firstRecomputedIndex, 2);
  const full = computeVersionFull(
    { mu: MU, capacity: CAPACITY, segments: v2Segments },
    SEED,
  );
  for (let i = 0; i < full.length; i++) {
    assertSegmentBitEqual(inc.record.segments[i], full[i], `重启后续算段 ${i}`);
  }
});
