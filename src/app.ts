import express, { type Request, type Response, type NextFunction } from 'express';
import queueRoutes from './routes/queue-routes.js';
import { createCurveRouter } from './routes/curve-routes.js';
import { CurveService } from './timevarying/curve-service.js';
import { JsonStore } from './timevarying/store.js';
import {
  ValidationError,
  NotFoundError,
} from './validation/validation.js';

export interface CreateAppOptions {
  /** 时变负荷层的数据目录；不传则使用 DATA_DIR 环境变量或 ./data */
  dataDir?: string;
}

export function createApp(options: CreateAppOptions = {}) {
  const app = express();
  app.use(express.json({ limit: '256kb' }));

  app.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok' });
  });

  // 三个老接口：无状态、不引用存储，行为与加数据层之前完全一致
  app.use('/api', queueRoutes);

  // 时变负荷接口：自带 JSON 文件持久化，数据目录可注入（测试用临时目录）
  const dataDir = options.dataDir ?? process.env.DATA_DIR ?? './data';
  const curveService = new CurveService(new JsonStore(dataDir));
  app.use('/api', createCurveRouter(curveService));

  // 404
  app.use((req: Request, res: Response) => {
    res.status(404).json({ error: `找不到路由：${req.method} ${req.path}` });
  });

  // 统一错误处理：输入非法统一 400，JSON 解析失败同样按非法请求处理
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ValidationError) {
      res.status(400).json({ error: err.message, field: err.field });
      return;
    }
    if (err instanceof NotFoundError) {
      res.status(404).json({ error: err.message, field: err.field });
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
