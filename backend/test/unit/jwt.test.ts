import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  signExpiredAccessToken,
  signInvalidAccessToken,
  signTestAccessToken,
} from "../helpers/jwt.js";

/**
 * `src/auth/jwt.ts` picks its verification strategy (HS256 vs. remote
 * JWKS) once, from `config.SUPABASE_JWT_SECRET`, at module load. To test
 * the HS256 path in isolation — without leaking `SUPABASE_JWT_SECRET` into
 * every other test file sharing this worker process, which would break
 * the integration suite's real (JWKS-signed) tokens — this file sets the
 * env var, forces a fresh module evaluation with `vi.resetModules()`, and
 * tears both down afterwards.
 */
const TEST_SECRET = "unit-test-only-jwt-secret-not-for-production-use-000000";

describe("verifyAccessToken (HS256 path, isolated)", () => {
  let verifyAccessToken: typeof import("../../src/auth/jwt.js").verifyAccessToken;
  // Re-imported fresh alongside jwt.js, from the same post-reset module
  // graph — comparing against the statically-imported classes at the top
  // of this file would compare instances across two different module
  // instances of AppError.js and every `instanceof` check would fail,
  // since `vi.resetModules()` gives jwt.js's transitive import of
  // AppError.js a distinct class identity from the one this file would
  // otherwise import statically.
  let TokenExpiredError: typeof import("../../src/errors/AppError.js").TokenExpiredError;
  let TokenInvalidError: typeof import("../../src/errors/AppError.js").TokenInvalidError;

  beforeEach(async () => {
    vi.resetModules();
    process.env.SUPABASE_JWT_SECRET = TEST_SECRET;
    ({ verifyAccessToken } = await import("../../src/auth/jwt.js"));
    ({ TokenExpiredError, TokenInvalidError } = await import("../../src/errors/AppError.js"));
  });

  afterEach(() => {
    delete process.env.SUPABASE_JWT_SECRET;
    vi.resetModules();
  });

  it("returns the claims of a validly signed, unexpired token", async () => {
    const token = await signTestAccessToken("11111111-1111-4111-8111-111111111111", {
      email: "alice@example.com",
    });
    const claims = await verifyAccessToken(token);
    expect(claims.sub).toBe("11111111-1111-4111-8111-111111111111");
    expect(claims.email).toBe("alice@example.com");
  });

  it("throws TokenExpiredError — not a 500-inducing generic error — for an expired token", async () => {
    const token = await signExpiredAccessToken("22222222-2222-4222-8222-222222222222");
    await expect(verifyAccessToken(token)).rejects.toBeInstanceOf(TokenExpiredError);
  });

  it("throws TokenInvalidError for a token signed with the wrong secret", async () => {
    const token = await signInvalidAccessToken("33333333-3333-4333-8333-333333333333");
    await expect(verifyAccessToken(token)).rejects.toBeInstanceOf(TokenInvalidError);
  });

  it("throws TokenInvalidError for garbage input", async () => {
    await expect(verifyAccessToken("not-a-jwt-at-all")).rejects.toBeInstanceOf(TokenInvalidError);
  });

  it("throws TokenInvalidError for an empty string", async () => {
    await expect(verifyAccessToken("")).rejects.toBeInstanceOf(TokenInvalidError);
  });
});
