import { CheckCheck } from "lucide-react";
import NotificationList from "./NotificationList";
import { useMarkAllNotificationsRead } from "../hooks/useNotifications";

export default function NotificationDropdown({ onNavigate }: { onNavigate: () => void }) {
  const markAllRead = useMarkAllNotificationsRead();

  return (
    <div className="bg-base-100 border border-base-300 rounded-box shadow-lg w-80">
      <div className="flex items-center justify-between px-3 py-2 border-b border-base-300">
        <span className="font-semibold text-sm">Notifications</span>
        <button
          type="button"
          className="btn btn-ghost btn-xs gap-1"
          onClick={() => markAllRead.mutate()}
          disabled={markAllRead.isPending}
        >
          <CheckCheck className="size-3.5" /> Mark all read
        </button>
      </div>
      <NotificationList onNavigate={onNavigate} />
    </div>
  );
}
