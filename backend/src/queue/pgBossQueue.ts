import { PgBoss, fromDrizzle, type SendOptions as PgBossSendOptions, type Job } from "pg-boss";
import { sql } from "drizzle-orm";
import { config } from "../config/env.js";
import { logger } from "../logging/logger.js";
import type { Tx } from "../db/rlsScope.js";
import type { EnqueueOptions, JobHandler, Queue } from "./queue.js";

/** Fixed, known queue names — created once at `start()` so `send`/`work`
 * never race a missing queue. Per-queue retry defaults live here, next to
 * the names, rather than scattered at each call site. */
const QUEUE_DEFAULTS: Record<string, { retryLimit: number; retryDelay: number }> = {
  "notification.fanout": { retryLimit: 5, retryDelay: 10 },
  "email.send": { retryLimit: 5, retryDelay: 30 },
  "attachment.process": { retryLimit: 5, retryDelay: 10 },
  "cleanup.orphans": { retryLimit: 2, retryDelay: 60 },
};

function toSendOptions(opts?: EnqueueOptions): PgBossSendOptions {
  return {
    startAfter: opts?.startAfterSeconds,
    singletonKey: opts?.singletonKey,
    retryLimit: opts?.retryLimit,
    retryDelay: opts?.retryDelay,
  };
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
    this.started = true;
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
