import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';

let server: Server;
let base: string;
let dataDir: string;

before(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'tv-api-'));
  await new Promise<void>((resolve) => {
    server = createApp({ dataDir }).listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('无法获取监听地址');
  base = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
  rmSync(dataDir, { recursive: true, force: true });
});

/* eslint-disable @typescript-eslint/no-explicit-any */
async function post(p: string, body: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${p}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}
async function get(p: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${p}`);
  return { status: res.status, body: await res.json() };
}

async function registerCurve(segments: Array<{ duration: number; lambda: number }>, rest: { mu?: number; capacity?: number } = {}) {
  const res = await post('/api/curves', {
    mu: rest.mu ?? 10,
    capacity: rest.capacity ?? 6,
    segments,
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.id as string;
}

const PEAK = [
  { duration: 5, lambda: 8 },
  { duration: 3, lambda: 20 },
  { duration: 8, lambda: 2 },
  { duration: 4, lambda: 12 },
];

test('登记曲线 / 读取版本：版本只增，老版本原样可调出', async () => {
  const cid = await registerCurve(PEAK);
  const listed = await get('/api/curves');
  assert.equal(listed.status, 200);
  assert.ok(listed.body.curves.some((c: { id: string }) => c.id === cid));

  const curve = await get(`/api/curves/${cid}`);
  assert.equal(curve.body.versions.length, 1);

  await post(`/api/curves/${cid}/versions`, {
    segments: [...PEAK.slice(0, 3), { duration: 4, lambda: 13 }],
  });
  const v1 = await get(`/api/curves/${cid}/versions/1`);
  const v2 = await get(`/api/curves/${cid}/versions/2`);
  assert.equal(v1.body.segments[3].lambda, 12);
  assert.equal(v2.body.segments[3].lambda, 13);
  assert.equal(v1.body.mu, 10);
  assert.equal(v1.body.capacity, 6);
});

test('核算返回分段解析+仿真+差距，字段口径齐全', async () => {
  const cid = await registerCurve([
    { duration: 30, lambda: 8 },
    { duration: 20, lambda: 2 },
  ], { mu: 10, capacity: 5 });
  const r = await post(`/api/curves/${cid}/versions/1/computations`, { seed: 777 });
  assert.equal(r.status, 201);
  assert.equal(r.body.rngAlgorithm, 'mulberry32');
  assert.equal(r.body.segments.length, 2);
  for (const seg of r.body.segments) {
    assert.equal(seg.analytic.endDistribution.length, 6);
    assert.ok(typeof seg.analytic.blockingProbability === 'number');
    assert.ok(typeof seg.analytic.meanNumberInSystem === 'number');
    assert.ok(typeof seg.analytic.utilization === 'number');
    assert.ok(typeof seg.simulation.blockingProbability === 'number');
    assert.equal(seg.simulation.duration, seg.duration);
    assert.ok(Math.abs(
      seg.difference.blockingProbability -
        Math.abs(seg.analytic.blockingProbability - seg.simulation.blockingProbability),
    ) < 1e-15);
    assert.equal(seg.reused, false);
    assert.ok(seg.simBoundary);
  }
  // 状态连续：第二段解析初值就是第一段段末分布（第二段阻塞不应清零重启效应）
  // 直接验证 GET 取回同一份结果
  const again = await get(`/api/curves/${cid}/versions/1/computations/777`);
  assert.equal(again.status, 200);
  assert.deepEqual(again.body, r.body);
});

test('验收五（HTTP）：改中间段→增量核算的复用标记正确，且结果按版本绑定', async () => {
  const cid = await registerCurve(PEAK);
  const v1 = await post(`/api/curves/${cid}/versions/1/computations`, { seed: 42 });
  assert.equal(v1.body.firstRecomputedIndex, 0);
  assert.equal(v1.body.reusedFrom, null);

  // 版本二：只改下标 2 的段
  await post(`/api/curves/${cid}/versions`, {
    segments: [PEAK[0], PEAK[1], { duration: 8, lambda: 9.5 }, PEAK[3]],
  });
  const v2 = await post(`/api/curves/${cid}/versions/2/computations`, { seed: 42 });
  assert.equal(v2.status, 201);
  assert.equal(v2.body.firstRecomputedIndex, 2);
  assert.deepEqual(v2.body.reusedFrom, { curveId: cid, version: 1, seed: 42 });
  assert.deepEqual(v2.body.segments.map((s: { reused: boolean }) => s.reused),
    [true, true, false, false]);

  // 复用段与 v1 存档逐位相同
  for (const i of [0, 1]) {
    assert.deepEqual(v2.body.segments[i].analytic, v1.body.segments[i].analytic);
    assert.deepEqual(v2.body.segments[i].simulation, v1.body.segments[i].simulation);
  }

  // v1 结果事后按版本号查到的仍是当时那份
  const v1Again = await get(`/api/curves/${cid}/versions/1/computations/42`);
  assert.deepEqual(v1Again.body, v1.body);

  // 再发一次 v2 同 seed：幂等返回，不再重算
  const v2Again = await post(`/api/curves/${cid}/versions/2/computations`, { seed: 42 });
  assert.equal(v2Again.status, 200);
  assert.deepEqual(v2Again.body, v2.body);
});

test('追加时段：共享前缀全部复用，只算新段', async () => {
  const cid = await registerCurve(PEAK);
  await post(`/api/curves/${cid}/versions/1/computations`, { seed: 42 });
  await post(`/api/curves/${cid}/versions`, { segments: [...PEAK, { duration: 6, lambda: 15 }] });
  const r = await post(`/api/curves/${cid}/versions/2/computations`, { seed: 42 });
  assert.equal(r.body.firstRecomputedIndex, 4);
  assert.deepEqual(
    r.body.segments.map((s: { reused: boolean }) => s.reused),
    [true, true, true, true, false],
  );
});

test('验收三（HTTP 口径）：单段曲线分段仿真与既有仿真接口按时长停止一致', async () => {
  const payload = { lambda: 8, mu: 10, capacity: 5, seed: 20240901, maxTime: 40 };
  const old = await post('/api/simulation', payload);
  assert.equal(old.status, 200);

  const cid = await registerCurve([{ duration: 40, lambda: 8 }], {
    mu: 10,
    capacity: 5,
  });
  const tv = await post(`/api/curves/${cid}/versions/1/computations`, { seed: 20240901 });
  const seg = tv.body.segments[0].simulation;
  assert.equal(seg.totalArrivals, old.body.totalArrivals);
  assert.equal(seg.accepted, old.body.accepted);
  assert.equal(seg.rejected, old.body.rejected);
  assert.equal(seg.blockingProbability, old.body.blockingProbability);
  assert.equal(seg.meanNumberInSystem, old.body.meanNumberInSystem);
  assert.equal(seg.meanNumberWaiting, old.body.meanNumberWaiting);
  assert.equal(seg.utilization, old.body.utilization);
});

test('验收四（HTTP）：长时段经验阻塞比例、平均队长贴近瞬态解析值', async () => {
  // λ=8、μ=10、K=8，先跑 40 个时间单位让系统进入准稳态，再接一段长段。
  // T=1000 时期望约 8000 个到达尝试，固定种子的经验偏差实测：
  // 阻塞 < 0.02、队长 < 0.16、利用率 < 0.02，测试取宽限 0.05 / 0.25 / 0.05。
  const cid = await registerCurve([
    { duration: 40, lambda: 8 },
    { duration: 1000, lambda: 8 },
  ], { mu: 10, capacity: 8 });
  const r = await post(`/api/curves/${cid}/versions/1/computations`, { seed: 20240901 });
  const seg = r.body.segments[1];
  assert.ok(seg.difference.blockingProbability < 0.05,
    `阻塞差距=${seg.difference.blockingProbability}`);
  assert.ok(seg.difference.meanNumberInSystem < 0.25,
    `队长差距=${seg.difference.meanNumberInSystem}`);
  assert.ok(seg.difference.utilization < 0.05,
    `利用率差距=${seg.difference.utilization}`);
});

test('验收七：超限与非法输入返回带字段说明的错误响应', async () => {
  const bad: Array<{ body: unknown; field: string }> = [
    { body: { mu: -1, capacity: 6, segments: [{ duration: 1, lambda: 1 }] }, field: 'mu' },
    { body: { mu: 10, capacity: 0, segments: [{ duration: 1, lambda: 1 }] }, field: 'capacity' },
    { body: { mu: 10, capacity: 6, segments: [] }, field: 'segments' },
    { body: { mu: 10, capacity: 6, segments: [{ duration: 0, lambda: 1 }] }, field: 'segments[0].duration' },
    { body: { mu: 10, capacity: 6, segments: [{ duration: -2, lambda: 1 }] }, field: 'segments[0].duration' },
    { body: { mu: 10, capacity: 6, segments: [{ duration: 1, lambda: -3 }] }, field: 'segments[0].lambda' },
    // 容量超曲线层上限 500
    { body: { mu: 10, capacity: 501, segments: [{ duration: 1, lambda: 1 }] }, field: 'capacity' },
    // 单段均匀化工作量超上限（(λ+μ)T > 200000）
    { body: { mu: 10, capacity: 6, segments: [{ duration: 100000, lambda: 100 }] }, field: 'segments[0]' },
  ];
  for (const { body, field } of bad) {
    const r = await post('/api/curves', body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(typeof r.body.error, 'string');
    assert.equal(r.body.field, field, JSON.stringify(body));
  }

  // 时段数超上限（200）
  const tooMany = { mu: 10, capacity: 6, segments: Array.from({ length: 201 }, () => ({ duration: 1, lambda: 1 })) };
  const r = await post('/api/curves', tooMany);
  assert.equal(r.status, 400);
  assert.equal(r.body.field, 'segments');

  // seed 非法
  const cid = await registerCurve(PEAK);
  const badSeed = await post(`/api/curves/${cid}/versions/1/computations`, { seed: -1 });
  assert.equal(badSeed.status, 400);
  assert.equal(badSeed.body.field, 'seed');

  // seed=0 合法且可按路径取回
  const seed0 = await post(`/api/curves/${cid}/versions/1/computations`, { seed: 0 });
  assert.equal(seed0.status, 201);
  const seed0Get = await get(`/api/curves/${cid}/versions/1/computations/0`);
  assert.equal(seed0Get.status, 200);
  assert.deepEqual(seed0Get.body, seed0.body);
  const badSeedPath = await get(`/api/curves/${cid}/versions/1/computations/abc`);
  assert.equal(badSeedPath.status, 400);
  assert.equal(badSeedPath.body.field, 'seed');
});

test('引用不存在的曲线 / 版本 / 核算返回 404', async () => {
  const r1 = await get('/api/curves/nonexistent-id');
  assert.equal(r1.status, 404);
  assert.equal(r1.body.field, 'curveId');

  const cid = await registerCurve(PEAK);
  const r2 = await get(`/api/curves/${cid}/versions/99`);
  assert.equal(r2.status, 404);
  assert.equal(r2.body.field, 'version');

  const r3 = await get(`/api/curves/${cid}/versions/1/computations/1`);
  assert.equal(r3.status, 404);
});

test('老接口保持无状态可用，且新存储不改变其错误语义', async () => {
  const ok = await post('/api/analytic', { lambda: 8, mu: 10, capacity: 4 });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.stateProbabilities.length, 5);

  const bad = await post('/api/analytic', { lambda: 0, mu: 10, capacity: 4 });
  assert.equal(bad.status, 400);
  assert.equal(typeof bad.body.error, 'string');
});
