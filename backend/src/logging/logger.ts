import { AsyncLocalStorage } from "node:async_hooks";
import pino from "pino";
import { config } from "../config/env.js";

/**
 * Carries the current request's id through async call chains — service
 * calls, repository calls, and (from Phase 4+) socket handlers and queue
 * jobs — without threading it through every function signature.
 * docs/scalability.md §8.
 */
export const requestContext = new AsyncLocalStorage<{ requestId: string }>();

export function getRequestId(): string | undefined {
  return requestContext.getStore()?.requestId;
}

/**
 * Structured JSON logging (replacing the original's ~15 unstructured
 * `console.log` calls — docs/current-architecture.md D25). Redaction is
 * configured here, once, so no call site can accidentally log a credential.
 */
export const logger = pino({
  level: config.LOG_LEVEL,
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers.cookie",
      'res.headers["set-cookie"]',
      "password",
      "*.password",
      "token",
      "*.token",
      "accessToken",
      "*.accessToken",
      "refreshToken",
      "*.refreshToken",
      "serviceRoleKey",
      "*.serviceRoleKey",
    ],
    censor: "[REDACTED]",
  },
  mixin() {
    const requestId = getRequestId();
    return requestId ? { requestId } : {};
  },
  ...(config.NODE_ENV === "development"
    ? {
        transport: {
          target: "pino-pretty",
          options: { colorize: true, translateTime: "HH:MM:ss", ignore: "pid,hostname" },
        },
      }
    : {}),
});

export type Logger = typeof logger;
