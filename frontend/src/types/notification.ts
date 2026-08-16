export type NotificationType =
  | "MENTION"
  | "DM"
  | "THREAD_REPLY"
  | "CHANNEL_INVITE"
  | "WORKSPACE_INVITE"
  | "SYSTEM";

export type Notification = {
  id: string;
  workspaceId: string;
  type: NotificationType;
  actorId: string | null;
  channelId: string | null;
  messageId: string | null;
  preview: string | null;
  readAt: string | null;
  createdAt: string;
};

export type NotificationPage = { notifications: Notification[]; hasMore: boolean };
