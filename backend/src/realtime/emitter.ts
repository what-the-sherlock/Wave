/**
 * Lets the HTTP-layer service code (which must not import `socket.io`
 * directly, keeping realtime wiring in one place) emit to rooms and evict
 * sockets on membership changes — the one place RLS does not help, since RLS
 * governs database reads and not socket fan-out of an event the server
 * already holds in memory (docs/realtime-architecture.md §3).
 *
 * Same interface-first shape as `PresenceStore` (docs/realtime-architecture.md
 * §6): a real Socket.IO-backed implementation is wired in by `server.ts`
 * once `io` exists, and a no-op default keeps `test/helpers/testApp.ts`'s
 * HTTP-only `makeTestApp()` working without a real socket server.
 */
export type RealtimeEmitter = {
  toWorkspace(workspaceId: string, event: string, payload: unknown): void;
  toChannel(channelId: string, event: string, payload: unknown): void;
  toUser(userId: string, event: string, payload: unknown): void;
  evictUserFromWorkspace(userId: string, workspaceId: string): void;
  /** channel.member.added — moves an already-connected user's live sockets
   * into `ch:{id}` immediately, not waiting for their next `workspace.join`
   * (docs/realtime-architecture.md §3). */
  joinUserToChannel(userId: string, channelId: string): void;
  /** channel.member.removed — the security-critical direction; see
   * `evictUserFromWorkspace`. */
  evictUserFromChannel(userId: string, channelId: string): void;
};

const noopEmitter: RealtimeEmitter = {
  toWorkspace: () => undefined,
  toChannel: () => undefined,
  toUser: () => undefined,
  evictUserFromWorkspace: () => undefined,
  joinUserToChannel: () => undefined,
  evictUserFromChannel: () => undefined,
};

let current: RealtimeEmitter = noopEmitter;

export function setRealtimeEmitter(emitter: RealtimeEmitter): void {
  current = emitter;
}

/** Test-only: restores the no-op default between test files/suites. */
export function resetRealtimeEmitter(): void {
  current = noopEmitter;
}

export function getRealtimeEmitter(): RealtimeEmitter {
  return current;
}
