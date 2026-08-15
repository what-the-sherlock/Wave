import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { ZodTypeAny } from "zod";

type ValidateTargets = {
  body?: ZodTypeAny;
  params?: ZodTypeAny;
  query?: ZodTypeAny;
};

/**
 * Parses (and coerces/normalizes — trimming, lowercasing emails, etc.) the
 * given request parts against their schemas, replacing them with the
 * parsed result. A schema mismatch throws `ZodError` synchronously, which
 * Express 4 catches automatically for non-async handlers and forwards to
 * `errorMiddleware` — no try/catch needed here.
 */
export function validate(targets: ValidateTargets): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (targets.body) {
      req.body = targets.body.parse(req.body);
    }
    if (targets.params) {
      req.params = targets.params.parse(req.params) as typeof req.params;
    }
    if (targets.query) {
      req.query = targets.query.parse(req.query) as typeof req.query;
    }
    next();
  };
}
