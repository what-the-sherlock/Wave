import express, { type Express } from "express";
import cookieParser from "cookie-parser";
import cors from "cors";
import helmet from "helmet";
import { pinoHttp } from "pino-http";
import { config } from "./config/env.js";
import { getRequestId, logger } from "./logging/logger.js";
import { requestContextMiddleware } from "./middleware/requestContext.js";
import { globalApiLimiter } from "./middleware/rateLimit.js";
import { errorMiddleware, notFoundMiddleware } from "./errors/errorMiddleware.js";
import { authRouter } from "./auth/auth.routes.js";
import { profileRouter } from "./profiles/profile.routes.js";
import { healthRouter } from "./health/health.routes.js";

/**
 * Composition root for the HTTP layer. Deliberately separate from
 * `server.ts` (which owns the http.Server + Socket.IO wiring) so tests can
 * exercise the Express app with supertest without opening a real socket —
 * and so construction order is `dotenv → config → app → server`, unlike
 * the original app, where `lib/socket.js` constructed `app`/`server` before
 * `dotenv.config()` had run (D16).
 */
export function createApp(): Express {
  const app = express();

  // Deployed behind a platform proxy (Fly.io/Railway) — required for
  // req.ip (and therefore rate limiting) to reflect the real client.
  app.set("trust proxy", 1);

  app.use(requestContextMiddleware);

  app.use(
    pinoHttp({
      logger,
      genReqId: () => getRequestId() ?? "unknown",
      customLogLevel: (_req, res, err) => {
        if (err || res.statusCode >= 500) return "error";
        if (res.statusCode >= 400) return "warn";
        return "info";
      },
    }),
  );

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          imgSrc: ["'self'", "data:"],
          connectSrc: ["'self'"],
          frameAncestors: ["'none'"],
          objectSrc: ["'none'"],
        },
      },
    }),
  );

  app.use(
    cors({
      origin: [...config.CORS_ORIGINS],
      credentials: true,
    }),
  );

  app.use(cookieParser());
  // 256kb, chosen deliberately rather than inherited by accident — large
  // enough for a long message with many mentions, nowhere near enough to
  // smuggle a file through JSON the way the original app's default 100kb
  // limit accidentally did (and still failed at, D7).
  app.use(express.json({ limit: "256kb" }));

  // Unversioned, unauthenticated, not rate-limited — a load balancer must
  // always be able to reach these.
  app.use(healthRouter);

  app.use("/api/v1", globalApiLimiter);
  app.use("/api/v1/auth", authRouter);
  app.use("/api/v1/profile", profileRouter);

  app.use(notFoundMiddleware);
  app.use(errorMiddleware);

  return app;
}
