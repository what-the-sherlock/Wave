import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
  type QueryClient,
} from "@tanstack/react-query";
import axios from "axios";
import toast from "react-hot-toast";
import { axiosInstance } from "../lib/axios";
import { extractErrorMessage } from "../lib/utils";
import { useSocketEvent } from "./useSocketEvent";
import { useSession } from "./useSession";
import { useOutboxStore } from "../store/useOutboxStore";
import type { Message, MessagePage, ReactionResult } from "../types/channel";

const PAGE_SIZE = 50;

async function fetchMessages(channelId: string, before?: number): Promise<MessagePage> {
  const res = await axiosInstance.get<MessagePage>(`/channels/${channelId}/messages`, {
    params: { limit: PAGE_SIZE, ...(before !== undefined ? { before } : {}) },
  });
  return res.data;
}

export function messagesQueryKey(channelId: string) {
  return ["messages", channelId] as const;
}

/**
 * Newest-page-first (page 0 = most recent 50), each page itself newest-first
 * — matches the cursor-pagination shape the API returns. Flattened to
 * oldest→newest for rendering by the caller (`ChatContainer`), which is the
 * natural top-to-bottom reading order a virtualized list wants.
 */
export function useMessages(channelId: string | undefined) {
  return useInfiniteQuery({
    queryKey: messagesQueryKey(channelId!),
    queryFn: ({ pageParam }: { pageParam: number | undefined }) =>
      fetchMessages(channelId!, pageParam),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (lastPage) =>
      lastPage.hasMore ? lastPage.messages[lastPage.messages.length - 1]?.seq : undefined,
    enabled: Boolean(channelId),
    staleTime: 10_000,
  });
}

/** Places (or replaces, by `id`/`clientMsgId`) a message at the front of
 * the newest page — the only page a brand-new or just-reconciled message
 * can belong in. Shared by the optimistic-send reconciliation and the
 * `message.created` socket handler so both paths converge on one dedupe
 * rule (docs/target-architecture.md §8's "socket events write into the
 * TanStack Query cache" rule, and the D23 clientMsgId-reconciliation fix). */
export function upsertMessage(
  queryClient: QueryClient,
  channelId: string,
  message: Message,
) {
  queryClient.setQueryData<InfiniteData<MessagePage>>(messagesQueryKey(channelId), (old) => {
    if (!old) return old;
    const pages = old.pages.map((page, i) => {
      if (i !== 0) return page;
      const withoutDupe = page.messages.filter(
        (m) => m.id !== message.id && m.clientMsgId !== message.clientMsgId,
      );
      return { ...page, messages: [message, ...withoutDupe] };
    });
    return { ...old, pages };
  });
}

function patchMessage(
  queryClient: ReturnType<typeof useQueryClient>,
  channelId: string,
  messageId: string,
  patch: Partial<Message>,
) {
  queryClient.setQueryData<InfiniteData<MessagePage>>(messagesQueryKey(channelId), (old) => {
    if (!old) return old;
    return {
      ...old,
      pages: old.pages.map((page) => ({
        ...page,
        messages: page.messages.map((m) => (m.id === messageId ? { ...m, ...patch } : m)),
      })),
    };
  });
}

function removeMessage(
  queryClient: ReturnType<typeof useQueryClient>,
  channelId: string,
  messageId: string,
) {
  queryClient.setQueryData<InfiniteData<MessagePage>>(messagesQueryKey(channelId), (old) => {
    if (!old) return old;
    return {
      ...old,
      pages: old.pages.map((page) => ({
        ...page,
        messages: page.messages.filter((m) => m.id !== messageId),
      })),
    };
  });
}

/** Wires the four channel-room message events into the query cache for the
 * currently-open channel. One subscription per open `ChatContainer`. */
export function useMessageSocketEvents(channelId: string | undefined): void {
  const queryClient = useQueryClient();
  const { data: session } = useSession();

  useSocketEvent<Message>("message.created", (message) => {
    if (!channelId || message.channelId !== channelId || message.threadRootId) return;
    upsertMessage(queryClient, channelId, {
      ...message,
      reactions: message.reactions ?? [],
      attachments: message.attachments ?? [],
    });
  });

  useSocketEvent<{
    id: string;
    channelId: string;
    body: string | null;
    editedAt: string;
    seq: number;
  }>("message.updated", (payload) => {
    if (!channelId || payload.channelId !== channelId) return;
    patchMessage(queryClient, channelId, payload.id, {
      body: payload.body,
      editedAt: payload.editedAt,
    });
  });

  useSocketEvent<{ id: string; channelId: string }>("message.deleted", (payload) => {
    if (!channelId || payload.channelId !== channelId) return;
    removeMessage(queryClient, channelId, payload.id);
  });

  // The broadcast carries the toggler's userId, so every other connected
  // client can tell whether the reaction that just changed was *their own*
  // without a separate round trip — only the toggler's own client already
  // knows this from the HTTP response (see useToggleReaction below).
  useSocketEvent<{ messageId: string; emoji: string; userId: string; count: number }>(
    "message.reaction.added",
    (payload) =>
      applyReactionCount(queryClient, channelId, { ...payload, me: payload.userId === session?.id }),
  );
  useSocketEvent<{ messageId: string; emoji: string; userId: string; count: number }>(
    "message.reaction.removed",
    (payload) =>
      applyReactionCount(queryClient, channelId, { ...payload, me: payload.userId === session?.id }),
  );
}

function applyReactionCount(
  queryClient: ReturnType<typeof useQueryClient>,
  channelId: string | undefined,
  payload: { messageId: string; emoji: string; count: number; me: boolean },
) {
  if (!channelId) return;
  queryClient.setQueryData<InfiniteData<MessagePage>>(messagesQueryKey(channelId), (old) => {
    if (!old) return old;
    return {
      ...old,
      pages: old.pages.map((page) => ({
        ...page,
        messages: page.messages.map((m) => {
          if (m.id !== payload.messageId) return m;
          const rest = m.reactions.filter((r) => r.emoji !== payload.emoji);
          const reactions =
            payload.count > 0
              ? [...rest, { emoji: payload.emoji, count: payload.count, me: payload.me }]
              : rest;
          return { ...m, reactions };
        }),
      })),
    };
  });
}

/**
 * `attachment.ready` fires once the background worker finishes generating a
 * thumbnail — before this, the thumbnail simply didn't appear until the
 * message list was refetched. Delivered to the uploader only (`u:{userId}`),
 * so channel identity is unknown here; patches whichever cached channel's
 * message list happens to hold the attachment, which is always the
 * uploader's own currently- or recently-open channel. Mounted once, globally
 * (`App.tsx`), like `useOutboxFlush`.
 */
export function useAttachmentReadySocketSync(): void {
  const queryClient = useQueryClient();

  useSocketEvent<{ messageId: string; attachmentId: string; thumbPath: string | null }>(
    "attachment.ready",
    (payload) => {
      for (const query of queryClient.getQueryCache().findAll({ queryKey: ["messages"] })) {
        queryClient.setQueryData<InfiniteData<MessagePage>>(query.queryKey, (old) => {
          if (!old) return old;
          let changed = false;
          const pages = old.pages.map((page) => ({
            ...page,
            messages: page.messages.map((m) => {
              if (m.id !== payload.messageId) return m;
              changed = true;
              return {
                ...m,
                attachments: m.attachments.map((a) =>
                  a.id === payload.attachmentId ? { ...a, thumbPath: payload.thumbPath } : a,
                ),
              };
            }),
          }));
          return changed ? { ...old, pages } : old;
        });
      }
    },
  );
}

export type SendMessageInput = {
  body: string;
  threadRootId?: string;
  mentionedUserIds?: string[];
  mentionChannel?: boolean;
  attachmentIds?: string[];
};

export function useSendMessage(channelId: string) {
  const queryClient = useQueryClient();
  const { data: session } = useSession();
  return useMutation({
    mutationFn: async (input: SendMessageInput) => {
      const clientMsgId = crypto.randomUUID();

      // Optimistic placeholder, reconciled by id/clientMsgId when the real
      // row arrives via this HTTP response or the `message.created` socket
      // event, whichever wins (D23). `senderId` is the real session id, not
      // "" — an empty string never equals the viewer's own id, so the
      // placeholder briefly rendered as "Unknown" instead of "You".
      const placeholder: Message = {
        id: `optimistic-${clientMsgId}`,
        workspaceId: "",
        channelId,
        seq: Number.MAX_SAFE_INTEGER,
        senderId: session?.id ?? "",
        body: input.body,
        clientMsgId,
        threadRootId: input.threadRootId ?? null,
        replyCount: 0,
        lastReplyAt: null,
        editedAt: null,
        deletedAt: null,
        createdAt: new Date().toISOString(),
        reactions: [],
        attachments: [],
      };
      if (!input.threadRootId) {
        upsertMessage(queryClient, channelId, placeholder);
      }

      try {
        const res = await axiosInstance.post<Message>(`/channels/${channelId}/messages`, {
          ...input,
          clientMsgId,
        });
        return { ...res.data, reactions: res.data.reactions ?? [], attachments: res.data.attachments ?? [] };
      } catch (error) {
        // No HTTP response at all (offline, DNS failure, request never
        // reached the server) — as opposed to a real rejection (validation,
        // permission) — queues the message instead of discarding it. The
        // optimistic placeholder already in the cache stands in for it
        // until `useOutboxFlush` resends with this same `clientMsgId` on
        // reconnect (docs/realtime-architecture.md §7).
        if (axios.isAxiosError(error) && !error.response) {
          useOutboxStore.getState().enqueue({ channelId, clientMsgId, input });
          toast("Message queued — it'll send once you're back online", { icon: "🕓" });
          return placeholder;
        }
        throw error;
      }
    },
    onSuccess: (message) => {
      if (!message.threadRootId) {
        upsertMessage(queryClient, channelId, message);
      } else {
        void queryClient.invalidateQueries({ queryKey: ["thread", message.threadRootId] });
      }
    },
    onError: (error) => toast.error(extractErrorMessage(error)),
  });
}

export function useEditMessage(channelId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ messageId, body }: { messageId: string; body: string }) => {
      const res = await axiosInstance.patch<Message>(
        `/channels/${channelId}/messages/${messageId}`,
        { body },
      );
      return res.data;
    },
    onSuccess: (message) => {
      patchMessage(queryClient, channelId, message.id, {
        body: message.body,
        editedAt: message.editedAt,
      });
    },
    onError: (error) => toast.error(extractErrorMessage(error)),
  });
}

export function useDeleteMessage(channelId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (messageId: string) => {
      await axiosInstance.delete(`/channels/${channelId}/messages/${messageId}`);
      return messageId;
    },
    onSuccess: (messageId) => {
      removeMessage(queryClient, channelId, messageId);
    },
    onError: (error) => toast.error(extractErrorMessage(error)),
  });
}

export function useToggleReaction(channelId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ messageId, emoji }: { messageId: string; emoji: string }) => {
      const res = await axiosInstance.post<ReactionResult>(
        `/channels/${channelId}/messages/${messageId}/reactions`,
        { emoji },
      );
      return { messageId, ...res.data };
    },
    // `added` is exactly this viewer's new `me` state for the emoji they
    // just toggled — no need to compare against the session id here, since
    // this is the toggler's own response, not a broadcast.
    onSuccess: ({ messageId, emoji, count, added }) => {
      applyReactionCount(queryClient, channelId, { messageId, emoji, count, me: added });
    },
    onError: (error) => toast.error(extractErrorMessage(error)),
  });
}

export function useMarkRead(channelId: string) {
  return useMutation({
    mutationFn: async (seq: number) => {
      await axiosInstance.post(`/channels/${channelId}/read`, { seq });
    },
  });
}

/** The thread panel's reply list — a plain (non-infinite) query, since
 * threads are bounded in a way the main scrollback isn't. Wires
 * `thread.reply.created` into its own cache entry, separate from the main
 * channel's `messages` cache (replies never appear there —
 * `message.repository.ts`'s `listByChannel` excludes them server-side). */
export function useThreadReplies(channelId: string | undefined, threadRootId: string | undefined) {
  const queryClient = useQueryClient();
  const queryKey = ["thread", threadRootId] as const;

  useSocketEvent<Message>("thread.reply.created", (rawMessage) => {
    if (!threadRootId || rawMessage.threadRootId !== threadRootId) return;
    // The socket payload is the raw DB row, not the HTTP DTO — it carries
    // neither `reactions` nor `attachments` at all (`message.service.ts`
    // emits `{ ...message, clientMsgId }` straight from the repository
    // insert). `MessageItem` reads both unconditionally, so without this
    // default a reply arriving live here crashes the whole page.
    const message: Message = {
      ...rawMessage,
      reactions: rawMessage.reactions ?? [],
      attachments: rawMessage.attachments ?? [],
    };
    queryClient.setQueryData<Message[]>(queryKey, (old) => {
      if (!old) return old;
      if (old.some((m) => m.id === message.id || m.clientMsgId === message.clientMsgId)) {
        return old.map((m) => (m.clientMsgId === message.clientMsgId ? message : m));
      }
      return [...old, message];
    });
  });

  return useQuery({
    queryKey,
    queryFn: async () => {
      const res = await axiosInstance.get<Message[]>(
        `/channels/${channelId}/messages/${threadRootId}/thread`,
      );
      return res.data;
    },
    enabled: Boolean(channelId) && Boolean(threadRootId),
  });
}
