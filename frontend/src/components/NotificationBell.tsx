import { useEffect, useRef, useState } from "react";
import { Bell } from "lucide-react";
import { useUnreadCount } from "../hooks/useNotifications";
import NotificationDropdown from "./NotificationDropdown";

export default function NotificationBell() {
  const { data: count = 0 } = useUnreadCount();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClickOutside = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [open]);

  return (
    <div className="relative" ref={rootRef}>
      <button
        type="button"
        className="btn btn-sm btn-ghost btn-circle relative"
        onClick={() => setOpen((v) => !v)}
        title="Notifications"
      >
        <Bell className="size-5" />
        {count > 0 && (
          <span className="absolute -top-0.5 -right-0.5 badge badge-xs badge-primary px-1">
            {count > 99 ? "99+" : count}
          </span>
        )}
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-2 z-50">
          <NotificationDropdown onNavigate={() => setOpen(false)} />
        </div>
      )}
    </div>
  );
}
