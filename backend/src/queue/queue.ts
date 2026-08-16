import type { Tx } from "../db/rlsScope.js";

/**
 * Background job infrastructure, defined as an interface before any backend
 * (docs/free-tier-plan.md §5's pg-boss-vs-BullMQ decision — pg-boss today,
 * because it needs no new infrastructure and lets a job be enqueued inside
 * the same Postgres transaction as the data that produced it; BullMQ stays
 * a swap behind this interface if the project ever outgrows one instance
 * and adds Redis for other reasons). Same interface-first shape as
 * `PresenceStore`/`RealtimeEmitter`.
 */
export type EnqueueOptions = {
  /** Delay before the job becomes eligible to run. */
  startAfterSeconds?: number;
  /** Deduplication key — a second send with the same key inside the
   * dedupe window is dropped rather than creating a second job. */
  singletonKey?: string;
  retryLimit?: number;
  /** Seconds between retries. */
  retryDelay?: number;
};

export type JobHandler<T> = (data: T, jobId: string) => Promise<void>;

export interface Queue {
  /** Enqueue outside of any existing transaction. */
  send<T extends object>(queueName: string, data: T, opts?: EnqueueOptions): Promise<void>;

  /**
   * Enqueue as part of an existing RLS-scoped transaction — the job only
   * becomes visible to workers if and when `tx`'s transaction commits, and
   * never becomes visible if it rolls back. This is what makes "insert the
   * message and queue its notification fan-out" atomic
   * (docs/realtime-architecture.md §5).
   */
  sendTx<T extends object>(tx: Tx, queueName: string, data: T, opts?: EnqueueOptions): Promise<void>;

  /** Registers a handler for a queue. Every handler must be idempotent —
   * pg-boss retries a job whose worker crashed mid-execution. */
  work<T extends object>(queueName: string, handler: JobHandler<T>): Promise<void>;

  start(): Promise<void>;
  stop(): Promise<void>;
}
