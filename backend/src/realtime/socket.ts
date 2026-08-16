import type { Server as HttpServer } from "node:http";
import { Server, type Socket } from "socket.io";
import { config } from "../config/env.js";
import { logger } from "../logging/logger.js";
import {
  socketAuthMiddleware,
  reverifySocket,
  type AuthenticatedSocketData,
} from "./socketAuth.js";
import { InMemoryPresenceStore } from "./presence/InMemoryPresenceStore.js";
import type { PresenceStore } from "./presence/PresenceStore.js";
import { withAck } from "./ackHandler.js";
import { SocketRateLimiter } from "./socketRateLimit.js";
import { TypingRegistry } from "./typing/TypingRegistry.js";
import type { RealtimeEmitter } from "./emitter.js";
import { verifyMembership } from "../workspaces/workspace.service.js";
import { listMyChannelsInWorkspace } from "../channels/channel.service.js";
import * as messageService from "../channels/message.service.js";
import { NotFoundError, RateLimitedError, ValidationError } from "../errors/AppError.js";

const PRESENCE_STALE_MS = 60_000;
const PRESENCE_SWEEP_INTERVAL_MS = 30_000;
const REAUTH_INTERVAL_MS = 15 * 60_000;
const TYPING_TTL_MS = 8_000;

/** docs/realtime-architecture.md §9 — the 11th connection evicts the
 * oldest, bounding the memory and presence cost of one abusive account. */
const MAX_SOCKETS_PER_USER = 10;

/** docs/realtime-architecture.md §9's rate limit table. */
const TYPING_START_RATE = { max: 1, windowMs: 3_000 };
const CHANNEL_READ_RATE = { max: 10, windowMs: 10_000 };
const WORKSPACE_JOIN_RATE = { max: 10, windowMs: 60_000 };

export type SocketServerHandle = {
  io: Server;
  presenceStore: PresenceStore;
  stopSweeper: () => void;
};

/**
 * Wraps a live `io` instance as the `RealtimeEmitter` HTTP-layer services
 * use to broadcast and evict without importing `socket.io` directly
 * (docs/realtime-architecture.md §3). `server.ts` wires this in right after
 * `createSocketServer()` returns.
 */
export function createSocketIoRealtimeEmitter(io: Server): RealtimeEmitter {
  return {
    toWorkspace(workspaceId, event, payload) {
      io.in(`ws:${workspaceId}`).emit(event, payload);
    },
    toChannel(channelId, event, payload) {
      io.in(`ch:${channelId}`).emit(event, payload);
    },
    toUser(userId, event, payload) {
      io.in(`u:${userId}`).emit(event, payload);
    },
    evictUserFromWorkspace(userId, workspaceId) {
      // The security-critical direction: RLS governs database reads, not
      // socket fan-out of an event the server already holds in memory, so a
      // removed member must be moved out of the room immediately rather
      // than waiting for a reconnect (docs/realtime-architecture.md §3).
      void io.in(`u:${userId}`).socketsLeave(`ws:${workspaceId}`);
    },
    joinUserToChannel(userId, channelId) {
      void io.in(`u:${userId}`).socketsJoin(`ch:${channelId}`);
    },
    evictUserFromChannel(userId, channelId) {
      void io.in(`u:${userId}`).socketsLeave(`ch:${channelId}`);
    },
  };
}

function claimsOf(socket: { data: unknown }): string {
  return (socket.data as AuthenticatedSocketData).claims.sub;
}

function workspaceIdsOf(rooms: Iterable<string>): string[] {
  const ids: string[] = [];
  for (const room of rooms) {
    if (room.startsWith("ws:")) ids.push(room.slice(3));
  }
  return ids;
}

/**
 * Phase 1 shipped an authenticated handshake, a personal `u:{userId}` room,
 * and presence tracking. Phase 3 added `workspace.join`: membership
 * verified through an RLS-scoped query, `ws:{id}`/`ch:{id}` room joins, and
 * head sequences in the ack. **Phase 4 is everything users can perceive**
 * on top of that skeleton — presence broadcast, typing, read receipts, rate
 * limiting, and periodic re-authentication
 * (docs/realtime-architecture.md §10).
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

  // Scoped to this server instance (not module-level) so multiple
  // `buildServer()` calls — as tests make, one per suite — never share
  // rate-limit or typing state.
  const typingLimiter = new SocketRateLimiter(TYPING_START_RATE.max, TYPING_START_RATE.windowMs);
  const readLimiter = new SocketRateLimiter(CHANNEL_READ_RATE.max, CHANNEL_READ_RATE.windowMs);
  const joinLimiter = new SocketRateLimiter(WORKSPACE_JOIN_RATE.max, WORKSPACE_JOIN_RATE.windowMs);
  const typingRegistry = new TypingRegistry(TYPING_TTL_MS, (channelId, userIds) => {
    io.in(`ch:${channelId}`).emit("typing.updated", { channelId, userIds });
  });

  io.on("connection", (socket: Socket) => {
    const userId = claimsOf(socket);

    presenceStore
      .addSocket(userId, socket.id)
      .catch((err: unknown) => logger.error({ err, userId }, "presence addSocket failed"));

    // The 11th concurrent socket for one user evicts the oldest
    // (docs/realtime-architecture.md §9). Joined and counted inside the
    // same async sequence — checking room membership before this socket's
    // own `join` has resolved would undercount it and let the cap slip by
    // one under an unlucky race. `fetchSockets` on a room backed by the
    // local (no-Redis) adapter reflects Socket.IO's own insertion order, so
    // the front of the array is genuinely the oldest connection.
    void (async () => {
      await socket.join(`u:${userId}`);
      const sockets = await io.in(`u:${userId}`).fetchSockets();
      const excess = sockets.length - MAX_SOCKETS_PER_USER;
      if (excess <= 0) return;
      const oldest = sockets.filter((s) => s.id !== socket.id).slice(0, excess);
      for (const s of oldest) {
        s.emit("error", {
          code: "RATE_LIMITED",
          message: "Too many concurrent connections; oldest session disconnected",
        });
        s.disconnect(true);
      }
    })().catch((err: unknown) => logger.error({ err, userId }, "connection cap check failed"));

    logger.info({ userId, socketId: socket.id }, "socket connected");

    // Re-verifies the same handshake cookie every 15 minutes so a socket
    // authenticated with a token that later expires does not stay
    // connected indefinitely (docs/realtime-architecture.md §2).
    const reauthTimer = setInterval(() => {
      reverifySocket(socket)
        .then((ok) => {
          if (!ok) {
            logger.info({ userId, socketId: socket.id }, "socket re-auth failed; disconnecting");
            socket.disconnect(true);
          }
        })
        .catch(() => socket.disconnect(true));
    }, REAUTH_INTERVAL_MS);
    reauthTimer.unref();

    /**
     * `withAck`'s returned function expects `(socket, payload, ack)` — see
     * its unit tests, which call it directly with that shape — but
     * Socket.IO invokes a listener registered via `socket.on(event, fn)`
     * with exactly what the client emitted, `(payload, ack)`, never with
     * `socket` prepended. Registering `withAck(...)`'s result as the
     * listener directly (as this file did before) silently misaligns every
     * parameter: `socket` receives the payload, `payload` receives the ack
     * function, and the real ack is never called — a client emit with an
     * ack times out. This binds `socket` from the closure instead, which is
     * the only thing `socket.on` itself never supplies.
     */
    function on<Payload>(
      event: string,
      handler: (socket: Socket, payload: Payload) => Promise<Record<string, unknown> | void>,
    ): void {
      const wrapped = withAck(event, handler);
      socket.on(event, (payload: Payload, ack?: (response: Record<string, unknown>) => void) =>
        wrapped(socket, payload, ack),
      );
    }

    on("presence.heartbeat", async (_socket, _payload: unknown) => {
      await presenceStore.heartbeat(userId);
    });

    on("workspace.join", async (s, payload: { workspaceId?: string }) => {
      if (!joinLimiter.allow(s.id)) {
        throw new RateLimitedError();
      }
      const workspaceId = payload?.workspaceId;
      if (!workspaceId || !(await verifyMembership(userId, workspaceId))) {
        throw new NotFoundError("Workspace not found");
      }
      await s.join(`ws:${workspaceId}`);

      const channels = await listMyChannelsInWorkspace(userId, workspaceId);
      await Promise.all(channels.map((c) => s.join(`ch:${c.channelId}`)));

      // The roster is read straight from room membership — the same
      // membership that gates message delivery — rather than tracked
      // separately, so presence visibility can never drift from what the
      // socket layer actually authorizes (docs/realtime-architecture.md
      // §2's "every socket query runs under RLS" principle, applied here to
      // room membership instead of a database row).
      const roomSockets = await io.in(`ws:${workspaceId}`).fetchSockets();
      const onlineUserIds = [...new Set(roomSockets.map((rs) => claimsOf(rs)))];
      const lastSeenAt = Date.now();

      io.in(`ws:${workspaceId}`).emit("presence.updated", {
        userId,
        status: "online",
        lastSeenAt,
      });

      return {
        workspaceId,
        channels: channels.map((c) => ({
          channelId: c.channelId,
          lastMessageSeq: c.lastMessageSeq,
          lastReadSeq: c.lastReadSeq,
        })),
        presence: onlineUserIds.map((id) => ({ userId: id, status: "online", lastSeenAt })),
      };
    });

    on("typing.start", async (s, payload: { channelId?: string }) => {
      const channelId = payload?.channelId;
      if (!channelId) return;
      if (!s.rooms.has(`ch:${channelId}`)) return; // not a member — silently dropped, same as any other fire-and-forget hint
      if (!typingLimiter.allow(`${s.id}:${channelId}`)) return;
      typingRegistry.start(channelId, userId);
    });

    on("channel.read", async (s, payload: { channelId?: string; seq?: number }) => {
      const channelId = payload?.channelId;
      const seq = payload?.seq;
      if (!channelId || typeof seq !== "number") {
        throw new ValidationError("channelId and a numeric seq are required");
      }
      if (!s.rooms.has(`ch:${channelId}`)) {
        throw new NotFoundError("Channel not found");
      }
      if (!readLimiter.allow(`${s.id}:${channelId}`)) {
        throw new RateLimitedError();
      }
      const result = await messageService.markRead(userId, channelId, seq);
      return { unread: result.unread };
    });

    socket.on("disconnecting", () => {
      // Read before Socket.IO actually removes the socket from its rooms —
      // by the time the `disconnect` event fires, `socket.rooms` is already
      // empty (docs/realtime-architecture.md §3).
      const workspaceIds = workspaceIdsOf(socket.rooms);
      presenceStore
        .removeSocket(userId, socket.id)
        .then(({ becameOffline }) => {
          if (!becameOffline) return;
          const lastSeenAt = Date.now();
          for (const workspaceId of workspaceIds) {
            io.in(`ws:${workspaceId}`).emit("presence.updated", {
              userId,
              status: "offline",
              lastSeenAt,
            });
          }
        })
        .catch((err: unknown) => logger.error({ err, userId }, "presence removeSocket failed"));
    });

    socket.on("disconnect", (reason) => {
      clearInterval(reauthTimer);
      typingLimiter.clearPrefix(socket.id);
      readLimiter.clearPrefix(socket.id);
      joinLimiter.clearPrefix(socket.id);
      logger.info({ userId, socketId: socket.id, reason }, "socket disconnected");
    });

    socket.on("error", (err: unknown) => {
      logger.error({ err, userId, socketId: socket.id }, "socket error");
    });
  });

  // Backstop for a socket whose transport died without a clean
  // disconnect/close handshake — the primary, reliable path for presence
  // offline broadcast is the `disconnecting` handler above; this only
  // covers the rarer zombie-connection case
  // (docs/realtime-architecture.md §6).
  const sweepTimer = setInterval(() => {
    presenceStore
      .sweep(PRESENCE_STALE_MS)
      .then(async (reapedUserIds) => {
        if (reapedUserIds.length === 0) return;
        const allSockets = await io.fetchSockets();
        const lastSeenAt = Date.now();
        for (const reapedUserId of reapedUserIds) {
          const staleSockets = allSockets.filter((s) => claimsOf(s) === reapedUserId);
          const workspaceIds = new Set(staleSockets.flatMap((s) => workspaceIdsOf(s.rooms)));
          for (const s of staleSockets) {
            s.disconnect(true);
          }
          for (const workspaceId of workspaceIds) {
            io.in(`ws:${workspaceId}`).emit("presence.updated", {
              userId: reapedUserId,
              status: "offline",
              lastSeenAt,
            });
          }
        }
      })
      .catch((err: unknown) => {
        logger.error({ err }, "presence sweep failed");
      });
  }, PRESENCE_SWEEP_INTERVAL_MS);
  sweepTimer.unref();

  return { io, presenceStore, stopSweeper: () => clearInterval(sweepTimer) };
}
