import { createServer, type Server as HttpServer } from "node:http";
import type { Server as SocketIoServer } from "socket.io";
import { config } from "./config/env.js";
import { logger } from "./logging/logger.js";
import { createApp } from "./app.js";
import { createSocketServer, createSocketIoRealtimeEmitter } from "./realtime/socket.js";
import { setRealtimeEmitter } from "./realtime/emitter.js";
import type { PresenceStore } from "./realtime/presence/PresenceStore.js";
import { closeDb } from "./db/client.js";
import { setQueue, type Queue } from "./queue/index.js";
import { noopQueue } from "./queue/noopQueue.js";
import { PgBossQueue } from "./queue/pgBossQueue.js";
import { registerWorkers } from "./queue/registerWorkers.js";

export type ServerHandle = {
  app: ReturnType<typeof createApp>;
  httpServer: HttpServer;
  io: SocketIoServer;
  presenceStore: PresenceStore;
  queue: Queue;
  close: () => Promise<void>;
};

/**
 * Builds the app, the http.Server, the Socket.IO gateway, and (behind
 * `RUN_WORKERS`) the job queue, but does not start listening —
 * `startServer()` is the entrypoint that does that. Kept separate so tests
 * can build a fully wired server on an ephemeral port without going through
 * process-level listen/signal handling. `presenceStore`/`queue` are exposed
 * on the handle so tests can assert on their state directly.
 */
export async function buildServer(): Promise<ServerHandle> {
  const app = createApp();
  const httpServer = createServer(app);
  const { io, presenceStore, stopSweeper } = createSocketServer(httpServer);
  setRealtimeEmitter(createSocketIoRealtimeEmitter(io));

  const queue: Queue = config.RUN_WORKERS ? new PgBossQueue() : noopQueue;
  setQueue(queue);
  if (config.RUN_WORKERS) {
    await queue.start();
    await registerWorkers({ queue, presenceStore });
  }

  const close = async (): Promise<void> => {
    stopSweeper();
    io.close();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    await queue.stop();
  };

  return { app, httpServer, io, presenceStore, queue, close };
}

export async function startServer(): Promise<ServerHandle> {
  const handle = await buildServer();

  handle.httpServer.listen(config.PORT, () => {
    logger.info({ port: config.PORT, env: config.NODE_ENV, runWorkers: config.RUN_WORKERS }, "server listening");
  });

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "shutting down");
    handle
      .close()
      .then(() => closeDb())
      .then(() => {
        logger.info("shutdown complete");
        process.exit(0);
      })
      .catch((err: unknown) => {
        logger.error({ err }, "error during shutdown");
        process.exit(1);
      });
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  return handle;
}
