import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { axiosInstance } from "../lib/axios";
import { useAuthStore } from "../store/useAuthStore";
import { useOutboxStore } from "../store/useOutboxStore";
import { upsertMessage } from "./useMessages";
import type { Message } from "../types/channel";

/**
 * Drains the offline outbox on every socket `connect` (initial connect and
 * every reconnect alike). Sent with the item's original `clientMsgId`, so a
 * message that actually reached the server before the drop is returned
 * rather than duplicated — `send_message`'s idempotency guarantee
 * (docs/database-design.md §7) is what makes "just resend everything
 * queued" safe. Mounted once, near the socket lifecycle in `App.tsx`, not
 * per-channel — an item can flush while its channel isn't even open.
 */
export function useOutboxFlush(): void {
  const socket = useAuthStore((s) => s.socket);
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!socket) return;

    const flush = async () => {
      // Snapshot-and-loop rather than iterating the live store: a failed
      // item (still offline) must not block later ones from being retried
      // on the *next* connect, and a successful send removes itself from
      // the store mid-loop.
      for (const item of useOutboxStore.getState().items) {
        try {
          const res = await axiosInstance.post<Message>(`/channels/${item.channelId}/messages`, {
            ...item.input,
            clientMsgId: item.clientMsgId,
          });
          upsertMessage(queryClient, item.channelId, {
            ...res.data,
            reactions: res.data.reactions ?? [],
          });
          useOutboxStore.getState().remove(item.clientMsgId);
        } catch {
          // Still offline, or a genuine error — leave it queued and try
          // again on the next connect rather than losing it.
        }
      }
    };

    if (socket.connected) void flush();
    socket.on("connect", flush);
    return () => {
      socket.off("connect", flush);
    };
  }, [socket, queryClient]);
}
