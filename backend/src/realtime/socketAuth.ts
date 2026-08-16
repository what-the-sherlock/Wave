import type { Socket } from "socket.io";
import { ACCESS_COOKIE_NAME } from "../auth/cookies.js";
import { verifyAccessToken, type AccessTokenClaims } from "../auth/jwt.js";

export type AuthenticatedSocketData = {
  claims: AccessTokenClaims;
};

export function parseCookieHeader(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const separatorIndex = part.indexOf("=");
    if (separatorIndex === -1) continue;
    const key = part.slice(0, separatorIndex).trim();
    const rawValue = part.slice(separatorIndex + 1).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(rawValue);
    } catch {
      out[key] = rawValue;
    }
  }
  return out;
}

/**
 * The D1 fix, made concrete: identity comes from a cryptographically
 * verified access token carried in the httpOnly `sb-access` cookie —
 * automatically attached by the browser on the same origin — never from
 * `socket.handshake.query`, which the original app trusted verbatim,
 * letting any client claim to be any user id by passing their `_id` in the
 * connection query string (docs/current-architecture.md D1,
 * docs/realtime-architecture.md §2).
 *
 * Rejects with a generic "UNAUTHORIZED" error rather than distinguishing
 * expired vs. invalid — a socket handshake has no cookie-refresh path of
 * its own; the client is expected to hold a fresh access token before
 * connecting (refreshed via the same REST interceptor that guards regular
 * API calls) and simply reconnect after a successful refresh.
 */
export async function socketAuthMiddleware(
  socket: Socket,
  next: (err?: Error) => void,
): Promise<void> {
  try {
    const cookies = parseCookieHeader(socket.handshake.headers.cookie);
    const token = cookies[ACCESS_COOKIE_NAME];
    if (!token) {
      next(new Error("UNAUTHORIZED"));
      return;
    }
    const claims = await verifyAccessToken(token);
    (socket.data as AuthenticatedSocketData).claims = claims;
    next();
  } catch {
    next(new Error("UNAUTHORIZED"));
  }
}

/**
 * Re-checks the same `sb-access` cookie captured at handshake time against
 * the current clock, so a socket authenticated with a token that later
 * expires does not stay connected indefinitely — `socket.ts` runs this on a
 * 15-minute interval and disconnects on failure
 * (docs/realtime-architecture.md §2). The handshake cookie header is fixed
 * for the lifetime of the connection (Socket.IO does not re-read it), which
 * is exactly what makes this a check of the original token's expiry rather
 * than a way to pick up a refreshed one — the client is expected to
 * reconnect after a refresh, same as at the initial handshake.
 */
export async function reverifySocket(socket: Socket): Promise<boolean> {
  try {
    const cookies = parseCookieHeader(socket.handshake.headers.cookie);
    const token = cookies[ACCESS_COOKIE_NAME];
    if (!token) return false;
    const claims = await verifyAccessToken(token);
    (socket.data as AuthenticatedSocketData).claims = claims;
    return true;
  } catch {
    return false;
  }
}
