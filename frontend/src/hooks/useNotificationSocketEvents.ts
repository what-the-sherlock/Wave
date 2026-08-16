import { useQueryClient, type InfiniteData } from "@tanstack/react-query";
import { useSocketEvent } from "./useSocketEvent";
import { notificationsQueryKey, unreadCountQueryKey } from "./useNotifications";
import type { Notification, NotificationPage } from "../types/notification";

type NotificationCreatedPayload = Notification & { unreadTotal: number };
type NotificationReadPayload = { notificationId?: string; all?: boolean; unreadTotal: number };

/** Global (not per-channel) — called once from App.tsx. A notification can
 * arrive for a workspace whose page isn't even open. */
export function useNotificationSocketEvents(): void {
  const queryClient = useQueryClient();

  useSocketEvent<NotificationCreatedPayload>("notification.created", (payload) => {
    const { unreadTotal, ...notification } = payload;
    queryClient.setQueryData(unreadCountQueryKey(), unreadTotal);
    queryClient.setQueryData<InfiniteData<NotificationPage>>(notificationsQueryKey(), (old) => {
      if (!old) return old;
      const pages = old.pages.map((page, i) =>
        i === 0 ? { ...page, notifications: [notification, ...page.notifications] } : page,
      );
      return { ...old, pages };
    });

    // Don't spam an OS notification while the tab is already focused — the
    // in-app bell/toast is enough there.
    if (typeof Notification !== "undefined" && Notification.permission === "granted" && document.visibilityState !== "visible") {
      const body = notification.preview ?? "You have a new notification";
      new Notification("wave", { body, tag: notification.id });
    }
  });

  useSocketEvent<NotificationReadPayload>("notification.read", (payload) => {
    queryClient.setQueryData(unreadCountQueryKey(), payload.unreadTotal);
    queryClient.setQueryData<InfiniteData<NotificationPage>>(notificationsQueryKey(), (old) => {
      if (!old) return old;
      return {
        ...old,
        pages: old.pages.map((page) => ({
          ...page,
          notifications: page.notifications.map((n) =>
            payload.all || n.id === payload.notificationId
              ? { ...n, readAt: n.readAt ?? new Date().toISOString() }
              : n,
          ),
        })),
      };
    });
  });
}
