import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { config } from "../config/env.js";
import { logger } from "../logging/logger.js";
import * as schema from "./schema.js";

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
