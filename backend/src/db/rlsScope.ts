import type { PoolClient } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { pool } from "./client.js";
import * as schema from "./schema.js";

export type Scope = Readonly<{ userId: string }>;

export type Tx = NodePgDatabase<typeof schema>;

/**
 * Runs `fn` inside a Postgres transaction scoped to the given user.
 *
 * `set_config('role', ...)` is Postgres's underlying mechanism for `SET
 * LOCAL ROLE` — it is what actually lets subsequent queries run with the
 * `authenticated` role's grants. `set_config('request.jwt.claims', ...)` is
 * what `auth.uid()` reads inside RLS policies. Both use the third `is_local
 * = true` argument, which is **transaction-local** — this is the detail
 * that keeps RLS scope from leaking between requests that share a pooled
 * connection under Supavisor transaction-mode pooling (a session-level SET
 * would bleed across users). docs/security-model.md §4, §7.2.
 */
export async function withRlsScope<T>(
  scope: Scope,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  const client: PoolClient = await pool.connect();
  try {
    await client.query("BEGIN");
    try {
      await client.query(`select set_config('role', 'authenticated', true)`);
      await client.query(`select set_config('request.jwt.claims', $1, true)`, [
        JSON.stringify({ sub: scope.userId, role: "authenticated" }),
      ]);

      const tx = drizzle(client, { schema });
      const result = await fn(tx);

      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    }
  } finally {
    client.release();
  }
}

/**
 * Runs `fn` as the `service_role` Postgres role, which bypasses RLS
 * entirely. Not called from anywhere yet in Phase 1 — the worker that will
 * use it arrives in Phase 5 — but it lives here, next to `withRlsScope`, so
 * the two privilege boundaries are defined and tested in one place rather
 * than the bypass path being invented ad hoc later. docs/security-model.md §5.
 */
export async function withServiceRoleScope<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client: PoolClient = await pool.connect();
  try {
    await client.query("BEGIN");
    try {
      await client.query(`select set_config('role', 'service_role', true)`);

      const tx = drizzle(client, { schema });
      const result = await fn(tx);

      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    }
  } finally {
    client.release();
  }
}
