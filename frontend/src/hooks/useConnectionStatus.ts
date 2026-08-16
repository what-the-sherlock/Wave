import { useEffect, useState } from "react";
import { useAuthStore } from "../store/useAuthStore";

export type ConnectionStatus = "connected" | "connecting" | "disconnected";

/**
 * Tracks the single shared socket's live transport state. Reconnection
 * itself is Socket.IO's own default backoff (tuned to a 10s cap in
 * `useAuthStore.connectSocket`, matching docs/realtime-architecture.md §7's
 * "1s, 2s, 4s … cap 10s") — this hook only surfaces that state so the UI
 * can show it, it does not drive reconnection.
 */
export function useConnectionStatus(): ConnectionStatus {
  const socket = useAuthStore((s) => s.socket);
  const [status, setStatus] = useState<ConnectionStatus>(
    socket?.connected ? "connected" : "connecting",
  );

  useEffect(() => {
    if (!socket) return;
    setStatus(socket.connected ? "connected" : "connecting");

    const onConnect = () => setStatus("connected");
    const onDisconnect = () => setStatus("disconnected");
    const onReconnectAttempt = () => setStatus("connecting");

    socket.on("connect", onConnect);
    socket.on("disconnect", onDisconnect);
    socket.io.on("reconnect_attempt", onReconnectAttempt);
    return () => {
      socket.off("connect", onConnect);
      socket.off("disconnect", onDisconnect);
      socket.io.off("reconnect_attempt", onReconnectAttempt);
    };
  }, [socket]);

  return socket ? status : "disconnected";
}
