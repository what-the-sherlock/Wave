import { useEffect, useRef, useState } from "react";
import { Bell, BellOff, MoreVertical, Users } from "lucide-react";
import { useMuteChannel } from "../hooks/useChannels";

const MUTE_OPTIONS: { label: string; hours: number | null }[] = [
  { label: "Mute for 1 hour", hours: 1 },
  { label: "Mute for 8 hours", hours: 8 },
  { label: "Mute until I turn it back on", hours: null },
];

function isMuted(mutedUntil: string | null): boolean {
  return Boolean(mutedUntil && new Date(mutedUntil).getTime() > Date.now());
}

export default function ChannelMenu({
  channelId,
  mutedUntil,
  onViewMembers,
}: {
  channelId: string;
  mutedUntil: string | null | undefined;
  /** Omitted for DMs, which have no separate member roster worth viewing. */
  onViewMembers?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const muteChannel = useMuteChannel(channelId);
  const muted = isMuted(mutedUntil ?? null);

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

  const applyMute = (hours: number | null) => {
    const mutedUntilValue =
      hours === null ? new Date("9999-12-31T00:00:00Z").toISOString() : new Date(Date.now() + hours * 3600_000).toISOString();
    muteChannel.mutate(mutedUntilValue);
    setOpen(false);
  };

  const unmute = () => {
    muteChannel.mutate(null);
    setOpen(false);
  };

  return (
    <div className="relative ml-auto" ref={rootRef}>
      <button
        type="button"
        className="btn btn-xs btn-ghost btn-circle"
        onClick={() => setOpen((v) => !v)}
        title="Channel options"
      >
        {muted ? <BellOff className="size-4" /> : <MoreVertical className="size-4" />}
      </button>
      {open && (
        <ul className="menu menu-sm bg-base-100 border border-base-300 rounded-box absolute right-0 top-full mt-1 w-56 shadow-lg z-20">
          {onViewMembers && (
            <li>
              <button
                type="button"
                onClick={() => {
                  onViewMembers();
                  setOpen(false);
                }}
              >
                <Users className="size-4" /> View members
              </button>
            </li>
          )}
          {muted ? (
            <li>
              <button type="button" onClick={unmute}>
                <Bell className="size-4" /> Unmute channel
              </button>
            </li>
          ) : (
            MUTE_OPTIONS.map((opt) => (
              <li key={opt.label}>
                <button type="button" onClick={() => applyMute(opt.hours)}>
                  <BellOff className="size-4" /> {opt.label}
                </button>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}
