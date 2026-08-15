/**
 * Presence is tracked behind this interface so that swapping the
 * implementation — in-process today, Redis-backed if a second instance is
 * ever needed — is a constructor change, not a rewrite of every call site.
 * This is the direct fix for debt item D12: the original app's
 * `userSocketMap[userId]` appeared directly inside the message controller,
 * so nothing about it could change without touching every caller.
 * docs/realtime-architecture.md §6, docs/free-tier-plan.md §5.
 */
export interface PresenceStore {
  /** Registers a socket for a user. Returns whether this was their first
   * connected socket (i.e. they just came online). */
  addSocket(userId: string, socketId: string): Promise<{ becameOnline: boolean }>;

  /** Removes a socket. Returns whether this was their last connected
   * socket (i.e. they just went offline). */
  removeSocket(userId: string, socketId: string): Promise<{ becameOffline: boolean }>;

  /** Marks the user as recently seen, resetting their sweep timer. */
  heartbeat(userId: string): Promise<void>;

  isOnline(userId: string): Promise<boolean>;

  /** Removes any user not seen within `staleAfterMs`. Returns the user ids
   * reaped, so a caller can broadcast their offline status. */
  sweep(staleAfterMs: number): Promise<string[]>;
}
