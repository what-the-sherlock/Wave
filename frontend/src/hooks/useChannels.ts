import { useEffect } from "react";
import {
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
  type QueryClient,
} from "@tanstack/react-query";
import toast from "react-hot-toast";
import { axiosInstance } from "../lib/axios";
import { extractErrorMessage } from "../lib/utils";
import { useAuthStore } from "../store/useAuthStore";
import { useSession } from "./useSession";
import { useSocketEvent } from "./useSocketEvent";
import { messagesQueryKey } from "./useMessages";
import { presenceQueryKey, type PresenceMap } from "./usePresence";
import type { Channel, ChannelMember, ChannelType, MessagePage } from "../types/channel";

async function fetchChannels(workspaceId: string): Promise<Channel[]> {
  const res = await axiosInstance.get<Channel[]>(`/workspaces/${workspaceId}/channels`);
  return res.data;
}

export function useChannels(workspaceId: string | undefined) {
  return useQuery({
    queryKey: ["channels", workspaceId],
    queryFn: () => fetchChannels(workspaceId!),
    enabled: Boolean(workspaceId),
  });
}

export function useChannel(channelId: string | undefined) {
  return useQuery({
    queryKey: ["channel", channelId],
    queryFn: async () => {
      const res = await axiosInstance.get<Channel>(`/channels/${channelId}`);
      return res.data;
    },
    enabled: Boolean(channelId),
  });
}

export type CreateChannelInput = {
  name: string;
  type: Exclude<ChannelType, "DM">;
  topic?: string;
  description?: string;
};

export function useCreateChannel(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateChannelInput) => {
      const res = await axiosInstance.post<Channel>(`/workspaces/${workspaceId}/channels`, input);
      return res.data;
    },
    onSuccess: (channel) => {
      queryClient.setQueryData(["channel", channel.id], channel);
      void queryClient.invalidateQueries({ queryKey: ["channels", workspaceId] });
    },
    onError: (error) => toast.error(extractErrorMessage(error)),
  });
}

export function useJoinChannel(channelId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      await axiosInstance.post(`/channels/${channelId}/join`);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["channel", channelId] });
    },
    onError: (error) => toast.error(extractErrorMessage(error)),
  });
}

export function useMuteChannel(channelId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (mutedUntil: string | null) => {
      const res = await axiosInstance.patch<Channel>(`/channels/${channelId}/members/me`, { mutedUntil });
      return res.data;
    },
    onSuccess: (channel) => {
      queryClient.setQueryData(["channel", channelId], channel);
      toast.success(channel.mutedUntil ? "Channel muted" : "Channel unmuted");
    },
    onError: (error) => toast.error(extractErrorMessage(error)),
  });
}

export function useChannelMembers(channelId: string | undefined) {
  return useQuery({
    queryKey: ["channel-members", channelId],
    queryFn: async () => {
      const res = await axiosInstance.get<ChannelMember[]>(`/channels/${channelId}/members`);
      return res.data;
    },
    enabled: Boolean(channelId),
  });
}

export function useOpenDm(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (userId: string) => {
      const res = await axiosInstance.post<Channel>(`/workspaces/${workspaceId}/dms`, { userId });
      return res.data;
    },
    onSuccess: (channel) => {
      queryClient.setQueryData(["channel", channel.id], channel);
      void queryClient.invalidateQueries({ queryKey: ["channels", workspaceId] });
    },
    onError: (error) => toast.error(extractErrorMessage(error)),
  });
}

type JoinAckChannel = { channelId: string; lastMessageSeq: number; lastReadSeq: number };
type JoinAckResponse = {
  ok: boolean;
  channels?: JoinAckChannel[];
  presence?: { userId: string; status: "online" | "offline"; lastSeenAt: number }[];
};

/** A gap this large discards the local page and does a fresh fetch instead
 * of replaying — replaying thousands of messages one at a time is slower
 * and heavier than starting clean (docs/realtime-architecture.md §7). */
const MAX_GAP_REPLAY = 200;

/**
 * Reconciles one channel's local scrollback against the server's current
 * head sequence, called for every channel in the `workspace.join` ack on
 * every (re)connect. A channel with no cached `messages` query has never
 * been opened locally, so there is nothing to reconcile — its sidebar
 * badge is kept current instead by the `channels` list cache patched
 * below.
 */
async function replayGapIfNeeded(
  queryClient: QueryClient,
  channelId: string,
  serverLastMessageSeq: number,
): Promise<void> {
  const cache = queryClient.getQueryData<InfiniteData<MessagePage>>(messagesQueryKey(channelId));
  if (!cache) return;

  const newestPage = cache.pages[0];
  const localLatestSeq = newestPage?.messages[0]?.seq ?? 0;
  if (serverLastMessageSeq <= localLatestSeq) return;

  const gap = serverLastMessageSeq - localLatestSeq;
  if (gap > MAX_GAP_REPLAY) {
    await queryClient.invalidateQueries({
      queryKey: messagesQueryKey(channelId),
      refetchType: "active",
    });
    return;
  }

  const res = await axiosInstance.get<MessagePage>(`/channels/${channelId}/messages`, {
    params: { after: localLatestSeq, limit: MAX_GAP_REPLAY },
  });

  queryClient.setQueryData<InfiniteData<MessagePage>>(messagesQueryKey(channelId), (old) => {
    if (!old) return old;
    const pages = old.pages.map((page, i) => {
      if (i !== 0) return page;
      const existingIds = new Set(page.messages.map((m) => m.id));
      // The `after` endpoint returns oldest→newest; the newest page here is
      // newest-first, so the replayed slice is reversed before prepending.
      const replayed = res.data.messages.filter((m) => !existingIds.has(m.id)).reverse();
      return { ...page, messages: [...replayed, ...page.messages] };
    });
    return { ...old, pages };
  });
}

/**
 * Emits `workspace.join` whenever the socket (re)connects or the active
 * workspace changes: joins every `ch:{id}` room the caller belongs to,
 * seeds the presence roster, replays any gap in whichever channel's
 * scrollback is already cached (the reconnection guarantee — "the client
 * knows precisely which channels need replay" — docs/realtime-architecture.md
 * §7), and keeps the sidebar's unread badges live via `message.created`
 * and `channel.read.updated`.
 */
export function useWorkspaceSocketJoin(workspaceId: string | undefined): void {
  const socket = useAuthStore((s) => s.socket);
  const queryClient = useQueryClient();
  const { data: session } = useSession();

  useEffect(() => {
    if (!socket || !workspaceId) return;

    const join = () => {
      socket
        .timeout(5000)
        .emit("workspace.join", { workspaceId }, (err: Error | null, response: JoinAckResponse) => {
          if (err || !response?.ok) return;

          if (response.presence) {
            queryClient.setQueryData<PresenceMap>(presenceQueryKey(workspaceId), (old) => {
              const next = { ...old };
              for (const p of response.presence!) {
                next[p.userId] = { status: p.status, lastSeenAt: p.lastSeenAt };
              }
              return next;
            });
          }

          for (const channel of response.channels ?? []) {
            void replayGapIfNeeded(queryClient, channel.channelId, channel.lastMessageSeq);
          }

          void queryClient.invalidateQueries({ queryKey: ["channels", workspaceId] });
        });
    };

    if (socket.connected) join();
    socket.on("connect", join);
    return () => {
      socket.off("connect", join);
    };
  }, [socket, workspaceId, queryClient]);

  // Every channel room the caller belongs to is joined above, so
  // `message.created` for *any* of the workspace's channels reaches this
  // socket — not just the currently-open one — which is what keeps
  // background channels' unread badges live without a refetch.
  useSocketEvent<{ channelId: string; seq: number; createdAt: string }>(
    "message.created",
    (payload) => {
      queryClient.setQueryData<Channel[]>(["channels", workspaceId], (old) =>
        old?.map((c) =>
          c.id === payload.channelId && payload.seq > c.lastMessageSeq
            ? { ...c, lastMessageSeq: payload.seq, lastMessageAt: payload.createdAt }
            : c,
        ),
      );
    },
  );

  // Cross-device read-state sync (docs/realtime-architecture.md §4) doubles
  // as the local device's own confirmation that a mark-read call landed —
  // `channel.read.updated` is delivered to every socket of this user,
  // including the one that made the call.
  useSocketEvent<{ channelId: string; lastReadSeq: number }>("channel.read.updated", (payload) => {
    queryClient.setQueryData<Channel[]>(["channels", workspaceId], (old) =>
      old?.map((c) => (c.id === payload.channelId ? { ...c, lastReadSeq: payload.lastReadSeq } : c)),
    );
  });

  // The remaining events below were emitted by the backend but never
  // subscribed to anywhere — a new/archived channel, a channel roster
  // change, or a workspace roster change only showed up after the next
  // reconnect's full refetch. Plain cache invalidation, no new UI.
  useSocketEvent<unknown>("channel.created", () => {
    void queryClient.invalidateQueries({ queryKey: ["channels", workspaceId] });
  });
  useSocketEvent<unknown>("channel.archived", () => {
    void queryClient.invalidateQueries({ queryKey: ["channels", workspaceId] });
  });
  useSocketEvent<{ channelId: string; userId: string }>("channel.member.added", (payload) => {
    void queryClient.invalidateQueries({ queryKey: ["channel-members", payload.channelId] });
    if (payload.userId === session?.id) {
      void queryClient.invalidateQueries({ queryKey: ["channels", workspaceId] });
    }
  });
  useSocketEvent<{ channelId: string; userId: string }>("channel.member.removed", (payload) => {
    void queryClient.invalidateQueries({ queryKey: ["channel-members", payload.channelId] });
    if (payload.userId === session?.id) {
      void queryClient.invalidateQueries({ queryKey: ["channels", workspaceId] });
    }
  });
  // `workspace.member.joined` matters most here: today, inviting someone
  // and having them accept doesn't update the Members page until a
  // refresh — this is the live half of the invite flow.
  useSocketEvent<unknown>("workspace.member.joined", () => {
    void queryClient.invalidateQueries({ queryKey: ["workspace-members", workspaceId] });
  });
  useSocketEvent<unknown>("workspace.member.removed", () => {
    void queryClient.invalidateQueries({ queryKey: ["workspace-members", workspaceId] });
  });
}
