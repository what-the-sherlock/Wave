import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Search, X } from "lucide-react";
import { useSession } from "../hooks/useSession";
import { useWorkspaceMembers } from "../hooks/useWorkspaces";
import { useOpenDm } from "../hooks/useChannels";

/**
 * Wires `useOpenDm` — built in Phase 3, never called from anywhere until
 * now — to a searchable picker over the workspace roster. Opens (or
 * reuses) the DM and navigates straight there, matching `CreateChannelModal`'s
 * create-then-navigate pattern.
 */
export default function MemberPickerModal({
  workspaceId,
  workspaceSlug,
  onClose,
}: {
  workspaceId: string;
  workspaceSlug: string;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const { data: session } = useSession();
  const { data: members, isLoading } = useWorkspaceMembers(workspaceId);
  const openDm = useOpenDm(workspaceId);
  const navigate = useNavigate();

  const filtered = useMemo(() => {
    const others = (members ?? []).filter((m) => m.userId !== session?.id);
    const q = query.trim().toLowerCase();
    if (!q) return others;
    return others.filter((m) => m.fullName.toLowerCase().includes(q));
  }, [members, session?.id, query]);

  const startDm = async (userId: string) => {
    try {
      const channel = await openDm.mutateAsync(userId);
      onClose();
      navigate(`/w/${workspaceSlug}/c/${channel.id}`);
    } catch {
      // useOpenDm already toasts the error.
    }
  };

  return (
    <div className="modal modal-open">
      <div className="modal-box max-w-md">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-bold text-lg">New message</h3>
          <button type="button" className="btn btn-sm btn-circle btn-ghost" onClick={onClose}>
            <X className="size-4" />
          </button>
        </div>

        <div className="relative mb-3">
          <Search className="size-4 absolute left-3 top-1/2 -translate-y-1/2 text-base-content/40" />
          <input
            type="text"
            className="input input-bordered w-full pl-9"
            placeholder="Search people..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoFocus
          />
        </div>

        <ul className="menu menu-sm max-h-72 overflow-y-auto">
          {isLoading && <li className="px-3 py-2 text-base-content/50">Loading...</li>}
          {!isLoading && filtered.length === 0 && (
            <li className="px-3 py-2 text-base-content/50">No one found</li>
          )}
          {filtered.map((member) => (
            <li key={member.userId}>
              <button
                type="button"
                className="flex items-center gap-3"
                onClick={() => startDm(member.userId)}
                disabled={openDm.isPending}
              >
                <div className="avatar placeholder shrink-0">
                  <div className="bg-neutral text-neutral-content rounded-full w-8">
                    {member.avatarUrl ? (
                      <img src={member.avatarUrl} alt={member.fullName} />
                    ) : (
                      <span>{member.fullName.slice(0, 1).toUpperCase()}</span>
                    )}
                  </div>
                </div>
                <span className="truncate">{member.fullName}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
      <div className="modal-backdrop" onClick={onClose} />
    </div>
  );
}
