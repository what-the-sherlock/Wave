import { useEffect, useRef } from "react";
import { useAuthStore } from "../store/useAuthStore";

/**
 * Subscribes to a socket event for the lifetime of the calling component,
 * re-subscribing if the socket instance itself changes (reconnect) and
 * always unsubscribing on unmount — `socket.on(event, handler)` without
 * this wrapper is easy to leak or to double-fire across remounts.
 */
export function useSocketEvent<Payload = unknown>(
  event: string,
  handler: (payload: Payload) => void,
): void {
  const socket = useAuthStore((s) => s.socket);
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    if (!socket) return;
    const listener = (payload: Payload) => handlerRef.current(payload);
    socket.on(event, listener);
    return () => {
      socket.off(event, listener);
    };
  }, [socket, event]);
}
