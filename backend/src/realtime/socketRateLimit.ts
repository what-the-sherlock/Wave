/**
 * Per-socket token-bucket-style rate limiting for socket events
 * (docs/realtime-architecture.md §9). Sockets bypass HTTP rate limiting
 * entirely, which makes them the obvious abuse vector once HTTP is
 * protected — `express-rate-limit` (`middleware/rateLimit.ts`) is IP-based
 * and keyed off the HTTP request cycle, neither of which applies to a
 * long-lived socket connection emitting many events on one connection.
 *
 * In-process, keyed by caller-supplied strings (typically
 * `${socket.id}:${channelId}` or just `${socket.id}`) — correct and
 * sufficient for one instance; Redis-backed once a second instance exists
 * (docs/free-tier-plan.md §5).
 */
export class SocketRateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}

  /** Records and allows the call if under `max` within the trailing
   * window; otherwise records nothing and returns false. */
  allow(key: string): boolean {
    const now = Date.now();
    const timestamps = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (timestamps.length >= this.max) {
      this.hits.set(key, timestamps);
      return false;
    }
    timestamps.push(now);
    this.hits.set(key, timestamps);
    return true;
  }

  /** Drops every key with the given prefix — call on socket disconnect so
   * the map does not retain an entry per socket for the life of the
   * process (docs/free-tier-plan.md §5's "no Redis" in-process design still
   * has to bound its own memory). */
  clearPrefix(prefix: string): void {
    for (const key of this.hits.keys()) {
      if (key.startsWith(prefix)) {
        this.hits.delete(key);
      }
    }
  }
}
