import { createServer, type Server as HttpServer } from "node:http";
import type { Server as SocketIoServer } from "socket.io";
import { config } from "./config/env.js";
import { logger } from "./logging/logger.js";
import { createApp } from "./app.js";
import { createSocketServer } from "./realtime/socket.js";
import type { PresenceStore } from "./realtime/presence/PresenceStore.js";
import { closeDb } from "./db/client.js";

export type ServerHandle = {
  app: ReturnType<typeof createApp>;
  httpServer: HttpServer;
  io: SocketIoServer;
  presenceStore: PresenceStore;
  close: () => Promise<void>;
};

/**
 * Builds the app, the http.Server, and the Socket.IO gateway, but does not
 * start listening — `startServer()` is the entrypoint that does that.
 * Kept separate so tests can build a fully wired server (including sockets)
 * on an ephemeral port without going through process-level listen/signal
 * handling. `presenceStore` is exposed on the handle so tests can assert on
 * presence state directly rather than only through side effects.
 */
export function buildServer(): ServerHandle {
  const app = createApp();
  const httpServer = createServer(app);
  const { io, presenceStore, stopSweeper } = createSocketServer(httpServer);

  const close = async (): Promise<void> => {
    stopSweeper();
    io.close();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  };

  return { app, httpServer, io, presenceStore, close };
}

export function startServer(): ServerHandle {
  const handle = buildServer();

  handle.httpServer.listen(config.PORT, () => {
    logger.info({ port: config.PORT, env: config.NODE_ENV }, "server listening");
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
