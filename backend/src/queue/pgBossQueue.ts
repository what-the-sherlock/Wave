import { Client } from "pg";
import { PgBoss, fromDrizzle, type SendOptions as PgBossSendOptions, type Job } from "pg-boss";
import { sql } from "drizzle-orm";
import { config } from "../config/env.js";
import { logger } from "../logging/logger.js";
import type { Tx } from "../db/rlsScope.js";
import type { EnqueueOptions, JobHandler, Queue } from "./queue.js";

/** Fixed, known queue names — created once at `start()` so `send`/`work`
 * never race a missing queue. Per-queue retry defaults live here, next to
 * the names, rather than scattered at each call site. */
const QUEUE_DEFAULTS: Record<string, { retryLimit: number; retryDelay: number; retryBackoff?: boolean }> = {
  "notification.fanout": { retryLimit: 5, retryDelay: 10 },
  "email.send": { retryLimit: 5, retryDelay: 30 },
  "attachment.process": { retryLimit: 5, retryDelay: 10 },
  "cleanup.orphans": { retryLimit: 2, retryDelay: 60 },
  "embedding.generate": { retryLimit: 5, retryDelay: 10 },
  // Exponential backoff — a Groq 429 is retried with increasing delay
  // rather than a fixed one, so the free-tier rate limit is smoothed out
  // rather than hammered (docs/free-tier-plan.md §4, docs/ai-
  // architecture.md's "provider 429 never reaches the user" DoD item).
  "ai.process": { retryLimit: 5, retryDelay: 5, retryBackoff: true },
};

/**
 * Only includes keys the caller actually set. pg-boss's own option
 * validation asserts on `retryLimit`/`retryDelay` (e.g. "retryDelay must be
 * an integer >= 0") as soon as the *key* is present, even when its value is
 * `undefined` — building the object unconditionally (`{ retryDelay:
 * opts?.retryDelay }`) therefore throws on every call that doesn't
 * explicitly pass one, which is most of them (they're meant to fall back to
 * the per-queue defaults registered in `QUEUE_DEFAULTS` at `start()`).
 * Found by actually running the app end-to-end with `RUN_WORKERS=true` —
 * every prior queue call in this codebase happened to go through
 * `noopQueue` in tests, so this never surfaced there.
 */
function toSendOptions(opts?: EnqueueOptions): PgBossSendOptions {
  const sendOptions: PgBossSendOptions = {};
  if (opts?.startAfterSeconds !== undefined) sendOptions.startAfter = opts.startAfterSeconds;
  if (opts?.singletonKey !== undefined) sendOptions.singletonKey = opts.singletonKey;
  if (opts?.retryLimit !== undefined) sendOptions.retryLimit = opts.retryLimit;
  if (opts?.retryDelay !== undefined) sendOptions.retryDelay = opts.retryDelay;
  return sendOptions;
}

/**
 * pg-boss-backed `Queue`. Uses its own connection
 * (`config.PGBOSS_DATABASE_URL`), separate from the request-scoped pool in
 * `db/client.ts` — pg-boss's polling/maintenance loop needs a session-pinned
 * connection that Supavisor's transaction-mode pooler cannot provide
 * (docs/free-tier-plan.md §5).
 */
export class PgBossQueue implements Queue {
  private readonly boss: PgBoss;
  private started = false;

  constructor() {
    this.boss = new PgBoss({
      connectionString: config.PGBOSS_DATABASE_URL,
      schema: "pgboss",
    });
    this.boss.on("error", (err: Error) => {
      logger.error({ err }, "pg-boss error");
    });
  }

  async start(): Promise<void> {
    await this.boss.start();
    for (const [name, defaults] of Object.entries(QUEUE_DEFAULTS)) {
      await this.boss.createQueue(name, defaults);
    }
    // Hourly orphan sweep — cleanupOrphans.worker.ts also enforces the
    // 500MB database-size warning on the same cadence.
    await this.boss.schedule("cleanup.orphans", "0 * * * *", {});
    await this.grantAuthenticatedAccess();
    this.started = true;
  }

  /**
   * `sendTx()` deliberately writes a job through the CALLER's own
   * transaction — running as the `authenticated` role, not this queue's own
   * `PGBOSS_DATABASE_URL` connection — so "insert the message and enqueue
   * its fan-out atomically" actually is one transaction
   * (docs/realtime-architecture.md §5). But pg-boss provisions its own
   * `pgboss` schema itself, at this `start()` call, not via a Supabase
   * migration — so a migration-time `grant` can never reliably apply (the
   * schema doesn't exist yet on a fresh environment when migrations run,
   * before the app has ever booted). Granting it here, immediately after
   * pg-boss finishes creating that schema, is the only ordering that's
   * always correct regardless of deploy sequence. Idempotent — safe to run
   * on every boot, not just the first.
   */
  private async grantAuthenticatedAccess(): Promise<void> {
    const client = new Client({ connectionString: config.PGBOSS_DATABASE_URL });
    await client.connect();
    try {
      await client.query("grant usage on schema pgboss to authenticated");
      await client.query("grant select, insert, update on all tables in schema pgboss to authenticated");
      // No explicit `FOR ROLE` clause — defaults to the connecting role
      // (whichever role PGBOSS_DATABASE_URL specifies), the same role that
      // creates pg-boss's own tables, including future dated
      // `queue_stats_YYYYMMDD` partitions.
      await client.query(
        "alter default privileges in schema pgboss grant select, insert, update on tables to authenticated",
      );
    } finally {
      await client.end();
    }
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    await this.boss.stop({ graceful: true });
    this.started = false;
  }

  async send<T extends object>(queueName: string, data: T, opts?: EnqueueOptions): Promise<void> {
    await this.boss.send(queueName, data, toSendOptions(opts));
  }

  async sendTx<T extends object>(
    tx: Tx,
    queueName: string,
    data: T,
    opts?: EnqueueOptions,
  ): Promise<void> {
    await this.boss.send(queueName, data, {
      ...toSendOptions(opts),
      db: fromDrizzle(tx, sql),
    });
  }

  async work<T extends object>(queueName: string, handler: JobHandler<T>): Promise<void> {
    await this.boss.work<T>(queueName, async (jobs: Job<T>[]) => {
      for (const job of jobs) {
        await handler(job.data, job.id);
      }
    });
  }
}
