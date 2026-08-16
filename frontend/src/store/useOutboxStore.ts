import { create } from "zustand";
import type { SendMessageInput } from "../hooks/useMessages";

export type OutboxItem = {
  channelId: string;
  clientMsgId: string;
  input: SendMessageInput;
};

type OutboxState = {
  items: OutboxItem[];
  enqueue: (item: OutboxItem) => void;
  remove: (clientMsgId: string) => void;
};

/**
 * Messages composed while disconnected sit here with their `clientMsgId`
 * already assigned, flushed by `useOutboxFlush` on the socket's next
 * `connect`. Because `send_message` is idempotent on `clientMsgId`
 * (docs/database-design.md §7), a message that actually reached the server
 * before the drop is returned rather than duplicated
 * (docs/realtime-architecture.md §7).
 */
export const useOutboxStore = create<OutboxState>((set) => ({
  items: [],
  enqueue: (item) => set((s) => ({ items: [...s.items, item] })),
  remove: (clientMsgId) =>
    set((s) => ({ items: s.items.filter((i) => i.clientMsgId !== clientMsgId) })),
}));
