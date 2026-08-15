import { pool } from "../db/client.js";

/** Named `*.repository.ts` so it satisfies the same "only repositories touch
 * the db client directly" ESLint rule as everything else — no special case
 * needed for health checks. */
export async function pingDb(): Promise<boolean> {
  await pool.query("select 1");
  return true;
}
