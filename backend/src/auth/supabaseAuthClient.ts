import { config } from "../config/env.js";
import {
  ConflictError,
  ServiceUnavailableError,
  TokenInvalidError,
  UnauthorizedError,
  ValidationError,
} from "../errors/AppError.js";

/**
 * A thin, explicit proxy over Supabase's GoTrue REST API. Deliberately not
 * using `@supabase/supabase-js` here: the client SDK is built around
 * managing a session in the browser (the thing docs/target-architecture.md
 * §6 specifically avoids), and a handful of `fetch` calls make the proxy's
 * actual behaviour easy to read end to end.
 */

export type SupabaseSession = Readonly<{
  accessToken: string;
  refreshToken: string;
  /** Seconds until the access token expires, as reported by GoTrue. */
  expiresIn: number;
}>;

export type SupabaseAuthUser = Readonly<{
  id: string;
  email: string;
}>;

export type AuthResult = Readonly<{
  session: SupabaseSession;
  user: SupabaseAuthUser;
}>;

const AUTH_URL = `${config.SUPABASE_URL}/auth/v1`;
const REQUEST_TIMEOUT_MS = 10_000;

async function callGoTrue(
  path: string,
  init: { method: "POST"; body?: unknown; accessToken?: string },
): Promise<{ status: number; body: Record<string, unknown> }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(`${AUTH_URL}${path}`, {
      method: init.method,
      headers: {
        "Content-Type": "application/json",
        apikey: config.SUPABASE_ANON_KEY,
        Authorization: `Bearer ${init.accessToken ?? config.SUPABASE_ANON_KEY}`,
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: controller.signal,
    });

    const text = await res.text();
    let body: Record<string, unknown> = {};
    if (text.length > 0) {
      try {
        body = JSON.parse(text) as Record<string, unknown>;
      } catch {
        // Non-JSON body from an unexpected upstream failure — treated below
        // as an empty body, which falls through to the generic error path.
      }
    }
    return { status: res.status, body };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new ServiceUnavailableError("Authentication service timed out");
    }
    throw new ServiceUnavailableError("Authentication service is unreachable");
  } finally {
    clearTimeout(timeout);
  }
}

function extractMessage(body: Record<string, unknown>, fallback: string): string {
  const candidates = [body.error_description, body.msg, body.message, body.error];
  const found = candidates.find((c): c is string => typeof c === "string" && c.length > 0);
  return found ?? fallback;
}

function parseAuthResult(body: Record<string, unknown>): AuthResult {
  const user = body.user as { id?: unknown; email?: unknown } | undefined;
  if (
    typeof body.access_token !== "string" ||
    typeof body.refresh_token !== "string" ||
    typeof body.expires_in !== "number" ||
    typeof user?.id !== "string" ||
    typeof user?.email !== "string"
  ) {
    throw new ServiceUnavailableError("Authentication service returned an unexpected response");
  }

  return {
    session: {
      accessToken: body.access_token,
      refreshToken: body.refresh_token,
      expiresIn: body.expires_in,
    },
    user: { id: user.id, email: user.email },
  };
}

export async function signUp(
  email: string,
  password: string,
  fullName: string,
): Promise<AuthResult> {
  const { status, body } = await callGoTrue("/signup", {
    method: "POST",
    body: { email, password, data: { full_name: fullName } },
  });

  if (status >= 200 && status < 300) {
    return parseAuthResult(body);
  }

  const message = extractMessage(body, "Could not create account");
  if (status === 422 || /already registered|already exists/i.test(message)) {
    throw new ConflictError("An account with this email already exists");
  }
  throw new ValidationError(message);
}

export async function signInWithPassword(email: string, password: string): Promise<AuthResult> {
  const { status, body } = await callGoTrue("/token?grant_type=password", {
    method: "POST",
    body: { email, password },
  });

  if (status >= 200 && status < 300) {
    return parseAuthResult(body);
  }

  // Generic message regardless of which field was wrong — response timing
  // and content must not reveal whether the account exists.
  throw new UnauthorizedError("Invalid email or password");
}

export async function refreshSession(refreshToken: string): Promise<AuthResult> {
  const { status, body } = await callGoTrue("/token?grant_type=refresh_token", {
    method: "POST",
    body: { refresh_token: refreshToken },
  });

  if (status >= 200 && status < 300) {
    return parseAuthResult(body);
  }

  throw new TokenInvalidError("Session could not be refreshed");
}

export async function signOut(accessToken: string): Promise<void> {
  // Best-effort: GoTrue invalidates the refresh token server-side, but a
  // client that has already cleared its cookies should not be blocked by
  // this failing (e.g. the token already expired naturally).
  try {
    await callGoTrue("/logout?scope=local", { method: "POST", accessToken });
  } catch {
    // intentionally swallowed — logout must always succeed from the caller's perspective
  }
}
