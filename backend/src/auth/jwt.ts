import { jwtVerify, createRemoteJWKSet, errors as joseErrors } from "jose";
import type { JWTPayload } from "jose";
import { config } from "../config/env.js";
import { TokenExpiredError, TokenInvalidError } from "../errors/AppError.js";

export type AccessTokenClaims = JWTPayload & {
  sub: string;
  email?: string;
  role?: string;
};

/**
 * Two verification strategies, chosen once at module load:
 *
 *  - HS256 with `SUPABASE_JWT_SECRET` — for projects still on the legacy
 *    shared-secret signing mode. No network call per request.
 *  - Remote JWKS — the default path. Current Supabase, including local
 *    `supabase start`, signs access tokens with an asymmetric key ("JWT
 *    Signing Keys") by default, so this is what verifies a real token
 *    unless `SUPABASE_JWT_SECRET` is explicitly set for an older project.
 *    `createRemoteJWKSet` caches keys internally, so this is still only a
 *    network call on cache miss, not per request.
 *
 * Setting `SUPABASE_JWT_SECRET` for a project that actually uses
 * asymmetric signing makes every verification fail closed with
 * TOKEN_INVALID (wrong key entirely, not just a mismatched value) — see
 * backend/.env.example.
 *
 * docs/realtime-architecture.md §2, docs/target-architecture.md §6.
 */
const hs256Key = config.SUPABASE_JWT_SECRET
  ? new TextEncoder().encode(config.SUPABASE_JWT_SECRET)
  : null;

const remoteJwks = hs256Key
  ? null
  : createRemoteJWKSet(new URL(`${config.SUPABASE_URL}/auth/v1/.well-known/jwks.json`));

/**
 * Verifies a Supabase access token and returns its claims.
 *
 * Deliberately does not enforce `iss`: local dev frequently has the token's
 * issuer host (e.g. `127.0.0.1`) differ in form from `SUPABASE_URL` (e.g.
 * `localhost`), and getting that mismatch wrong fails closed in a way
 * that's confusing to debug. Signature validity, expiry, and audience are
 * what actually establish trust here.
 *
 * Throws `TokenExpiredError` or `TokenInvalidError` — never returns a
 * falsy value on failure — so callers can distinguish "please refresh" from
 * "please log in again" (the D6 lesson: the original's `jwt.verify` threw
 * on failure but the code checked `if (!decoded)`, which was dead, and
 * every failure fell through to a 500 instead of a 401).
 */
export async function verifyAccessToken(token: string): Promise<AccessTokenClaims> {
  try {
    const { payload } = hs256Key
      ? await jwtVerify(token, hs256Key, { audience: "authenticated" })
      : await jwtVerify(token, remoteJwks!, { audience: "authenticated" });

    if (typeof payload.sub !== "string" || payload.sub.length === 0) {
      throw new TokenInvalidError("Token is missing a subject claim");
    }

    return payload as AccessTokenClaims;
  } catch (err) {
    if (err instanceof TokenInvalidError) throw err;
    if (err instanceof joseErrors.JWTExpired) throw new TokenExpiredError();
    throw new TokenInvalidError();
  }
}
