/**
 * 时变负荷（负荷曲线）HTTP 接口。与老的 /api/analytic|simulation|compare
 * 完全独立：老接口保持无状态、不碰存储；本路由文件只负责 HTTP 适配，
 * 领域逻辑在 timevarying/ 下按职责拆开。
 */
import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { CurveService } from '../timevarying/curve-service.js';
import {
  validateComputationBody,
  validateCurveId,
  validateRegisterBody,
  validateSeedNumber,
  validateVersionBody,
  validateVersionNumber,
} from '../timevarying/validation.js';

export function createCurveRouter(service: CurveService): Router {
  const router = Router();

  /** 把 async 处理器里抛出的错误转交给 Express 错误中间件 */
  function wrap(
    fn: (req: Request, res: Response) => Promise<void> | void,
  ) {
    return (req: Request, res: Response, next: NextFunction) => {
      Promise.resolve(fn(req, res)).catch(next);
    };
  }

  // POST /api/curves —— 登记曲线（同时得到 version=1）
  router.post(
    '/curves',
    wrap(async (req, res) => {
      const body = validateRegisterBody((req.body ?? {}) as Record<string, unknown>);
      const curve = await service.registerCurve(body);
      res.status(201).json(curve);
    }),
  );

  // GET /api/curves —— 曲线清单
  router.get(
    '/curves',
    wrap(async (_req, res) => {
      res.json({ curves: await service.listCurves() });
    }),
  );

  // GET /api/curves/:curveId —— 曲线档案（含全部版本）
  router.get(
    '/curves/:curveId',
    wrap(async (req, res) => {
      const curveId = validateCurveId(req.params.curveId);
      res.json(await service.getCurve(curveId));
    }),
  );

  // POST /api/curves/:curveId/versions —— 基于档案创建新版本
  router.post(
    '/curves/:curveId/versions',
    wrap(async (req, res) => {
      const curveId = validateCurveId(req.params.curveId);
      const curve = await service.getCurve(curveId);
      const body = validateVersionBody(
        (req.body ?? {}) as Record<string, unknown>,
        curve.mu,
      );
      const updated = await service.createVersion(curveId, body);
      res.status(201).json(
        updated.versions.find((v) => v.version === updated.versions.length),
      );
    }),
  );

  // GET /api/curves/:curveId/versions/:version —— 调出任一版本
  router.get(
    '/curves/:curveId/versions/:version',
    wrap(async (req, res) => {
      const curveId = validateCurveId(req.params.curveId);
      const version = validateVersionNumber(req.params.version);
      const curve = await service.getCurve(curveId);
      res.json(service.getVersion(curve, version));
    }),
  );

  // POST /api/curves/:curveId/versions/:version/computations —— 发起/取核算
  router.post(
    '/curves/:curveId/versions/:version/computations',
    wrap(async (req, res) => {
      const curveId = validateCurveId(req.params.curveId);
      const version = validateVersionNumber(req.params.version);
      const { seed } = validateComputationBody(
        (req.body ?? {}) as Record<string, unknown>,
      );
      const { record, created } = await service.runComputation(
        curveId,
        version,
        seed,
      );
      res.status(created ? 201 : 200).json(record);
    }),
  );

  // GET /api/curves/:curveId/versions/:version/computations/:seed —— 按版本查结果
  router.get(
    '/curves/:curveId/versions/:version/computations/:seed',
    wrap(async (req, res) => {
      const curveId = validateCurveId(req.params.curveId);
      const version = validateVersionNumber(req.params.version);
      const seed = validateSeedNumber(req.params.seed);
      res.json(await service.getComputation(curveId, version, seed));
    }),
  );

  // GET /api/curves/:curveId/computations —— 该曲线全部核算存档清单
  router.get(
    '/curves/:curveId/computations',
    wrap(async (req, res) => {
      const curveId = validateCurveId(req.params.curveId);
      res.json({ computations: await service.listComputations(curveId) });
    }),
  );

  return router;
}
