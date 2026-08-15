import type { PresenceStore } from "./PresenceStore.js";

type UserPresence = {
  socketIds: Set<string>;
  lastSeenAt: number;
};

/**
 * Free-tier presence: one instance, everything in a `Map`. No command
 * quota, no network hop — genuinely faster than Redis for the case it
 * actually needs to handle. Its only limitation is that it cannot span
 * multiple processes, which is exactly the thing a one-instance deployment
 * does not need. docs/free-tier-plan.md §5, docs/realtime-architecture.md §6.
 */
export class InMemoryPresenceStore implements PresenceStore {
  private readonly users = new Map<string, UserPresence>();

  async addSocket(userId: string, socketId: string): Promise<{ becameOnline: boolean }> {
    const existing = this.users.get(userId);
    if (!existing) {
      this.users.set(userId, { socketIds: new Set([socketId]), lastSeenAt: Date.now() });
      return { becameOnline: true };
    }
    existing.socketIds.add(socketId);
    existing.lastSeenAt = Date.now();
    return { becameOnline: false };
  }

  async removeSocket(userId: string, socketId: string): Promise<{ becameOffline: boolean }> {
    const existing = this.users.get(userId);
    if (!existing) {
      return { becameOffline: false };
    }
    existing.socketIds.delete(socketId);
    if (existing.socketIds.size === 0) {
      this.users.delete(userId);
      return { becameOffline: true };
    }
    return { becameOffline: false };
  }

  async heartbeat(userId: string): Promise<void> {
    const existing = this.users.get(userId);
    if (existing) {
      existing.lastSeenAt = Date.now();
    }
  }

  async isOnline(userId: string): Promise<boolean> {
    return this.users.has(userId);
  }

  async sweep(staleAfterMs: number): Promise<string[]> {
    const now = Date.now();
    const reaped: string[] = [];
    for (const [userId, presence] of this.users) {
      if (now - presence.lastSeenAt > staleAfterMs) {
        this.users.delete(userId);
        reaped.push(userId);
      }
    }
    return reaped;
  }

  /** Test/debug helper — not part of the interface. */
  socketCount(userId: string): number {
    return this.users.get(userId)?.socketIds.size ?? 0;
  }
}
