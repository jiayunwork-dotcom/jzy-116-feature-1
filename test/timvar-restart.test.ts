/**
 * 验收六端到端：真正起一个服务进程（编译后的 dist/server.js），登记曲线、
 * 核算 v1、加 v2、核算增量，然后 kill 进程；用同一数据目录再起一个全新
 * 进程，验证数据都在、版本一结果原样可查、重启后再做增量核算仍与完整
 * 重算逐位一致。
 *
 * 依赖 `npm run build` 先产出 dist/（见 package.json 的 pretest 钩子）。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DIST_SERVER = join(process.cwd(), 'dist', 'server.js');

let dataDir: string;

before(() => {
  if (!existsSync(DIST_SERVER)) {
    throw new Error('未找到 dist/server.js，请先运行 npm run build');
  }
  dataDir = mkdtempSync(join(tmpdir(), 'timvar-restart-http-'));
});

after(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

interface StartedServer {
  proc: ChildProcessByStdio<null, Readable, Readable>;
  port: number;
  stop: () => Promise<void>;
}

function startServer(dir: string): Promise<StartedServer> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      process.execPath,
      [DIST_SERVER],
      {
        env: { ...process.env, TIMVAR_DATA_DIR: dir, PORT: '0' },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let port: number | null = null;
    let settled = false;
    const onData = (chunk: Buffer) => {
      const line = chunk.toString();
      const m = line.match(/监听端口\s*(\d+)/);
      if (m && !settled) {
        port = Number(m[1]);
        settled = true;
        resolve({
          proc,
          port: port!,
          stop: () =>
            new Promise<void>((res, rej) => {
              proc.on('exit', () => res());
              proc.on('error', rej);
              proc.kill('SIGTERM');
            }),
        });
      }
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('error', (err) => {
      if (!settled) reject(err);
    });
    setTimeout(() => {
      if (!settled) {
        proc.kill('SIGTERM');
        reject(new Error('服务启动超时（未捕获到监听端口）'));
      }
    }, 10_000);
  });
}

async function req(port: number, method: string, path: string, body?: unknown) {
  const init: RequestInit = { method, headers: {} };
  if (body !== undefined) {
    (init.headers as Record<string, string>)['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  return fetch(`http://127.0.0.1:${port}${path}`, init);
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function j(res: Response): Promise<any> {
  return res.json();
}

const SEGS_V1 = [
  { duration: 20, lambda: 5 },
  { duration: 15, lambda: 30 },
  { duration: 25, lambda: 6 },
  { duration: 12, lambda: 20 },
  { duration: 18, lambda: 4 },
];

test('进程重启后：曲线/版本/结果/跨界状态持久化，且增量核算仍逐位等于完整重算', async () => {
  let curveId: string;
  let v1Snapshot: string;
  let seed: number;

  // ---- 第一个进程：登记 + v1 核算 + v2 增量核算 ----
  {
    const server = await startServer(dataDir);
    try {
      const reg = await j(await req(server.port, 'POST', '/api/curves', {
        name: '晚高峰',
        mu: 10,
        capacity: 14,
        seed: 8080,
        segments: SEGS_V1,
      }));
      curveId = reg.curve.id;
      seed = reg.curve.seed;

      await req(server.port, 'POST', `/api/curves/${curveId}/versions/1/computation`);
      v1Snapshot = JSON.stringify(
        (await j(await req(server.port, 'GET',
          `/api/curves/${curveId}/versions/1/computation`))).computation,
      );

      // v2：改第 2 段（index=2）
      const segsV2 = SEGS_V1.map((s, i) =>
        i === 2 ? { duration: 25, lambda: 80 } : s);
      const addV2 = await req(
        server.port, 'POST', `/api/curves/${curveId}/versions`, { segments: segsV2 },
      );
      assert.equal(addV2.status, 201);
      const inc = await j(await req(
        server.port, 'POST', `/api/curves/${curveId}/versions/2/computation`));
      assert.equal(inc.computation.mode, 'incremental');
      assert.equal(inc.computation.firstRecomputedIndex, 2);
      assert.deepEqual(
        inc.computation.segments.map((s: { reused: boolean }) => s.reused),
        [true, true, false, false, false],
      );
    } finally {
      await server.stop();
    }
  }

  // ---- 全新进程：同一数据目录 ----
  {
    const server2 = await startServer(dataDir);
    try {
      // 曲线与两个版本都在
      const curve = await j(await req(server2.port, 'GET', `/api/curves/${curveId!}`));
      assert.equal(curve.curve.versions.length, 2);
      assert.equal(curve.curve.seed, seed!);
      assert.equal(curve.curve.name, '晚高峰');
      assert.equal(
        (await j(await req(server2.port, 'GET',
          `/api/curves/${curveId}/versions/2`))).version.segments[2].lambda,
        80,
      );

      // v1 结果原样可查（逐位快照一致）
      const v1After = await j(await req(server2.port, 'GET',
        `/api/curves/${curveId}/versions/1/computation`));
      assert.equal(JSON.stringify(v1After.computation), v1Snapshot!);

      // v2 已核算结果也还在，且是增量那一份
      const v2After = await j(await req(server2.port, 'GET',
        `/api/curves/${curveId}/versions/2/computation`));
      assert.equal(v2After.computation.mode, 'incremental');
      assert.equal(v2After.computation.firstRecomputedIndex, 2);

      // 重启后再加 v3：改第 3 段（index=3），前缀 0..2 必须复用，
      // 且 forceFull 完整重算与增量逐位一致
      const segsV3 = (
        await j(await req(server2.port, 'GET',
          `/api/curves/${curveId}/versions/2`))
      ).version.segments.map((s: { duration: number; lambda: number }, i: number) =>
        i === 3 ? { duration: s.duration, lambda: 90 } : { ...s });

      const addV3 = await req(
        server2.port, 'POST', `/api/curves/${curveId}/versions`, { segments: segsV3 },
      );
      assert.equal(addV3.status, 201);

      const incV3 = await j(await req(server2.port, 'POST',
        `/api/curves/${curveId}/versions/3/computation`));
      assert.equal(incV3.computation.mode, 'incremental');
      assert.equal(incV3.computation.firstRecomputedIndex, 3);
      assert.deepEqual(
        incV3.computation.segments.map((s: { reused: boolean }) => s.reused),
        [true, true, true, false, false],
      );

      const fullV3 = await j(await req(server2.port, 'POST',
        `/api/curves/${curveId}/versions/3/computation`, { forceFull: true }));
      const strip = (comps: unknown[]) =>
        (comps as Array<Record<string, unknown>>).map(
          ({ reused: _r, ...rest }) => rest,
        );
      assert.equal(
        JSON.stringify(strip(incV3.computation.segments)),
        JSON.stringify(strip(fullV3.computation.segments)),
        '重启后增量结果仍必须与完整重算逐位一致',
      );
      assert.equal(
        JSON.stringify(incV3.computation.boundaries),
        JSON.stringify(fullV3.computation.boundaries),
      );

      // v1/v2 仍可查、未被 v3 影响
      const v1Still = await j(await req(server2.port, 'GET',
        `/api/curves/${curveId}/versions/1/computation`));
      assert.equal(JSON.stringify(v1Still.computation), v1Snapshot!);
    } finally {
      await server2.stop();
    }
  }
});

test('重启后引用不存在的曲线仍返回 404（存储层空目录不崩）', async () => {
  const freshDir = mkdtempSync(join(tmpdir(), 'timvar-fresh-'));
  const server = await startServer(freshDir);
  try {
    const res = await req(
      server.port,
      'GET',
      '/api/curves/00000000-0000-0000-0000-000000000000',
    );
    assert.equal(res.status, 404);
  } finally {
    await server.stop();
    rmSync(freshDir, { recursive: true, force: true });
  }
});
