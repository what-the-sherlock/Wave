import rateLimit from "express-rate-limit";
import type { Request } from "express";
import { config } from "../config/env.js";
import { RateLimitedError } from "../errors/AppError.js";

/**
 * In-process rate limiting, not Redis-backed — the deployment is a single
 * instance on free tier, so there is nothing to share limits across yet
 * (docs/free-tier-plan.md §5). Limits reset on restart, which is an
 * accepted, documented gap that closes if a second instance is ever added
 * (docs/security-model.md §2).
 */
function rejectWithAppError(): never {
  throw new RateLimitedError();
}

/**
 * The integration suite exercises real signup/login flows dozens of times
 * per file, all apparently from the same IP (supertest talks to an
 * in-process server). Scaling limits way up under test — rather than
 * disabling the middleware or faking the client IP — keeps the exact same
 * middleware wired the same way in every environment; only the threshold
 * changes, and production's values are untouched.
 */
function effectiveMax(productionMax: number): number {
  return config.isTest ? productionMax * 1000 : productionMax;
}

/** Exported (not just used internally) so tests can build small, isolated
 * limiter instances rather than sharing the app's singletons and their
 * accumulated state across test cases. */
export function ipLimiter(windowMs: number, max: number) {
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    handler: () => rejectWithAppError(),
  });
}

function normalizedEmail(req: Request): string {
  const email = (req.body as Record<string, unknown> | undefined)?.email;
  return typeof email === "string" ? email.toLowerCase().trim() : "";
}

export function emailLimiter(windowMs: number, max: number) {
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    // Falls back to IP when the body has no email yet (e.g. malformed
    // request) — validation middleware rejects that case separately.
    keyGenerator: (req) => normalizedEmail(req) || req.ip || "unknown",
    handler: () => rejectWithAppError(),
  });
}

/** 5 attempts / 15 min per IP — the concrete Phase 1 requirement:
 * a 6th login attempt within 15 minutes is rejected. */
export const loginIpLimiter = ipLimiter(15 * 60 * 1000, effectiveMax(5));

/** 10 attempts / hour per email — bounds the attack even if it is
 * distributed across many IPs. docs/security-model.md §2. */
export const loginEmailLimiter = emailLimiter(60 * 60 * 1000, effectiveMax(10));

export const signupIpLimiter = ipLimiter(60 * 60 * 1000, effectiveMax(3));

export const refreshIpLimiter = ipLimiter(60 * 60 * 1000, effectiveMax(30));

/** A coarse safety net across the whole API, keyed by IP. Per-user limits
 * are a Phase 4+ refinement once Redis makes cross-instance limits
 * necessary — see docs/security-model.md §2. */
export const globalApiLimiter = ipLimiter(60 * 1000, effectiveMax(300));
