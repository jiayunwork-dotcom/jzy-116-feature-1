import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { LoadCurveService, NotFoundError } from './service.js';
import {
  parseRegisterInput,
  parseAddVersionInput,
  validateCurveId,
  validateVersion,
  TimvarValidationError,
} from './validation.js';

/**
 * 时变负荷接口路由。
 *
 * 路径一览（全部在 /api 下挂载）：
 *   POST   /curves                         登记曲线（含第 1 版）
 *   GET    /curves                          列出曲线
 *   GET    /curves/:curveId                 取曲线（含全部版本摘要）
 *   POST   /curves/:curveId/versions        新增版本
 *   GET    /curves/:curveId/versions/:v     取指定版本的时段表
 *   POST   /curves/:curveId/versions/:v/computation   发起/取回核算
 *   GET    /curves/:curveId/versions/:v/computation   查询核算结果（404=未核算）
 *
 * 核算请求体可选 { "forceFull": true }：只读地从头完整核算一遍，不落盘，
 * 专门用于核对“增量结果 == 完整重算”。正常使用不需要传。
 */
export function createTimvarRouter(service: LoadCurveService): Router {
  const router = Router();

  router.post('/curves', (req: Request, res: Response, next: NextFunction) => {
    try {
      const input = parseRegisterInput(req.body ?? {});
      const curve = service.register(input);
      res.status(201).json({ curve });
    } catch (err) {
      next(err);
    }
  });

  router.get('/curves', (_req: Request, res: Response) => {
    res.json({ curves: service.listCurves() });
  });

  router.get(
    '/curves/:curveId',
    (req: Request, res: Response, next: NextFunction) => {
      try {
        const curveId = validateCurveId(req.params.curveId);
        res.json({ curve: service.getCurve(curveId) });
      } catch (err) {
        next(err);
      }
    },
  );

  router.post(
    '/curves/:curveId/versions',
    (req: Request, res: Response, next: NextFunction) => {
      try {
        const curveId = validateCurveId(req.params.curveId);
        const input = parseAddVersionInput(req.body ?? {});
        const version = service.addVersion(curveId, input.segments);
        res.status(201).json({ curveId, version });
      } catch (err) {
        next(err);
      }
    },
  );

  router.get(
    '/curves/:curveId/versions/:version',
    (req: Request, res: Response, next: NextFunction) => {
      try {
        const curveId = validateCurveId(req.params.curveId);
        const version = validateVersion(Number(req.params.version));
        res.json({ curveId, version: service.getVersion(curveId, version) });
      } catch (err) {
        next(err);
      }
    },
  );

  function handleCompute(req: Request, res: Response, next: NextFunction) {
    try {
      const curveId = validateCurveId(req.params.curveId);
      const version = validateVersion(Number(req.params.version));
      let forceFull = false;
      if (req.body !== undefined && req.body !== null) {
        if (typeof req.body !== 'object') {
          throw new TimvarValidationError({ body: '请求体必须是对象' });
        }
        if ('forceFull' in req.body && typeof req.body.forceFull !== 'boolean') {
          throw new TimvarValidationError({ forceFull: '必须是布尔值' });
        }
        forceFull = req.body.forceFull === true;
      }
      const result = service.compute(curveId, version, { forceFull });
      res.json({
        curveId,
        alreadyComputed: result.alreadyComputed,
        computation: result.computation,
      });
    } catch (err) {
      next(err);
    }
  }

  router.post('/curves/:curveId/versions/:version/computation', handleCompute);

  router.get(
    '/curves/:curveId/versions/:version/computation',
    (req: Request, res: Response, next: NextFunction) => {
      try {
        const curveId = validateCurveId(req.params.curveId);
        const version = validateVersion(Number(req.params.version));
        const computation = service.getComputation(curveId, version);
        if (!computation) {
          throw new NotFoundError(
            `曲线 ${curveId} 版本 ${version} 尚未核算`,
          );
        }
        res.json({ curveId, computation });
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
