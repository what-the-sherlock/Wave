import { useState, type FormEvent } from "react";
import toast from "react-hot-toast";
import { Copy, Trash2, X } from "lucide-react";
import { useCreateInvite, useInvites, useRevokeInvite } from "../hooks/useWorkspaces";
import type { WorkspaceRole } from "../types/workspace";

/**
 * The single implementation of "invite people" — previously buried inline
 * in Workspace Settings with no entry point anywhere else. Opened from the
 * sidebar footer, the Members page, and an empty-workspace prompt, all
 * sharing this one component instead of duplicating the form.
 */
export default function InviteModal({
  workspaceId,
  onClose,
}: {
  workspaceId: string;
  onClose: () => void;
}) {
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<WorkspaceRole>("MEMBER");
  const [lastInviteLink, setLastInviteLink] = useState<string | null>(null);
  const createInvite = useCreateInvite(workspaceId);
  const revokeInvite = useRevokeInvite(workspaceId);
  const { data: invites } = useInvites(workspaceId);

  const handleCreateInvite = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const invite = await createInvite.mutateAsync({
        email: inviteEmail.trim() || undefined,
        role: inviteRole,
      });
      const link = `${window.location.origin}/invite/${invite.token}`;
      setLastInviteLink(link);
      setInviteEmail("");
    } catch {
      // useCreateInvite already toasts the error.
    }
  };

  const copyLink = async (link: string) => {
    await navigator.clipboard.writeText(link);
    toast.success("Invite link copied");
  };

  return (
    <div className="modal modal-open">
      <div className="modal-box max-w-md">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-bold text-lg">Invite people</h3>
          <button type="button" className="btn btn-sm btn-circle btn-ghost" onClick={onClose}>
            <X className="size-4" />
          </button>
        </div>

        <form onSubmit={handleCreateInvite} className="space-y-3">
          <div className="form-control">
            <label className="label">
              <span className="label-text font-medium">Email (optional)</span>
            </label>
            <input
              type="email"
              className="input input-bordered w-full"
              placeholder="Leave blank for a shareable link"
              value={inviteEmail}
              onChange={(e) => setInviteEmail(e.target.value)}
              autoFocus
            />
          </div>

          <div className="form-control">
            <label className="label">
              <span className="label-text font-medium">Role</span>
            </label>
            <select
              className="select select-bordered w-full"
              value={inviteRole}
              onChange={(e) => setInviteRole(e.target.value as WorkspaceRole)}
            >
              <option value="MEMBER">Member</option>
              <option value="ADMIN">Admin</option>
            </select>
          </div>

          <button
            type="submit"
            className="btn btn-primary w-full"
            disabled={createInvite.isPending}
          >
            Create invite
          </button>
        </form>

        {lastInviteLink && (
          <div className="flex items-center gap-2 bg-base-200 rounded p-2 text-sm mt-4">
            <span className="truncate flex-1">{lastInviteLink}</span>
            <button type="button" className="btn btn-xs" onClick={() => copyLink(lastInviteLink)}>
              <Copy className="size-3" /> Copy
            </button>
          </div>
        )}

        {invites && invites.length > 0 && (
          <>
            <div className="divider" />
            <ul className="divide-y divide-base-300 max-h-48 overflow-y-auto">
              {invites.map((invite) => {
                const isActive =
                  !invite.revokedAt &&
                  new Date(invite.expiresAt) > new Date() &&
                  invite.useCount < invite.maxUses;
                return (
                  <li key={invite.id} className="flex items-center justify-between py-2 text-sm">
                    <div>
                      <p>{invite.email ?? "Shareable link"}</p>
                      <p className="text-base-content/50">
                        {invite.role} &middot; {invite.useCount}/{invite.maxUses} used
                        {!isActive && " · inactive"}
                      </p>
                    </div>
                    {isActive && (
                      <button
                        type="button"
                        className="btn btn-xs btn-ghost text-error"
                        onClick={() => revokeInvite.mutate(invite.id)}
                        title="Revoke invite"
                      >
                        <Trash2 className="size-4" />
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </div>
      <div className="modal-backdrop" onClick={onClose} />
    </div>
  );
}
