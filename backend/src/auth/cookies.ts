import type { Response } from "express";
import { config } from "../config/env.js";
import type { SupabaseSession } from "./supabaseAuthClient.js";

/**
 * The access token stays httpOnly and unreadable by page JavaScript — the
 * one thing the original app got right (docs/current-architecture.md §10)
 * and what makes the Socket.IO handshake authenticatable at all
 * (docs/realtime-architecture.md §2). `sameSite: strict` is what makes CSRF
 * a non-issue without needing separate CSRF tokens.
 */
export const ACCESS_COOKIE_NAME = "sb-access";
export const REFRESH_COOKIE_NAME = "sb-refresh";

/** Scoped to the refresh endpoint only — it is not attached to ordinary API
 * requests, so it is not exposed to every handler, proxy log, or error
 * report (docs/security-model.md §2). */
const REFRESH_COOKIE_PATH = "/api/v1/auth/refresh";

/** Our own session-length policy — Supabase's refresh token itself doesn't
 * expire on a fixed schedule, but the cookie carrying it should. Reissued
 * on every successful refresh, so this is a sliding window. */
const REFRESH_COOKIE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

function baseCookieOptions() {
  return {
    httpOnly: true,
    sameSite: "strict" as const,
    secure: config.secureCookies,
    ...(config.COOKIE_DOMAIN ? { domain: config.COOKIE_DOMAIN } : {}),
  };
}

export function setSessionCookies(res: Response, session: SupabaseSession): void {
  res.cookie(ACCESS_COOKIE_NAME, session.accessToken, {
    ...baseCookieOptions(),
    path: "/",
    maxAge: session.expiresIn * 1000,
  });
  res.cookie(REFRESH_COOKIE_NAME, session.refreshToken, {
    ...baseCookieOptions(),
    path: REFRESH_COOKIE_PATH,
    maxAge: REFRESH_COOKIE_MAX_AGE_MS,
  });
}

/**
 * Attributes must match what the cookie was set with (aside from
 * maxAge/expires) or the browser will not recognize it as the same cookie
 * to clear. The original app's `logout` cleared its cookie with different
 * attributes than it was set with — it only worked because no `path` or
 * `domain` was ever introduced (D18).
 */
export function clearSessionCookies(res: Response): void {
  res.clearCookie(ACCESS_COOKIE_NAME, { ...baseCookieOptions(), path: "/" });
  res.clearCookie(REFRESH_COOKIE_NAME, { ...baseCookieOptions(), path: REFRESH_COOKIE_PATH });
}

export function readAccessToken(req: { cookies?: Record<string, string> }): string | undefined {
  return req.cookies?.[ACCESS_COOKIE_NAME];
}

export function readRefreshToken(req: { cookies?: Record<string, string> }): string | undefined {
  return req.cookies?.[REFRESH_COOKIE_NAME];
}
