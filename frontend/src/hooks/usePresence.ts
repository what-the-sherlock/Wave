import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useSocketEvent } from "./useSocketEvent";

export type PresenceStatus = "online" | "offline";
export type PresenceEntry = { status: PresenceStatus; lastSeenAt: number };
export type PresenceMap = Record<string, PresenceEntry>;

export function presenceQueryKey(workspaceId: string | undefined) {
  return ["presence", workspaceId] as const;
}

/**
 * Read-only view of a workspace's presence roster. There is no REST
 * endpoint behind this — the cache is seeded once from the
 * `workspace.join` ack's roster and patched forever after by
 * `presence.updated` socket events (docs/realtime-architecture.md §6),
 * both wired in `useChannels.ts`'s `useWorkspaceSocketJoin`. `enabled:
 * false` keeps this a pure cache read: no query function ever runs.
 */
export function usePresence(workspaceId: string | undefined): PresenceMap {
  const { data } = useQuery<PresenceMap>({
    queryKey: presenceQueryKey(workspaceId),
    queryFn: () => ({}),
    enabled: false,
    initialData: {},
    staleTime: Infinity,
  });
  return data ?? {};
}

/** Subscribes this component to live `presence.updated` deltas, patching
 * the shared cache entry every workspace-scoped consumer reads via
 * `usePresence`. Call once near the top of the workspace tree (alongside
 * `useWorkspaceSocketJoin`) — every `usePresence` call elsewhere sees the
 * same cache regardless of how many times this is mounted. */
export function usePresenceSocketSync(workspaceId: string | undefined): void {
  const queryClient = useQueryClient();

  useSocketEvent<{ userId: string; status: PresenceStatus; lastSeenAt: number }>(
    "presence.updated",
    (payload) => {
      if (!workspaceId) return;
      queryClient.setQueryData<PresenceMap>(presenceQueryKey(workspaceId), (old) => ({
        ...old,
        [payload.userId]: { status: payload.status, lastSeenAt: payload.lastSeenAt },
      }));
    },
  );
}
