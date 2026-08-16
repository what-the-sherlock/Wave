import { sql } from "drizzle-orm";
import type { Tx } from "../db/rlsScope.js";

export type QueueCount = { name: string; state: string; count: number };

/** Raw query against pg-boss's own `pgboss` schema — it has no RLS/grants
 * for the `authenticated` role, so this must run under service_role
 * (docs/security-model.md §5). */
export async function getQueueCounts(tx: Tx): Promise<QueueCount[]> {
  const result = await tx.execute<{ name: string; state: string; count: string }>(sql`
    select name, state, count(*) as count
      from pgboss.job
     where created_on > now() - interval '24 hours'
     group by name, state
     order by name, state
  `);
  return result.rows.map((r) => ({ name: r.name, state: r.state, count: Number(r.count) }));
}
