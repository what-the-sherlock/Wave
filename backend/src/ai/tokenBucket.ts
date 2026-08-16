/**
 * A generic in-process token bucket, used to keep the Groq client's request
 * rate below the published free-tier RPM limit (docs/free-tier-plan.md §4)
 * — smoothing bursts instead of failing them. Same "in-process, not Redis"
 * shape as `realtime/socketRateLimit.ts`'s `SocketRateLimiter`: on a single
 * free-tier instance there's nothing else sharing this budget.
 */
export class TokenBucket {
  private tokens: number;
  // Seeded lazily from the first `nowMs` this instance actually sees
  // (real Date.now() in production, small fixed numbers in tests) rather
  // than from Date.now() at construction time — a bucket constructed for
  // real use but immediately driven with test-scale timestamps would
  // otherwise see a permanently-negative `elapsed` and never refill.
  private lastRefillMs: number | null = null;

  constructor(
    private readonly capacity: number,
    private readonly refillPerMs: number,
  ) {
    this.tokens = capacity;
  }

  private refill(nowMs: number): void {
    if (this.lastRefillMs === null) {
      this.lastRefillMs = nowMs;
      return;
    }
    const elapsed = nowMs - this.lastRefillMs;
    if (elapsed <= 0) return;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerMs);
    this.lastRefillMs = nowMs;
  }

  /** Consumes one token if available; returns false without blocking if the
   * bucket is empty — callers decide whether to wait or reject. The epsilon
   * absorbs floating-point drift from `refillPerMs` (e.g. `20/60_000`)
   * accumulating just under an exact integer after many small refills. */
  tryConsume(nowMs: number = Date.now()): boolean {
    this.refill(nowMs);
    if (this.tokens + 1e-9 < 1) return false;
    this.tokens = Math.max(0, this.tokens - 1);
    return true;
  }

  /** Milliseconds until at least one token will be available. 0 if one
   * already is. */
  msUntilNextToken(nowMs: number = Date.now()): number {
    this.refill(nowMs);
    if (this.tokens + 1e-9 >= 1) return 0;
    return Math.ceil((1 - this.tokens) / this.refillPerMs);
  }
}

/** Blocks (without busy-waiting) until a token is available, then consumes
 * it. Used in front of every Groq call — see groqProvider.ts. */
export async function consumeWithWait(bucket: TokenBucket): Promise<void> {
  for (;;) {
    if (bucket.tryConsume()) return;
    const waitMs = bucket.msUntilNextToken();
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
}
