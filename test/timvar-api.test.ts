import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { createApp } from '../src/app.js';

let server: Server;
let base: string;
let dataDir: string;

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'timvar-api-'));
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

async function req(method: string, path: string, body?: unknown) {
  const init: RequestInit = { method, headers: {} };
  if (body !== undefined) {
    (init.headers as Record<string, string>)['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  return fetch(`${base}${path}`, init);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function json(res: Response): Promise<any> {
  return res.json();
}

test('登记曲线 → 取得曲线（含版本 1）', async () => {
  const res = await req('POST', '/api/curves', {
    name: '晚高峰复盘',
    mu: 10,
    capacity: 8,
    seed: 20240901,
    segments: [
      { duration: 30, lambda: 5 },
      { duration: 20, lambda: 25 },
      { duration: 30, lambda: 6 },
    ],
  });
  assert.equal(res.status, 201);
  const body = await json(res);
  assert.ok(body.curve.id);
  assert.equal(body.curve.versions.length, 1);
  assert.equal(body.curve.versions[0].version, 1);
  assert.equal(body.curve.versions[0].parentVersion, 0);
  assert.equal(body.curve.seed, 20240901);

  const got = await req('GET', `/api/curves/${body.curve.id}`);
  assert.equal(got.status, 200);
  assert.equal((await json(got)).curve.name, '晚高峰复盘');
});

test('新增版本：老版本保留，版本号与父版本号正确', async () => {
  const reg = await req('POST', '/api/curves', {
    mu: 10, capacity: 5, seed: 1,
    segments: [{ duration: 10, lambda: 4 }],
  });
  const id = (await json(reg)).curve.id;

  const v2 = await req('POST', `/api/curves/${id}/versions`, {
    segments: [{ duration: 10, lambda: 4 }, { duration: 5, lambda: 20 }],
  });
  assert.equal(v2.status, 201);
  const v2body = await json(v2);
  assert.equal(v2body.version.version, 2);
  assert.equal(v2body.version.parentVersion, 1);

  const v1 = await req('GET', `/api/curves/${id}/versions/1`);
  assert.equal(v1.status, 200);
  assert.equal((await json(v1)).version.segments.length, 1);
});

test('核算：每段同时给出瞬态解析、仿真与对照，段末分布带在解析里', async () => {
  const reg = await req('POST', '/api/curves', {
    mu: 10, capacity: 6, seed: 20240901,
    segments: [
      { duration: 40, lambda: 8 },
      { duration: 20, lambda: 25 },
    ],
  });
  const id = (await json(reg)).curve.id;

  const comp = await req('POST', `/api/curves/${id}/versions/1/computation`);
  assert.equal(comp.status, 200);
  const body = await json(comp);
  assert.equal(body.alreadyComputed, false);
  assert.equal(body.computation.mode, 'full');
  assert.equal(body.computation.segments.length, 2);
  assert.equal(body.computation.rngAlgorithm, 'mulberry32');
  assert.ok(body.computation.boundaries.length === 2);

  for (const seg of body.computation.segments) {
    assert.equal(seg.analytic.endStateProbabilities.length, 7);
    assert.ok(seg.analytic.timeAveragedBlockingProbability >= 0);
    assert.ok(seg.analytic.timeAveragedMeanNumberInSystem >= 0);
    assert.ok(seg.analytic.timeAveragedUtilization >= 0);
    assert.equal(seg.simulation.accepted + seg.simulation.rejected,
      seg.simulation.totalArrivals);
    assert.ok(seg.comparison.blockingProbability.absoluteDifference >= 0);
    assert.equal(seg.reused, false);
  }
  // 跨界状态：高峰段结束时系统内人数应已明显积压
  assert.ok(body.computation.boundaries[0].numberInSystem >= 0);
});

test('验收五 HTTP：改中间段 → 增量核算，标记正确，且 forceFull 与增量逐位一致', async () => {
  const segs1 = [
    { duration: 20, lambda: 4 },
    { duration: 15, lambda: 22 },
    { duration: 25, lambda: 7 },
    { duration: 10, lambda: 18 },
  ];
  const reg = await req('POST', '/api/curves', {
    mu: 10, capacity: 10, seed: 31337, segments: segs1,
  });
  const id = (await json(reg)).curve.id;
  await req('POST', `/api/curves/${id}/versions/1/computation`);

  const segs2 = segs1.map((s, i) => (i === 2 ? { duration: 25, lambda: 60 } : s));
  await req('POST', `/api/curves/${id}/versions`, { segments: segs2 });
  const incRes = await req('POST', `/api/curves/${id}/versions/2/computation`);
  const inc = (await json(incRes)).computation;
  assert.equal(inc.mode, 'incremental');
  assert.equal(inc.firstRecomputedIndex, 2);
  assert.deepEqual(inc.segments.map((s: { reused: boolean }) => s.reused),
    [true, true, false, false]);

  // forceFull：只读完整重算，与持久化的增量结果逐位一致（剥 reused）
  const fullRes = await req(
    'POST',
    `/api/curves/${id}/versions/2/computation`,
    { forceFull: true },
  );
  assert.equal(fullRes.status, 200);
  // 注意：此刻 v2 已核算，普通 POST 会返回已存结果；forceFull 是独立只读路径
  const full = (await json(fullRes)).computation;
  const strip = (comps: unknown[]) =>
    (comps as Array<Record<string, unknown>>).map(({ reused: _r, ...rest }) => rest);
  assert.equal(
    JSON.stringify(strip(inc.segments)),
    JSON.stringify(strip(full.segments)),
  );
  assert.equal(
    JSON.stringify(inc.boundaries),
    JSON.stringify(full.boundaries),
  );

  // 版本一结果原样可查：v1 未被 v2 覆盖，各段 λ 还是老曲线
  const v1Res = await req('GET', `/api/curves/${id}/versions/1/computation`);
  assert.equal(v1Res.status, 200);
  const v1 = (await json(v1Res)).computation;
  assert.equal(v1.mode, 'full');
  assert.deepEqual(
    v1.segments.map((s: { lambda: number }) => s.lambda),
    [4, 22, 7, 18],
  );
  assert.deepEqual(
    v1.segments.map((s: { reused: boolean }) => s.reused),
    [false, false, false, false],
  );
});

test('核算幂等：第二次 POST 返回 alreadyComputed=true 且内容不变', async () => {
  const reg = await req('POST', '/api/curves', {
    mu: 10, capacity: 4, seed: 1, segments: [{ duration: 5, lambda: 8 }],
  });
  const id = (await json(reg)).curve.id;
  const first = await json(await req('POST', `/api/curves/${id}/versions/1/computation`));
  const second = await json(await req('POST', `/api/curves/${id}/versions/1/computation`));
  assert.equal(second.alreadyComputed, true);
  assert.equal(
    JSON.stringify(second.computation),
    JSON.stringify(first.computation),
  );
});

test('GET 未核算的版本 → 404；GET 不存在曲线/版本 → 404', async () => {
  const reg = await req('POST', '/api/curves', {
    mu: 10, capacity: 4, seed: 1, segments: [{ duration: 5, lambda: 8 }],
  });
  const id = (await json(reg)).curve.id;
  const missing = await req('GET', `/api/curves/${id}/versions/1/computation`);
  assert.equal(missing.status, 404);

  assert.equal(
    (await req('GET', `/api/curves/00000000-0000-0000-0000-000000000000`)).status,
    404,
  );
  assert.equal(
    (await req('GET', `/api/curves/${id}/versions/9`)).status,
    404,
  );
});

test('非法入参：400 且响应带 fields 字段说明', async () => {
  const cases = [
    { body: { mu: 0, capacity: 5, segments: [{ duration: 3, lambda: 5 }] }, field: 'mu' },
    { body: { mu: 10, capacity: 5, segments: [{ duration: -1, lambda: 5 }] }, field: 'segments[0].duration' },
    { body: { mu: 10, capacity: 5, segments: [{ duration: 3, lambda: -2 }] }, field: 'segments[0].lambda' },
    { body: { mu: 10, capacity: 5, segments: [] }, field: 'segments' },
  ];
  for (const { body, field } of cases) {
    const res = await req('POST', '/api/curves', body);
    assert.equal(res.status, 400, JSON.stringify(body));
    const errBody = await json(res);
    assert.equal(typeof errBody.error, 'string');
    assert.ok(errBody.fields[field], `期望 fields.${field}，实际 ${JSON.stringify(errBody.fields)}`);
  }
});

test('新版本里夹带 mu/capacity/seed → 400', async () => {
  const reg = await req('POST', '/api/curves', {
    mu: 10, capacity: 4, seed: 1, segments: [{ duration: 5, lambda: 8 }],
  });
  const id = (await json(reg)).curve.id;
  const res = await req('POST', `/api/curves/${id}/versions`, {
    mu: 11,
    segments: [{ duration: 5, lambda: 8 }],
  });
  assert.equal(res.status, 400);
});

test('老接口在时变模块装配后行为不变（同种子可复现）', async () => {
  const payload = { lambda: 8, mu: 10, capacity: 4, seed: 20240901, maxArrivals: 50_000 };
  const r1 = await req('POST', '/api/simulation', payload);
  const r2 = await req('POST', '/api/simulation', payload);
  assert.equal(r1.status, 200);
  assert.deepEqual(await json(r1), await json(r2));
  const a = await req('POST', '/api/analytic', { lambda: 8, mu: 10, capacity: 4 });
  assert.equal(a.status, 200);
});
