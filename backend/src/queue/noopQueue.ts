import type { Queue } from "./queue.js";

/**
 * Default queue when `RUN_WORKERS`/pg-boss is not running — keeps
 * `test/helpers/testApp.ts`'s HTTP-only `makeTestApp()` working, and keeps
 * `message.service.ts` free of a hard runtime dependency on pg-boss.
 * `sendTx` is a true no-op: it does not touch the passed transaction at all,
 * matching `realtime/emitter.ts`'s `noopEmitter` pattern.
 */
export const noopQueue: Queue = {
  send: async () => undefined,
  sendTx: async () => undefined,
  work: async () => undefined,
  start: async () => undefined,
  stop: async () => undefined,
};
