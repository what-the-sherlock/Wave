import { X } from "lucide-react";
import { useChannelMembers } from "../hooks/useChannels";
import { useWorkspaceContext } from "./RequireWorkspace";
import { usePresence } from "../hooks/usePresence";

/**
 * A Discord-style member roster for the currently-open channel —
 * `useChannelMembers` already existed but was only ever used internally for
 * name lookups (sender names, mention autocomplete); this is its first
 * visible use. Shares the same `w-96` slot as `ThreadPanel`; `ChatContainer`
 * keeps the two mutually exclusive.
 */
export default function ChannelMembersPanel({
  channelId,
  onClose,
}: {
  channelId: string;
  onClose: () => void;
}) {
  const workspace = useWorkspaceContext();
  const { data: members, isLoading } = useChannelMembers(channelId);
  const presence = usePresence(workspace.id);

  const sorted = [...(members ?? [])].sort((a, b) => {
    if (a.role !== b.role) return a.role === "ADMIN" ? -1 : 1;
    return a.fullName.localeCompare(b.fullName);
  });

  return (
    <aside className="w-96 shrink-0 border-l border-base-300 flex flex-col bg-base-100">
      <div className="border-b border-base-300 p-3 flex items-center justify-between">
        <span className="font-semibold text-sm">Members{members ? ` (${members.length})` : ""}</span>
        <button type="button" className="btn btn-xs btn-ghost btn-circle" onClick={onClose}>
          <X className="size-4" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-2">
        {isLoading && <p className="text-sm text-base-content/50 p-2">Loading members...</p>}
        <ul className="menu menu-sm">
          {sorted.map((member) => (
            <li key={member.userId}>
              <div className="flex items-center gap-2 cursor-default hover:bg-transparent">
                <div className="avatar placeholder relative shrink-0">
                  <div className="bg-neutral text-neutral-content rounded-full w-7">
                    {member.avatarUrl ? (
                      <img src={member.avatarUrl} alt={member.fullName} />
                    ) : (
                      <span className="text-xs">{member.fullName.slice(0, 1).toUpperCase()}</span>
                    )}
                  </div>
                  {presence[member.userId]?.status === "online" && (
                    <span className="absolute -bottom-0.5 -right-0.5 size-2 rounded-full bg-success border border-base-100" />
                  )}
                </div>
                <span className="truncate flex-1">{member.fullName}</span>
                {member.role === "ADMIN" && (
                  <span className="badge badge-xs badge-secondary">Admin</span>
                )}
              </div>
            </li>
          ))}
        </ul>
      </div>
    </aside>
  );
}
