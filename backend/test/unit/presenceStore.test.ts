import { describe, expect, it, vi } from "vitest";
import { InMemoryPresenceStore } from "../../src/realtime/presence/InMemoryPresenceStore.js";

describe("InMemoryPresenceStore", () => {
  it("reports becameOnline only for the first socket a user connects", async () => {
    const store = new InMemoryPresenceStore();
    const first = await store.addSocket("user-1", "socket-a");
    const second = await store.addSocket("user-1", "socket-b");
    expect(first.becameOnline).toBe(true);
    expect(second.becameOnline).toBe(false);
    expect(await store.isOnline("user-1")).toBe(true);
  });

  it("multi-device (D9 fix): closing one of two tabs keeps the user online", async () => {
    const store = new InMemoryPresenceStore();
    await store.addSocket("user-1", "socket-a");
    await store.addSocket("user-1", "socket-b");

    const result = await store.removeSocket("user-1", "socket-a");
    expect(result.becameOffline).toBe(false);
    expect(await store.isOnline("user-1")).toBe(true);

    const result2 = await store.removeSocket("user-1", "socket-b");
    expect(result2.becameOffline).toBe(true);
    expect(await store.isOnline("user-1")).toBe(false);
  });

  it("removing a socket that was never registered is a harmless no-op", async () => {
    const store = new InMemoryPresenceStore();
    const result = await store.removeSocket("ghost-user", "ghost-socket");
    expect(result.becameOffline).toBe(false);
  });

  it("does not confuse two different users' socket sets", async () => {
    const store = new InMemoryPresenceStore();
    await store.addSocket("user-1", "socket-a");
    await store.addSocket("user-2", "socket-b");
    await store.removeSocket("user-1", "socket-a");
    expect(await store.isOnline("user-1")).toBe(false);
    expect(await store.isOnline("user-2")).toBe(true);
  });

  it("sweep reaps only entries stale beyond the threshold, and returns their ids", async () => {
    vi.useFakeTimers();
    try {
      const store = new InMemoryPresenceStore();
      await store.addSocket("stale-user", "socket-a");

      vi.advanceTimersByTime(70_000);
      await store.addSocket("fresh-user", "socket-b"); // seen "now"

      const reaped = await store.sweep(60_000);
      expect(reaped).toEqual(["stale-user"]);
      expect(await store.isOnline("stale-user")).toBe(false);
      expect(await store.isOnline("fresh-user")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("heartbeat resets the staleness clock", async () => {
    vi.useFakeTimers();
    try {
      const store = new InMemoryPresenceStore();
      await store.addSocket("user-1", "socket-a");

      vi.advanceTimersByTime(50_000);
      await store.heartbeat("user-1");
      vi.advanceTimersByTime(50_000); // 100s total, but heartbeat reset the clock at 50s

      const reaped = await store.sweep(60_000);
      expect(reaped).toEqual([]);
      expect(await store.isOnline("user-1")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
