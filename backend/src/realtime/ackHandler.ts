import { randomUUID } from "node:crypto";
import type { Socket } from "socket.io";
import { AppError } from "../errors/AppError.js";
import { logger } from "../logging/logger.js";
import type { AuthenticatedSocketData } from "./socketAuth.js";

type Ack = (response: Record<string, unknown>) => void;

/**
 * Wraps a socket event handler so a thrown error never kills the
 * connection and never leaks internals to the client — the socket
 * transport's equivalent of `errorMiddleware`. The `requestId` returned in
 * a failed ack matches the structured log line, so a user report ("it said
 * something went wrong") is one grep away from the stack trace.
 * docs/realtime-architecture.md §8.
 */
export function withAck<Payload>(
  event: string,
  handler: (socket: Socket, payload: Payload) => Promise<Record<string, unknown> | void>,
) {
  return async (socket: Socket, payload: Payload, ack?: Ack): Promise<void> => {
    const requestId = randomUUID();
    try {
      const result = await handler(socket, payload);
      ack?.({ ok: true, ...(result ?? {}) });
    } catch (err) {
      const userId = (socket.data as Partial<AuthenticatedSocketData>).claims?.sub;
      logger.error({ err, requestId, userId, event }, "socket handler failed");
      const safe =
        err instanceof AppError
          ? { code: err.code, message: err.message }
          : { code: "INTERNAL", message: "Something went wrong" };
      ack?.({ ok: false, ...safe, requestId });
    }
  };
}
