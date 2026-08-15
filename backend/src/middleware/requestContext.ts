import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { requestContext } from "../logging/logger.js";

/**
 * Establishes the AsyncLocalStorage context every subsequent log call in
 * this request (across services, repositories, and eventually socket
 * handlers and queue jobs) reads its `requestId` from. Must be the first
 * middleware registered. docs/scalability.md §8.
 */
export function requestContextMiddleware(req: Request, res: Response, next: NextFunction): void {
  const headerValue = req.headers["x-request-id"];
  const fromHeader = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  const requestId = fromHeader?.trim() || randomUUID();
  res.setHeader("X-Request-Id", requestId);
  requestContext.run({ requestId }, next);
}
