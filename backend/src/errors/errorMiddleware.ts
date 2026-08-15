import type { ErrorRequestHandler, RequestHandler } from "express";
import { ZodError } from "zod";
import { AppError } from "./AppError.js";
import { getRequestId, logger } from "../logging/logger.js";

/** Unmatched routes get a clean JSON 404, never an HTML fallback. */
export const notFoundMiddleware: RequestHandler = (req, res) => {
  res.status(404).json({
    code: "NOT_FOUND",
    message: `No route for ${req.method} ${req.path}`,
    requestId: getRequestId(),
  });
};

/**
 * The single place HTTP errors become responses. Must be registered last,
 * after every route (docs/target-architecture.md §7). Express only
 * recognizes a handler as error-handling middleware if it declares exactly
 * four parameters, so `_req` and `_next` stay even though unused.
 */
export const errorMiddleware: ErrorRequestHandler = (err, _req, res, _next) => {
  const requestId = getRequestId();

  if (err instanceof ZodError) {
    res.status(400).json({
      code: "VALIDATION_ERROR",
      message: "Validation failed",
      details: err.flatten(),
      requestId,
    });
    return;
  }

  if (err instanceof AppError) {
    if (err.statusCode >= 500) {
      logger.error({ err, requestId }, err.message);
    }
    res.status(err.statusCode).json({
      code: err.code,
      message: err.message,
      ...(err.details !== undefined ? { details: err.details } : {}),
      requestId,
    });
    return;
  }

  logger.error({ err, requestId }, "Unhandled error");
  res.status(500).json({
    code: "INTERNAL",
    message: "Something went wrong",
    requestId,
  });
};
