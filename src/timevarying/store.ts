/**
 * 时变负荷层的持久化：本地 JSON 文件存储（无外部数据库依赖）。
 *
 * - 数据目录由 DATA_DIR 环境变量指定，缺省 ./data；
 * - 每条曲线一个文件 curves/<id>.json（含全部版本，版本只增不改）；
 *   每次核算一个文件 computations/<curveId>__v<version>__s<seed>.json
 *   （结果与续算中间状态 simBoundary 都在里面，写入后不可变）；
 * - 所有写入走"临时文件 + rename"原子替换，崩溃不会留下半截 JSON；
 * - 进程内按曲线加异步互斥锁，同一曲线的登记/建版/核算串行化，
 *   避免并发请求读到互相覆盖的版本；
 * - 老的 analytic/simulation/compare 接口完全不引用本模块，保持无状态、
 *   不触碰磁盘。
 *
 * JSON 对 IEEE-754 double 逐位保真（Number 本就是 double，JSON.parse 原样
 * 还原），数组下标都是整数，因此重启后读出的段末分布、仿真边界浮点量
 * 与写入时逐位相同，增量续算与从头整算仍然逐位一致。
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { ComputationRecord, CurveRecord } from './types.js';

function ensureSafeId(id: string): string {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id)) {
    throw new Error(`非法存储标识：${id}`);
  }
  return id;
}

export class JsonStore {
  private readonly curvesDir: string;
  private readonly computationsDir: string;
  /** 按 key 串行化的异步互斥锁队列 */
  private readonly locks = new Map<string, Array<() => void>>();

  constructor(dataDir: string) {
    this.curvesDir = path.join(dataDir, 'curves');
    this.computationsDir = path.join(dataDir, 'computations');
  }

  private async ensureDirs(): Promise<void> {
    await fs.mkdir(this.curvesDir, { recursive: true });
    await fs.mkdir(this.computationsDir, { recursive: true });
  }

  /** 在同一把 key 锁内执行 fn，保证同曲线操作串行 */
  async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const queue = this.locks.get(key);
    if (queue) {
      await new Promise<void>((resolve) => queue.push(resolve));
    } else {
      this.locks.set(key, []);
    }
    try {
      return await fn();
    } finally {
      const next = this.locks.get(key);
      if (next && next.length > 0) {
        const resolve = next.shift() as () => void;
        resolve();
      } else {
        this.locks.delete(key);
      }
    }
  }

  private curvePath(id: string): string {
    return path.join(this.curvesDir, `${ensureSafeId(id)}.json`);
  }

  private computationPath(record: Pick<ComputationRecord, 'curveId' | 'version' | 'seed'>): string {
    return path.join(
      this.computationsDir,
      `${ensureSafeId(record.curveId)}__v${record.version}__s${record.seed}.json`,
    );
  }

  private async atomicWrite(target: string, data: unknown): Promise<void> {
    await this.ensureDirs();
    const tmp = `${target}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(data), 'utf8');
    await fs.rename(tmp, target);
  }

  private async readJson<T>(file: string): Promise<T | null> {
    try {
      const raw = await fs.readFile(file, 'utf8');
      return JSON.parse(raw) as T;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async loadCurve(id: string): Promise<CurveRecord | null> {
    return this.readJson<CurveRecord>(this.curvePath(id));
  }

  async saveCurve(curve: CurveRecord): Promise<void> {
    await this.atomicWrite(this.curvePath(curve.id), curve);
  }

  async listCurves(): Promise<Array<Pick<CurveRecord, 'id' | 'name' | 'updatedAt'>>> {
    await this.ensureDirs();
    const files = await fs.readdir(this.curvesDir);
    const curves: Array<Pick<CurveRecord, 'id' | 'name' | 'updatedAt'>> = [];
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const curve = await this.readJson<CurveRecord>(path.join(this.curvesDir, file));
      if (curve) {
        curves.push({ id: curve.id, name: curve.name, updatedAt: curve.updatedAt });
      }
    }
    curves.sort((a, b) => a.id.localeCompare(b.id));
    return curves;
  }

  async loadComputation(
    curveId: string,
    version: number,
    seed: number,
  ): Promise<ComputationRecord | null> {
    return this.readJson<ComputationRecord>(
      this.computationPath({ curveId, version, seed }),
    );
  }

  async saveComputation(record: ComputationRecord): Promise<void> {
    await this.atomicWrite(this.computationPath(record), record);
  }

  /**
   * 列出某曲线已存档的全部核算（增量复用时逐个扫描，挑共享前缀最长的）。
   * 文件不可变，列表只随新增增长。
   */
  async listComputations(curveId: string): Promise<ComputationRecord[]> {
    await this.ensureDirs();
    const prefix = `${ensureSafeId(curveId)}__`;
    const files = await fs.readdir(this.computationsDir);
    const records: ComputationRecord[] = [];
    for (const file of files) {
      if (!file.startsWith(prefix) || !file.endsWith('.json')) continue;
      const record = await this.readJson<ComputationRecord>(
        path.join(this.computationsDir, file),
      );
      if (record && record.curveId === curveId) records.push(record);
    }
    return records;
  }

  /** 生成曲线 id：16 字节随机 hex，仅含合法字符 */
  static newCurveId(): string {
    return randomBytes(8).toString('hex');
  }
}
