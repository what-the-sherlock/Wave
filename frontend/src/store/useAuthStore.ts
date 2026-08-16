import { create } from "zustand";
import toast from "react-hot-toast";
import { io, type Socket } from "socket.io-client";
import { axiosInstance } from "../lib/axios";
import { queryClient } from "../lib/queryClient";
import { extractErrorMessage } from "../lib/utils";

const SOCKET_URL = import.meta.env.MODE === "development" ? "http://localhost:5001" : "/";

/** Client-side half of docs/realtime-architecture.md §6's presence design —
 * the server only knows a user is still around if it hears from them
 * periodically. */
const PRESENCE_HEARTBEAT_INTERVAL_MS = 25_000;

let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

type SignUpInput = { fullName: string; email: string; password: string };
type LoginInput = { email: string; password: string };

type AuthState = {
  isSigningUp: boolean;
  isLoggingIn: boolean;
  socket: Socket | null;
  signup: (data: SignUpInput) => Promise<void>;
  login: (data: LoginInput) => Promise<void>;
  logout: () => Promise<void>;
  connectSocket: () => void;
  disconnectSocket: () => void;
};

export const useAuthStore = create<AuthState>((set, get) => ({
  isSigningUp: false,
  isLoggingIn: false,
  socket: null,

  signup: async (data) => {
    set({ isSigningUp: true });
    try {
      await axiosInstance.post("/auth/signup", data);
      await queryClient.invalidateQueries({ queryKey: ["session"] });
      toast.success("Account created successfully");
    } catch (error) {
      // Not re-thrown: neither caller (LoginPage/SignUpPage) awaits or
      // catches this, so rethrowing would only produce an unhandled
      // rejection warning. The toast above is the actual user-facing
      // feedback, matching how the rest of this store's actions behave.
      toast.error(extractErrorMessage(error));
    } finally {
      set({ isSigningUp: false });
    }
  },

  login: async (data) => {
    set({ isLoggingIn: true });
    try {
      await axiosInstance.post("/auth/login", data);
      await queryClient.invalidateQueries({ queryKey: ["session"] });
      toast.success("Logged in successfully");
    } catch (error) {
      // Not re-thrown: neither caller (LoginPage/SignUpPage) awaits or
      // catches this, so rethrowing would only produce an unhandled
      // rejection warning. The toast above is the actual user-facing
      // feedback, matching how the rest of this store's actions behave.
      toast.error(extractErrorMessage(error));
    } finally {
      set({ isLoggingIn: false });
    }
  },

  logout: async () => {
    try {
      // The backend always returns 200 here, even with no session — logout
      // must never fail from the caller's perspective (D18's lesson: don't
      // let a mismatch between "am I authenticated" and "can I clear my
      // session" leave a stale cookie the user can't get rid of).
      await axiosInstance.post("/auth/logout");
    } catch (error) {
      toast.error(extractErrorMessage(error));
    }
    get().disconnectSocket();
    queryClient.setQueryData(["session"], null);
    await queryClient.invalidateQueries({ queryKey: ["session"] });
    toast.success("Logged out successfully");
  },

  connectSocket: () => {
    if (get().socket?.connected) return;
    // withCredentials, no `query` — identity comes entirely from the
    // httpOnly cookie the server verifies at the handshake. The original
    // app passed `query: { userId }`, which the server trusted verbatim
    // (D1) — this is the client-side half of that fix.
    // docs/realtime-architecture.md §2. `reconnectionDelayMax` matches the
    // "1s, 2s, 4s … cap 10s" backoff §7 describes.
    const socket = io(SOCKET_URL, { withCredentials: true, reconnectionDelayMax: 10_000 });

    socket.on("connect", () => {
      heartbeatTimer ??= setInterval(() => {
        socket.emit("presence.heartbeat");
      }, PRESENCE_HEARTBEAT_INTERVAL_MS);
    });
    socket.on("disconnect", () => {
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
    });

    set({ socket });
  },

  disconnectSocket: () => {
    const socket = get().socket;
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    if (socket?.connected) {
      socket.disconnect();
    }
    set({ socket: null });
  },
}));
