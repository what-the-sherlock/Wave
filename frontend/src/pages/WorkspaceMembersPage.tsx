import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ArrowLeft, Crown, MessageCircle, Shield, UserMinus, UserPlus } from "lucide-react";
import { useSession } from "../hooks/useSession";
import { useWorkspaceContext } from "../components/RequireWorkspace";
import { useRemoveMember, useUpdateMemberRole, useWorkspaceMembers } from "../hooks/useWorkspaces";
import { useOpenDm, useWorkspaceSocketJoin } from "../hooks/useChannels";
import { usePresence, usePresenceSocketSync } from "../hooks/usePresence";
import InviteModal from "../components/InviteModal";
import type { WorkspaceMember, WorkspaceRole } from "../types/workspace";

const ROLE_BADGE: Record<WorkspaceRole, string> = {
  OWNER: "badge-primary",
  ADMIN: "badge-secondary",
  MEMBER: "badge-ghost",
};

function canManage(actorRole: WorkspaceRole, target: WorkspaceMember): boolean {
  if (target.role === "OWNER") return false;
  if (actorRole === "OWNER") return true;
  if (actorRole === "ADMIN") return target.role === "MEMBER";
  return false;
}

const WorkspaceMembersPage = () => {
  const workspace = useWorkspaceContext();
  const navigate = useNavigate();
  const { data: session } = useSession();
  const { data: members, isLoading } = useWorkspaceMembers(workspace.id);
  const updateRole = useUpdateMemberRole(workspace.id);
  const removeMember = useRemoveMember(workspace.id);
  const openDm = useOpenDm(workspace.id);
  const presence = usePresence(workspace.id);
  const [showInviteModal, setShowInviteModal] = useState(false);
  useWorkspaceSocketJoin(workspace.id);
  usePresenceSocketSync(workspace.id);

  const canInvite = workspace.role === "OWNER" || workspace.role === "ADMIN";

  const messageMember = async (userId: string) => {
    try {
      const channel = await openDm.mutateAsync(userId);
      navigate(`/w/${workspace.slug}/c/${channel.id}`);
    } catch {
      // useOpenDm already toasts the error.
    }
  };

  return (
    <div className="min-h-screen bg-base-200 pt-20 px-4">
      <div className="max-w-2xl mx-auto space-y-6">
        <Link to={`/w/${workspace.slug}`} className="link link-hover inline-flex items-center gap-1 text-sm">
          <ArrowLeft className="size-4" /> Back to {workspace.name}
        </Link>

        <div className="bg-base-100 rounded-lg shadow-cl p-6 space-y-4">
          <div className="flex items-center justify-between gap-3">
            <h1 className="text-xl font-bold">Members</h1>
            {canInvite && (
              <button
                type="button"
                className="btn btn-sm btn-primary"
                onClick={() => setShowInviteModal(true)}
              >
                <UserPlus className="size-4" /> Invite people
              </button>
            )}
          </div>

          {isLoading && <p className="text-base-content/60">Loading members...</p>}

          <ul className="divide-y divide-base-300">
            {members?.map((member) => {
              const isSelf = member.userId === session?.id;
              const manageable = canManage(workspace.role, member) && !isSelf;
              return (
                <li key={member.userId} className="flex items-center justify-between py-3 gap-3">
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="avatar placeholder relative">
                      <div className="bg-neutral text-neutral-content rounded-full w-10">
                        <span>{member.fullName.slice(0, 1).toUpperCase()}</span>
                      </div>
                      {presence[member.userId]?.status === "online" && (
                        <span
                          className="absolute bottom-0 right-0 size-2.5 rounded-full bg-success border-2 border-base-100"
                          title="Online"
                        />
                      )}
                    </div>
                    <div className="min-w-0">
                      <p className="font-medium truncate">
                        {member.fullName}
                        {isSelf && <span className="text-base-content/50"> (you)</span>}
                      </p>
                      <span className={`badge badge-sm ${ROLE_BADGE[member.role]}`}>
                        {member.role === "OWNER" && <Crown className="size-3 mr-1" />}
                        {member.role === "ADMIN" && <Shield className="size-3 mr-1" />}
                        {member.role}
                      </span>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    {!isSelf && (
                      <button
                        type="button"
                        className="btn btn-xs btn-ghost"
                        onClick={() => messageMember(member.userId)}
                        disabled={openDm.isPending}
                        title={`Message ${member.fullName}`}
                      >
                        <MessageCircle className="size-4" />
                      </button>
                    )}
                    {manageable && (
                      <>
                      {member.role === "MEMBER" && workspace.role === "OWNER" && (
                        <button
                          type="button"
                          className="btn btn-xs"
                          onClick={() =>
                            updateRole.mutate({ userId: member.userId, role: "ADMIN" })
                          }
                        >
                          Make admin
                        </button>
                      )}
                      {member.role === "ADMIN" && workspace.role === "OWNER" && (
                        <button
                          type="button"
                          className="btn btn-xs"
                          onClick={() =>
                            updateRole.mutate({ userId: member.userId, role: "MEMBER" })
                          }
                        >
                          Remove admin
                        </button>
                      )}
                      <button
                        type="button"
                        className="btn btn-xs btn-ghost text-error"
                        onClick={() => removeMember.mutate(member.userId)}
                        title="Remove from workspace"
                      >
                        <UserMinus className="size-4" />
                      </button>
                      </>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      </div>

      {showInviteModal && (
        <InviteModal workspaceId={workspace.id} onClose={() => setShowInviteModal(false)} />
      )}
    </div>
  );
};

export default WorkspaceMembersPage;
