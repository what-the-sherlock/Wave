import type { Queue } from "./queue.js";
import { noopQueue } from "./noopQueue.js";

/**
 * Module-level singleton, same shape as `realtime/emitter.ts`'s
 * `setRealtimeEmitter`/`getRealtimeEmitter`. Keeps `message.service.ts` (and
 * every other HTTP-path caller) free of a hard import-time dependency on
 * pg-boss — it only ever imports this `Queue` interface.
 */
let current: Queue = noopQueue;

export function setQueue(queue: Queue): void {
  current = queue;
}

/** Test-only: restores the no-op default between test files/suites. */
export function resetQueue(): void {
  current = noopQueue;
}

export function getQueue(): Queue {
  return current;
}

export type { Queue, EnqueueOptions, JobHandler } from "./queue.js";
