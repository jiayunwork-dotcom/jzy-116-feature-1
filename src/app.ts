import express, { type Request, type Response, type NextFunction } from 'express';
import queueRoutes from './routes/queue-routes.js';
import { ValidationError } from './validation/validation.js';
import { JsonCurveStore } from './timvar/storage.js';
import { LoadCurveService } from './timvar/service.js';
import { createTimvarRouter } from './timvar/routes.js';
import { TimvarValidationError } from './timvar/validation.js';
import { NotFoundError } from './timvar/service.js';

/**
 * 应用装配。
 *
 * dataDir 可选：只有时变负荷接口会用到持久化；不传时取环境变量
 * TIMVAR_DATA_DIR，再缺省落到进程工作目录下的 ./data。老的三个接口
 * （analytic / simulation / compare）完全不触碰存储，注入失败或目录
 * 不可写都不影响它们。
 */
export function createApp(options: { dataDir?: string } = {}) {
  const app = express();
  app.use(express.json({ limit: '256kb' }));

  app.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok' });
  });

  // 时变负荷接口（独立模块、独立路由、独立持久化）
  const dataDir = options.dataDir ?? process.env.TIMVAR_DATA_DIR ?? 'data';
  const store = new JsonCurveStore(dataDir);
  const timvarService = new LoadCurveService(store);
  app.use('/api', createTimvarRouter(timvarService));

  // 既有三个无状态接口
  app.use('/api', queueRoutes);

  // 404
  app.use((req: Request, res: Response) => {
    res.status(404).json({ error: `找不到路由：${req.method} ${req.path}` });
  });

  // 统一错误处理：输入非法统一 400，JSON 解析失败同样按非法请求处理
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    // 时变模块的字段级错误：在老的 error 字符串之外额外给出 fields 说明
    if (err instanceof TimvarValidationError) {
      res.status(400).json({ error: err.message, fields: err.fields });
      return;
    }
    // 时变模块引用不存在的曲线 / 版本
    if (err instanceof NotFoundError) {
      res.status(404).json({ error: err.message });
      return;
    }
    if (err instanceof ValidationError) {
      res.status(400).json({ error: err.message });
      return;
    }
    if (err instanceof SyntaxError && 'body' in err) {
      res.status(400).json({ error: '请求体不是合法 JSON' });
      return;
    }
    const message = err instanceof Error ? err.message : '内部错误';
    res.status(500).json({ error: message });
  });

  return app;
}
