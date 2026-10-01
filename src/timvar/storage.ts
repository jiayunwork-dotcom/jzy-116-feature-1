import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  readdirSync,
} from 'node:fs';
import { join } from 'node:path';
import type { PersistedCurve } from './types.js';

/**
 * 时变负荷数据的持久化。
 *
 * 形式：每条曲线一个 JSON 文件（<dataDir>/curves/<curveId>.json），
 * 文件内容就是曲线聚合根：元数据 + 全部版本 + 各版本核算结果（含每段末
 * 的仿真边界状态）。选它而不是 SQLite 的理由：
 *
 * - 零新依赖，node:20-slim 镜像不用改底座；
 * - 曲线一次登记、版本只增不改、核算一次绑定，天然是“按 id 取整棵
 *   聚合”的访问模式，单文件读写即可覆盖全部接口；
 * - 增量判定需要完整读父版本与其核算结果，本来就是一次全量读取；
 * - JSON.parse/stringify 对 IEEE-754 double 逐位往返（数字按最短十进制
 *   串写出，读回仍是同一个 double），这是“重启后增量仍逐位一致”的前提。
 *
 * 写入原子性：先写同目录临时文件再 rename，崩溃最多留下旧版本或一个
 * .tmp 文件，绝不会读到写了一半的 JSON。写路径外层（service）按曲线 id
 * 串行化，同一条曲线不会有两个并发写交错。
 *
 * 目录懒创建：只有真正发生写操作时才 mkdir，老接口全程不碰存储，
 * 甚至在没有数据目录权限的环境里老接口也照常服务。
 */

const CURVES_SUBDIR = 'curves';

export class JsonCurveStore {
  private readonly curvesDir: string;
  private cache = new Map<string, PersistedCurve>();

  constructor(dataDir: string) {
    this.curvesDir = join(dataDir, CURVES_SUBDIR);
  }

  private ensureDir(): void {
    mkdirSync(this.curvesDir, { recursive: true });
  }

  private fileFor(id: string): string {
    return join(this.curvesDir, `${id}.json`);
  }

  /** 按 id 取曲线；不存在返回 null。读缓存与磁盘内容一致（写路径只走本类） */
  load(id: string): PersistedCurve | null {
    const cached = this.cache.get(id);
    if (cached) return cached;
    let raw: string;
    try {
      raw = readFileSync(this.fileFor(id), 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
    const parsed = JSON.parse(raw) as PersistedCurve;
    this.cache.set(id, parsed);
    return parsed;
  }

  /** 全量保存（临时文件 + 原子改名），随后刷新读缓存 */
  save(curve: PersistedCurve): void {
    this.ensureDir();
    const target = this.fileFor(curve.id);
    const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, JSON.stringify(curve), 'utf8');
    renameSync(tmp, target);
    this.cache.set(curve.id, curve);
  }

  /** 列出全部曲线 id（供运维巡检/测试） */
  list(): string[] {
    let entries: string[];
    try {
      entries = readdirSync(this.curvesDir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    return entries
      .filter((name) => name.endsWith('.json'))
      .map((name) => name.slice(0, -'.json'.length))
      .sort();
  }

  /**
   * 丢弃读缓存（进程重启后测试需要）。实际重启是新进程、缓存天然为空；
   * 这个方法只服务于“同一测试进程内模拟重启”。
   */
  resetCache(): void {
    this.cache.clear();
  }
}
