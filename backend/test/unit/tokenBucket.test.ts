import { describe, expect, it } from "vitest";
import { TokenBucket } from "../../src/ai/tokenBucket.js";

describe("TokenBucket", () => {
  it("starts full: capacity consecutive tryConsume calls succeed", () => {
    const bucket = new TokenBucket(3, 1 / 1000);
    const now = 0;
    expect(bucket.tryConsume(now)).toBe(true);
    expect(bucket.tryConsume(now)).toBe(true);
    expect(bucket.tryConsume(now)).toBe(true);
    expect(bucket.tryConsume(now)).toBe(false);
  });

  it("refills over time at the configured rate", () => {
    const bucket = new TokenBucket(1, 1 / 1000); // 1 token per 1000ms
    expect(bucket.tryConsume(0)).toBe(true);
    expect(bucket.tryConsume(500)).toBe(false); // not enough time elapsed
    expect(bucket.tryConsume(1000)).toBe(true); // exactly one token back
  });

  it("never refills past capacity", () => {
    const bucket = new TokenBucket(2, 1); // fast refill
    expect(bucket.tryConsume(0)).toBe(true);
    // Huge elapsed time — should cap at capacity, not overflow.
    expect(bucket.tryConsume(1_000_000)).toBe(true);
    expect(bucket.tryConsume(1_000_000)).toBe(true);
    expect(bucket.tryConsume(1_000_000)).toBe(false);
  });

  it("msUntilNextToken is 0 when a token is available, positive otherwise", () => {
    const bucket = new TokenBucket(1, 1 / 1000);
    expect(bucket.msUntilNextToken(0)).toBe(0);
    bucket.tryConsume(0);
    expect(bucket.msUntilNextToken(0)).toBeGreaterThan(0);
  });
});
