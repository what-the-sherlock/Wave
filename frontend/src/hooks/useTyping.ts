import { useEffect, useRef, useState } from "react";
import { useAuthStore } from "../store/useAuthStore";
import { useSession } from "./useSession";
import { useSocketEvent } from "./useSocketEvent";

/** Matches the server's per-channel `typing.start` limit — emitting more
 * often than this is silently dropped anyway
 * (docs/realtime-architecture.md §9), so throttling client-side avoids
 * spamming events that would just be rate-limited away. */
const TYPING_EMIT_THROTTLE_MS = 3000;

/** The current set of other users typing in `channelId`. `typing.updated`
 * always carries the full set (not a delta), so there is nothing to
 * reconcile beyond filtering out the caller's own id — an 8s server-side
 * TTL means a stale entry self-clears with no explicit stop event
 * (docs/realtime-architecture.md §4). */
export function useTypingIndicator(channelId: string | undefined): string[] {
  const { data: session } = useSession();
  const [typingUserIds, setTypingUserIds] = useState<string[]>([]);

  useSocketEvent<{ channelId: string; userIds: string[] }>("typing.updated", (payload) => {
    if (!channelId || payload.channelId !== channelId) return;
    setTypingUserIds(payload.userIds.filter((id) => id !== session?.id));
  });

  useEffect(() => {
    setTypingUserIds([]);
  }, [channelId]);

  return typingUserIds;
}

/** Returns a throttled `notifyTyping()` — call it on every keystroke in the
 * composer; it emits at most once per `TYPING_EMIT_THROTTLE_MS`. */
export function useNotifyTyping(channelId: string | undefined): () => void {
  const socket = useAuthStore((s) => s.socket);
  const lastSentAtRef = useRef(0);

  return () => {
    if (!socket?.connected || !channelId) return;
    const now = Date.now();
    if (now - lastSentAtRef.current < TYPING_EMIT_THROTTLE_MS) return;
    lastSentAtRef.current = now;
    socket.emit("typing.start", { channelId });
  };
}
