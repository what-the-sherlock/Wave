/**
 * Nominal typing for ids that are all structurally `string` (uuid) but must
 * never be interchanged — a `ChannelId` passed where a `WorkspaceId` is
 * expected is a bug TypeScript would otherwise never catch.
 * docs/implementation-roadmap.md Phase 2 backend changes.
 */
export type Brand<T, B extends string> = T & { readonly __brand: B };

export type WorkspaceId = Brand<string, "WorkspaceId">;
export type UserId = Brand<string, "UserId">;
/** Unused until Phase 3's channels table lands — defined now so the type
 * doesn't need revisiting when it does. */
export type ChannelId = Brand<string, "ChannelId">;

export function asWorkspaceId(id: string): WorkspaceId {
  return id as WorkspaceId;
}

export function asUserId(id: string): UserId {
  return id as UserId;
}
