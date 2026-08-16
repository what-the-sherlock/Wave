import { useNavigate } from "react-router-dom";
import { AtSign, Hash, MessageSquare, User } from "lucide-react";
import { useNotifications, useMarkNotificationRead } from "../hooks/useNotifications";
import { useWorkspaces } from "../hooks/useWorkspaces";
import { formatMessageTime } from "../lib/utils";
import type { Notification, NotificationType } from "../types/notification";

const ICON_BY_TYPE: Record<NotificationType, typeof AtSign> = {
  MENTION: AtSign,
  DM: MessageSquare,
  THREAD_REPLY: MessageSquare,
  CHANNEL_INVITE: Hash,
  WORKSPACE_INVITE: User,
  SYSTEM: User,
};

const LABEL_BY_TYPE: Record<NotificationType, string> = {
  MENTION: "mentioned you",
  DM: "sent you a message",
  THREAD_REPLY: "replied in a thread",
  CHANNEL_INVITE: "added you to a channel",
  WORKSPACE_INVITE: "invited you to a workspace",
  SYSTEM: "notification",
};

function NotificationRow({ notification, onNavigate }: { notification: Notification; onNavigate: () => void }) {
  const { data: workspaces } = useWorkspaces();
  const markRead = useMarkNotificationRead();
  const navigate = useNavigate();
  const Icon = ICON_BY_TYPE[notification.type];
  const workspace = workspaces?.find((w) => w.id === notification.workspaceId);

  const handleClick = () => {
    if (!notification.readAt) {
      markRead.mutate(notification.id);
    }
    onNavigate();
    if (workspace && notification.channelId) {
      navigate(`/w/${workspace.slug}/c/${notification.channelId}`);
    }
  };

  return (
    <li>
      <button
        type="button"
        onClick={handleClick}
        className={`flex items-start gap-2.5 py-2 px-3 text-left ${notification.readAt ? "" : "bg-primary/5"}`}
      >
        <Icon className="size-4 mt-0.5 shrink-0 text-base-content/50" />
        <div className="min-w-0 flex-1">
          <p className="text-sm truncate">{LABEL_BY_TYPE[notification.type]}</p>
          {notification.preview && (
            <p className="text-xs text-base-content/60 truncate">{notification.preview}</p>
          )}
          <p className="text-xs text-base-content/40">{formatMessageTime(notification.createdAt)}</p>
        </div>
        {!notification.readAt && <span className="size-2 rounded-full bg-primary shrink-0 mt-1.5" />}
      </button>
    </li>
  );
}

export default function NotificationList({ onNavigate }: { onNavigate: () => void }) {
  const { data, isLoading, fetchNextPage, hasNextPage, isFetchingNextPage } = useNotifications();
  const notifications = data?.pages.flatMap((p) => p.notifications) ?? [];

  if (isLoading) {
    return <div className="p-4 text-sm text-base-content/50">Loading…</div>;
  }

  if (notifications.length === 0) {
    return <div className="p-4 text-sm text-base-content/50">No notifications yet</div>;
  }

  return (
    <div className="max-h-96 overflow-y-auto">
      <ul className="menu menu-sm p-0">
        {notifications.map((n) => (
          <NotificationRow key={n.id} notification={n} onNavigate={onNavigate} />
        ))}
      </ul>
      {hasNextPage && (
        <button
          type="button"
          className="btn btn-ghost btn-xs w-full"
          onClick={() => void fetchNextPage()}
          disabled={isFetchingNextPage}
        >
          {isFetchingNextPage ? "Loading…" : "Load more"}
        </button>
      )}
    </div>
  );
}
