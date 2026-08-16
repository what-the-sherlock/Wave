import { describe, expect, it, vi } from "vitest";
import { TypingRegistry } from "../../src/realtime/typing/TypingRegistry.js";

describe("TypingRegistry", () => {
  it("broadcasts the current set of typers on start, per channel", () => {
    const onChange = vi.fn();
    const registry = new TypingRegistry(8000, onChange);

    registry.start("ch-1", "user-a");
    expect(onChange).toHaveBeenLastCalledWith("ch-1", ["user-a"]);

    registry.start("ch-1", "user-b");
    expect(onChange).toHaveBeenLastCalledWith("ch-1", ["user-a", "user-b"]);

    registry.start("ch-2", "user-a");
    expect(onChange).toHaveBeenLastCalledWith("ch-2", ["user-a"]);
    // ch-1's set is untouched by ch-2 activity.
    expect(registry.typersFor("ch-1")).toEqual(["user-a", "user-b"]);
  });

  it("expires a typer after the TTL and broadcasts the reduced set — no explicit stop needed", () => {
    vi.useFakeTimers();
    try {
      const onChange = vi.fn();
      const registry = new TypingRegistry(8000, onChange);

      registry.start("ch-1", "user-a");
      vi.advanceTimersByTime(8000);

      expect(onChange).toHaveBeenLastCalledWith("ch-1", []);
      expect(registry.typersFor("ch-1")).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("re-starting before expiry refreshes the TTL instead of expiring early", () => {
    vi.useFakeTimers();
    try {
      const onChange = vi.fn();
      const registry = new TypingRegistry(8000, onChange);

      registry.start("ch-1", "user-a");
      vi.advanceTimersByTime(5000);
      registry.start("ch-1", "user-a"); // refresh at t=5000
      vi.advanceTimersByTime(5000); // t=10000, but only 5000ms since the refresh

      expect(registry.typersFor("ch-1")).toEqual(["user-a"]);

      vi.advanceTimersByTime(3000); // t=13000, 8000ms since the refresh
      expect(registry.typersFor("ch-1")).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("one user's expiry does not affect another still-typing user in the same channel", () => {
    vi.useFakeTimers();
    try {
      const onChange = vi.fn();
      const registry = new TypingRegistry(8000, onChange);

      registry.start("ch-1", "user-a");
      vi.advanceTimersByTime(4000);
      registry.start("ch-1", "user-b");
      vi.advanceTimersByTime(4001); // user-a's original 8000ms timer fires

      expect(registry.typersFor("ch-1")).toEqual(["user-b"]);
    } finally {
      vi.useRealTimers();
    }
  });
});
