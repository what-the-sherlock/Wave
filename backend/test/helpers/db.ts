import { Pool } from "pg";

/**
 * Integration tests need a live Supabase stack — local (`supabase start`)
 * or hosted. Rather than failing outright when it's not reachable — which
 * would make `npm test` unusable without one running — tests probe for
 * reachability and skip themselves via `describe.skipIf` when it's absent.
 * Unit tests never depend on this.
 *
 * The timeout is generous enough for a real network hop to a hosted
 * project (cold TLS handshake + auth to a region can comfortably exceed a
 * timeout tuned for local Docker on 127.0.0.1, where it's sub-millisecond)
 * without being so long that a genuinely-down stack makes `npm test` hang.
 */
const REACHABILITY_TIMEOUT_MS = 8000;

export async function isDatabaseReachable(connectionString: string): Promise<boolean> {
  const pool = new Pool({
    connectionString,
    connectionTimeoutMillis: REACHABILITY_TIMEOUT_MS,
    max: 1,
  });
  try {
    await pool.query("select 1");
    return true;
  } catch {
    return false;
  } finally {
    await pool.end().catch(() => undefined);
  }
}

export async function isAuthServiceReachable(
  supabaseUrl: string,
  anonKey: string,
): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REACHABILITY_TIMEOUT_MS);
    // Hosted Supabase routes /auth/v1/* through a gateway that rejects
    // anything without an apikey header — even /health — with 401
    // UNAUTHORIZED_MISSING_API_KEY. The local stack's gateway doesn't
    // enforce this, which is why this was missed initially.
    const res = await fetch(`${supabaseUrl}/auth/v1/health`, {
      signal: controller.signal,
      headers: { apikey: anonKey },
    });
    clearTimeout(timeout);
    return res.ok;
  } catch {
    return false;
  }
}
