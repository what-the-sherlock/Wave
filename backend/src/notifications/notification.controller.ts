import type { Request, Response } from "express";
import { asyncHandler } from "../errors/asyncHandler.js";
import * as notificationService from "./notification.service.js";
import type { Notification } from "./notification.service.js";
import type { ListNotificationsQuery } from "./notification.schemas.js";

function toDto(notification: Notification) {
  return {
    id: notification.id,
    workspaceId: notification.workspaceId,
    type: notification.type,
    actorId: notification.actorId,
    channelId: notification.channelId,
    messageId: notification.messageId,
    preview: notification.preview,
    readAt: notification.readAt,
    createdAt: notification.createdAt,
  };
}

export const list = asyncHandler(async (req: Request, res: Response) => {
  const query = req.query as unknown as ListNotificationsQuery;
  const page = await notificationService.listNotifications(req.claims!.sub, {
    before: query.before,
    limit: query.limit,
  });
  res.status(200).json({
    notifications: page.notifications.map(toDto),
    hasMore: page.hasMore,
  });
});

export const unreadCount = asyncHandler(async (req: Request, res: Response) => {
  const count = await notificationService.getUnreadCount(req.claims!.sub);
  res.status(200).json({ count });
});

export const markRead = asyncHandler(async (req: Request, res: Response) => {
  const notification = await notificationService.markNotificationRead(
    req.claims!.sub,
    req.params.notificationId!,
  );
  res.status(200).json(toDto(notification));
});

export const markAllRead = asyncHandler(async (req: Request, res: Response) => {
  await notificationService.markAllNotificationsRead(req.claims!.sub);
  res.status(204).send();
});
