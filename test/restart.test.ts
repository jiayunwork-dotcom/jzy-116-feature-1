/**
 * 验收六：真实进程重启之后——
 * - 已登记曲线、各版本、已有结果仍在；
 * - 重启后再做增量核算，结果与把新版本从头完整重算逐位一致。
 *
 * 做法：本文件用 child_process 把编译后的 dist/server.js 拉起两次
 * （容器里执行 npm run build 后 npm test 即可），两次指向同一 DATA_DIR；
 * 全量参照值由同进程的纯函数 computeVersionFull 给出。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeVersionFull } from '../src/timevarying/curve-service.js';
import type { CurveSegment } from '../src/timevarying/types.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverEntry = path.join(here, '..', 'dist', 'server.js');

let dataDir: string;
let portCounter = 8250;

const V1: CurveSegment[] = [
  { duration: 5, lambda: 8 },
  { duration: 3, lambda: 20 },
  { duration: 8, lambda: 2 },
  { duration: 4, lambda: 12 },
];
const V2: CurveSegment[] = [
  { duration: 5, lambda: 8 },
  { duration: 3, lambda: 20 },
  { duration: 8, lambda: 9.5 }, // 只改下标 2
  { duration: 4, lambda: 12 },
];
const SEED = 42;
const MU = 10;
const CAPACITY = 6;

class ServerProcess {
  private proc: ChildProcess | null = null;
  readonly port: number;

  constructor(private readonly dir: string) {
    this.port = portCounter++;
  }

  async start(): Promise<void> {
    if (!existsSync(serverEntry)) {
      throw new Error(
        `找不到 ${serverEntry}，请先执行 npm run build（容器内自动化测试同此前提）`,
      );
    }
    this.proc = spawn(process.execPath, [serverEntry], {
      env: { ...process.env, PORT: String(this.port), DATA_DIR: this.dir },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.proc.stderr?.on('data', (d) => process.stderr.write(d));
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
    for (let i = 0; i < 60; i++) {
      try {
        const res = await fetch(`http://127.0.0.1:${this.port}/health`);
        if (res.ok) return;
      } catch { /* 还没起好 */ }
      await wait(100);
    }
    throw new Error('子进程服务未在超时内就绪');
  }

  async stop(): Promise<void> {
    if (!this.proc || this.proc.exitCode !== null) return;
    await new Promise<void>((resolve) => {
      this.proc!.once('exit', () => resolve());
      this.proc!.kill('SIGTERM');
      setTimeout(() => this.proc!.kill('SIGKILL'), 4000).unref();
    });
  }

  /* eslint-disable @typescript-eslint/no-explicit-any */
  async post(p: string, body: unknown): Promise<{ status: number; body: any }> {
    const res = await fetch(`http://127.0.0.1:${this.port}${p}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  }

  async get(p: string): Promise<{ status: number; body: any }> {
    const res = await fetch(`http://127.0.0.1:${this.port}${p}`);
    return { status: res.status, body: await res.json() };
  }
}

let server: ServerProcess;

before(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'tv-restart-test-'));
});

after(async () => {
  await server?.stop();
  rmSync(dataDir, { recursive: true, force: true });
});

test('验收六：重启后曲线/版本/结果仍在，且增量核算与从头重算逐位一致', async () => {
  // ---- 进程 1：登记 v1 并核算；创建 v2（不核算） ----
  server = new ServerProcess(dataDir);
  await server.start();

  const reg = await server.post('/api/curves', {
    mu: MU, capacity: CAPACITY, segments: V1,
  });
  assert.equal(reg.status, 201);
  const cid = reg.body.id as string;

  const c1 = await server.post(
    `/api/curves/${cid}/versions/1/computations`,
    { seed: SEED },
  );
  assert.equal(c1.status, 201);

  const v2created = await server.post(`/api/curves/${cid}/versions`, {
    segments: V2,
  });
  assert.equal(v2created.status, 201);

  await server.stop();

  // ---- 进程 2：同一数据目录“重启”（构造新实例自动拿到新端口） ----
  server = new ServerProcess(dataDir);
  await server.start();

  // 曲线与版本仍在
  const curve = await server.get(`/api/curves/${cid}`);
  assert.equal(curve.status, 200);
  assert.equal(curve.body.versions.length, 2);
  assert.deepEqual(curve.body.versions[1].segments, V2);

  // v1 已有的核算结果原样可查
  const c1Again = await server.get(
    `/api/curves/${cid}/versions/1/computations/${SEED}`,
  );
  assert.equal(c1Again.status, 200);
  assert.deepEqual(c1Again.body, c1.body);

  // 重启后对 v2 发起增量核算：前两段复用、后两段重算
  const c2 = await server.post(
    `/api/curves/${cid}/versions/2/computations`,
    { seed: SEED },
  );
  assert.equal(c2.status, 201);
  assert.equal(c2.body.firstRecomputedIndex, 2);
  assert.deepEqual(c2.body.reusedFrom, { curveId: cid, version: 1, seed: SEED });
  assert.deepEqual(
    c2.body.segments.map((s: { reused: boolean }) => s.reused),
    [true, true, false, false],
  );

  // 关键断言：与 v2 从头完整重算逐位相同（解析、仿真、边界状态都算）
  const full = computeVersionFull(
    { mu: MU, capacity: CAPACITY, segments: V2 },
    SEED,
  );
  for (let i = 0; i < full.length; i++) {
    const got = c2.body.segments[i];
    assert.equal(got.index, i);
    assert.deepEqual(got.analytic, full[i].analytic, `段 ${i} 解析逐位一致`);
    assert.deepEqual(got.simulation, full[i].simulation, `段 ${i} 仿真逐位一致`);
    assert.deepEqual(got.simBoundary, full[i].simBoundary, `段 ${i} 边界逐位一致`);
    assert.deepEqual(got.difference, full[i].difference, `段 ${i} 差距逐位一致`);
  }

  // 复用段确确实实来自 v1 当时那份
  for (const i of [0, 1]) {
    assert.deepEqual(c2.body.segments[i].analytic, c1.body.segments[i].analytic);
    assert.deepEqual(c2.body.segments[i].simulation, c1.body.segments[i].simulation);
  }
});
