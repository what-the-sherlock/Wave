import { Router } from "express";
import { pingDb } from "./health.repository.js";
import { logger } from "../logging/logger.js";

export const healthRouter = Router();

/**
 * Liveness: "is this process wedged?" No dependency checks — a database
 * blip must never restart every instance, or a partial degradation becomes
 * a total outage. docs/scalability.md §8.
 */
healthRouter.get("/healthz", (_req, res) => {
  res.status(200).json({ status: "ok" });
});

/** Readiness: "should the load balancer send traffic here?" */
healthRouter.get("/readyz", async (_req, res) => {
  try {
    await pingDb();
    res.status(200).json({ status: "ok" });
  } catch (err) {
    logger.warn({ err }, "readiness check failed: database unreachable");
    res.status(503).json({ status: "unavailable" });
  }
});
