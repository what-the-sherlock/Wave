import { withRlsScope } from "../db/rlsScope.js";
import { NotFoundError } from "../errors/AppError.js";
import { getRealtimeEmitter } from "../realtime/emitter.js";
import * as notificationRepo from "./notification.repository.js";
import type { Notification, NotificationPage } from "./notification.repository.js";

export type { Notification, NotificationPage } from "./notification.repository.js";

export async function listNotifications(
  userId: string,
  opts: { before?: string; limit?: number },
): Promise<NotificationPage> {
  return withRlsScope({ userId }, (tx) =>
    notificationRepo.listForUser(tx, userId, {
      before: opts.before ? new Date(opts.before) : undefined,
      limit: opts.limit,
    }),
  );
}

export async function getUnreadCount(userId: string): Promise<number> {
  return withRlsScope({ userId }, (tx) => notificationRepo.unreadCount(tx, userId));
}

export async function markNotificationRead(userId: string, notificationId: string): Promise<Notification> {
  const result = await withRlsScope({ userId }, async (tx) => {
    const row = await notificationRepo.markRead(tx, userId, notificationId);
    if (!row) {
      throw new NotFoundError("Notification not found");
    }
    const unread = await notificationRepo.unreadCount(tx, userId);
    return { row, unread };
  });

  // Delivered to every device of this user, mirroring message.service.ts's
  // markRead → channel.read.updated cross-device sync pattern.
  getRealtimeEmitter().toUser(userId, "notification.read", {
    notificationId: result.row.id,
    unreadTotal: result.unread,
  });
  return result.row;
}

export async function markAllNotificationsRead(userId: string): Promise<void> {
  await withRlsScope({ userId }, (tx) => notificationRepo.markAllRead(tx, userId));
  getRealtimeEmitter().toUser(userId, "notification.read", { all: true, unreadTotal: 0 });
}
