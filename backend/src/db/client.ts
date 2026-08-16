import { Pool, types } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { config } from "../config/env.js";
import { logger } from "../logging/logger.js";
import * as schema from "./schema.js";

/**
 * `pg`'s type-parser registry is process-global, not per-`Pool` — this runs
 * once, on first import of this module, and applies to every query on
 * every connection afterward, including the raw `tx.execute(sql...)` calls
 * `send_message()` goes through (docs/database-design.md §7), which bypass
 * Drizzle's own column typing entirely. Without it, `messages.seq` (a
 * Postgres `bigint`, OID 20) comes back as a *string* from those raw calls
 * but as a genuine `number` from Drizzle query-builder reads — the same
 * column, two different JSON shapes depending on which code path served
 * the request. `pg` defaults bigint to string specifically to avoid
 * precision loss above 2^53, but a per-channel message sequence realistically
 * never approaches that, so parsing it as a number here — matching the
 * `{ mode: "number" }` already declared on these columns in `db/schema.ts`
 * — is safe and keeps the API contract consistent everywhere.
 */
types.setTypeParser(20 /* int8 */, (value: string) => parseInt(value, 10));

/**
 * A small per-instance pool against the Supavisor transaction-mode pooler —
 * intentionally conservative so that (pool size × instance count) stays
 * comfortably under the free-tier connection ceiling (docs/scalability.md
 * §2, docs/free-tier-plan.md §2).
 */
export const pool = new Pool({
  connectionString: config.DATABASE_URL,
  max: config.isTest ? 5 : 10,
});

pool.on("error", (err) => {
  // A background/idle client error must not crash the process — log and
  // let the pool recover the connection on next checkout.
  logger.error({ err }, "unexpected error on idle pg client");
});

export const db = drizzle(pool, { schema });

export async function closeDb(): Promise<void> {
  await pool.end();
}
