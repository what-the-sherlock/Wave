import { describe, expect, it, vi } from "vitest";
import { SocketRateLimiter } from "../../src/realtime/socketRateLimit.js";

describe("SocketRateLimiter", () => {
  it("allows up to `max` calls within the window, then rejects", () => {
    const limiter = new SocketRateLimiter(2, 1000);
    expect(limiter.allow("k")).toBe(true);
    expect(limiter.allow("k")).toBe(true);
    expect(limiter.allow("k")).toBe(false);
  });

  it("tracks separate keys independently", () => {
    const limiter = new SocketRateLimiter(1, 1000);
    expect(limiter.allow("a")).toBe(true);
    expect(limiter.allow("b")).toBe(true);
    expect(limiter.allow("a")).toBe(false);
    expect(limiter.allow("b")).toBe(false);
  });

  it("allows again once the window has elapsed", () => {
    vi.useFakeTimers();
    try {
      const limiter = new SocketRateLimiter(1, 1000);
      expect(limiter.allow("k")).toBe(true);
      expect(limiter.allow("k")).toBe(false);

      vi.advanceTimersByTime(1001);
      expect(limiter.allow("k")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("clearPrefix drops every key starting with the given prefix, leaving others intact", () => {
    const limiter = new SocketRateLimiter(1, 1000);
    limiter.allow("socket-1:ch-a");
    limiter.allow("socket-1:ch-b");
    limiter.allow("socket-2:ch-a");

    limiter.clearPrefix("socket-1");

    // Cleared keys are allowed again immediately.
    expect(limiter.allow("socket-1:ch-a")).toBe(true);
    expect(limiter.allow("socket-1:ch-b")).toBe(true);
    // The untouched key is still within its window.
    expect(limiter.allow("socket-2:ch-a")).toBe(false);
  });
});
