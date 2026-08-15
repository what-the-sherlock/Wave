import type { Server as HttpServer } from "node:http";
import { Server, type Socket } from "socket.io";
import { config } from "../config/env.js";
import { logger } from "../logging/logger.js";
import { socketAuthMiddleware, type AuthenticatedSocketData } from "./socketAuth.js";
import { InMemoryPresenceStore } from "./presence/InMemoryPresenceStore.js";
import type { PresenceStore } from "./presence/PresenceStore.js";
import { withAck } from "./ackHandler.js";

const PRESENCE_STALE_MS = 60_000;
const PRESENCE_SWEEP_INTERVAL_MS = 30_000;

export type SocketServerHandle = {
  io: Server;
  presenceStore: PresenceStore;
  stopSweeper: () => void;
};

/**
 * Phase 1 scope: an authenticated handshake, a personal `u:{userId}` room
 * per connected user, and presence tracking. There is no workspace concept
 * yet, so there is no audience to broadcast presence *to* — `ws:{id}` rooms
 * and the `presence.updated` broadcast arrive with workspaces in Phase 3/4
 * (docs/realtime-architecture.md §3, §6).
 */
export function createSocketServer(
  httpServer: HttpServer,
  presenceStore: PresenceStore = new InMemoryPresenceStore(),
): SocketServerHandle {
  const io = new Server(httpServer, {
    cors: {
      origin: [...config.CORS_ORIGINS],
      credentials: true,
    },
  });

  io.use(socketAuthMiddleware);

  io.on("connection", (socket: Socket) => {
    const { claims } = socket.data as AuthenticatedSocketData;
    const userId = claims.sub;

    void socket.join(`u:${userId}`);
    presenceStore
      .addSocket(userId, socket.id)
      .catch((err: unknown) => logger.error({ err, userId }, "presence addSocket failed"));

    logger.info({ userId, socketId: socket.id }, "socket connected");

    socket.on(
      "presence.heartbeat",
      withAck("presence.heartbeat", async (_socket, _payload: unknown) => {
        await presenceStore.heartbeat(userId);
      }),
    );

    socket.on("disconnect", (reason) => {
      presenceStore
        .removeSocket(userId, socket.id)
        .catch((err: unknown) => logger.error({ err, userId }, "presence removeSocket failed"));
      logger.info({ userId, socketId: socket.id, reason }, "socket disconnected");
    });

    socket.on("error", (err: unknown) => {
      logger.error({ err, userId, socketId: socket.id }, "socket error");
    });
  });

  const sweepTimer = setInterval(() => {
    presenceStore.sweep(PRESENCE_STALE_MS).catch((err: unknown) => {
      logger.error({ err }, "presence sweep failed");
    });
  }, PRESENCE_SWEEP_INTERVAL_MS);
  sweepTimer.unref();

  return { io, presenceStore, stopSweeper: () => clearInterval(sweepTimer) };
}
