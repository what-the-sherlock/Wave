import { useInfiniteQuery, useMutation, useQuery, useQueryClient, type InfiniteData } from "@tanstack/react-query";
import toast from "react-hot-toast";
import { axiosInstance } from "../lib/axios";
import { extractErrorMessage } from "../lib/utils";
import { useSession } from "./useSession";
import type { Notification, NotificationPage } from "../types/notification";

async function fetchNotifications(before?: string): Promise<NotificationPage> {
  const res = await axiosInstance.get<NotificationPage>("/notifications", {
    params: before ? { before } : {},
  });
  return res.data;
}

export function notificationsQueryKey() {
  return ["notifications"] as const;
}

export function unreadCountQueryKey() {
  return ["notifications", "unread-count"] as const;
}

export function useNotifications() {
  const { data: session } = useSession();
  return useInfiniteQuery({
    queryKey: notificationsQueryKey(),
    queryFn: ({ pageParam }: { pageParam: string | undefined }) => fetchNotifications(pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) =>
      lastPage.hasMore ? lastPage.notifications[lastPage.notifications.length - 1]?.createdAt : undefined,
    enabled: Boolean(session?.id),
  });
}

export function useUnreadCount() {
  const { data: session } = useSession();
  return useQuery({
    queryKey: unreadCountQueryKey(),
    queryFn: async () => {
      const res = await axiosInstance.get<{ count: number }>("/notifications/unread-count");
      return res.data.count;
    },
    enabled: Boolean(session?.id),
    staleTime: 30_000,
  });
}

/** Shared by the socket handler and the mark-read mutations — both patch
 * the same two cache entries, so both funnel through here. */
export function applyReadState(
  queryClient: ReturnType<typeof useQueryClient>,
  unreadTotal: number,
  notificationId?: string,
) {
  queryClient.setQueryData(unreadCountQueryKey(), unreadTotal);
  queryClient.setQueryData<InfiniteData<NotificationPage>>(notificationsQueryKey(), (old) => {
    if (!old) return old;
    return {
      ...old,
      pages: old.pages.map((page) => ({
        ...page,
        notifications: page.notifications.map((n) =>
          notificationId
            ? n.id === notificationId
              ? { ...n, readAt: n.readAt ?? new Date().toISOString() }
              : n
            : { ...n, readAt: n.readAt ?? new Date().toISOString() },
        ),
      })),
    };
  });
}

export function useMarkNotificationRead() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (notificationId: string) => {
      const res = await axiosInstance.post<Notification>(`/notifications/${notificationId}/read`);
      return res.data;
    },
    onSuccess: (_notification, notificationId) => {
      const current = queryClient.getQueryData<number>(unreadCountQueryKey()) ?? 0;
      applyReadState(queryClient, Math.max(0, current - 1), notificationId);
    },
    onError: (error) => toast.error(extractErrorMessage(error)),
  });
}

export function useMarkAllNotificationsRead() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      await axiosInstance.post("/notifications/read-all");
    },
    onSuccess: () => applyReadState(queryClient, 0),
    onError: (error) => toast.error(extractErrorMessage(error)),
  });
}
