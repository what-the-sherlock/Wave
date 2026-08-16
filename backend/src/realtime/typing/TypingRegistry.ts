/**
 * Tracks who is currently typing per channel with a TTL per entry, not an
 * explicit start/stop protocol. `typing.stop` deliberately does not exist —
 * closed tabs, crashes, and dropped connections all make explicit stop
 * events unreliable, so the TTL is the only mechanism and it handles every
 * case uniformly. Stuck "X is typing…" indicators are impossible here
 * (docs/realtime-architecture.md §4).
 *
 * `typing.updated` always carries the *current set* of typers, never a
 * delta — an idempotent set is immune to a lost/duplicated event in a way a
 * stream of started/stopped deltas is not.
 */
export class TypingRegistry {
  private readonly byChannel = new Map<string, Map<string, ReturnType<typeof setTimeout>>>();

  constructor(
    private readonly ttlMs: number,
    private readonly onChange: (channelId: string, userIds: string[]) => void,
  ) {}

  /** Registers (or refreshes) `userId` as typing in `channelId` and
   * broadcasts the resulting set immediately — refreshing on every
   * `typing.start` is what keeps a continuously-typing user's indicator
   * alive without an explicit heartbeat of its own. */
  start(channelId: string, userId: string): void {
    let channel = this.byChannel.get(channelId);
    if (!channel) {
      channel = new Map();
      this.byChannel.set(channelId, channel);
    }

    const existingTimer = channel.get(userId);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const timer = setTimeout(() => {
      const current = this.byChannel.get(channelId);
      current?.delete(userId);
      if (current && current.size === 0) {
        this.byChannel.delete(channelId);
      }
      this.onChange(channelId, this.typersFor(channelId));
    }, this.ttlMs);
    timer.unref();

    channel.set(userId, timer);
    this.onChange(channelId, this.typersFor(channelId));
  }

  typersFor(channelId: string): string[] {
    return [...(this.byChannel.get(channelId)?.keys() ?? [])];
  }
}
