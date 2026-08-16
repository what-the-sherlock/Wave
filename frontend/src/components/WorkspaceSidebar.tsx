import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Hash, Lock, Plus, Settings, UserPlus, Users } from "lucide-react";
import { useChannels, useWorkspaceSocketJoin } from "../hooks/useChannels";
import { usePresence, usePresenceSocketSync } from "../hooks/usePresence";
import { useWorkspaceContext } from "./RequireWorkspace";
import CreateChannelModal from "./CreateChannelModal";
import InviteModal from "./InviteModal";
import MemberPickerModal from "./MemberPickerModal";
import SidebarSkeleton from "./skeletons/SidebarSkeleton";
import type { Channel } from "../types/channel";

function unreadCount(channel: Channel): number {
  return Math.max(0, channel.lastMessageSeq - (channel.lastReadSeq ?? 0));
}

function UnreadBadge({ count }: { count: number }) {
  if (count <= 0) return null;
  return <span className="badge badge-sm badge-primary ml-auto">{count > 99 ? "99+" : count}</span>;
}

export default function WorkspaceSidebar() {
  const workspace = useWorkspaceContext();
  const { channelId: activeChannelId } = useParams<{ channelId: string }>();
  const { data: channels, isLoading } = useChannels(workspace.id);
  const presence = usePresence(workspace.id);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showInviteModal, setShowInviteModal] = useState(false);
  const [showMemberPicker, setShowMemberPicker] = useState(false);
  useWorkspaceSocketJoin(workspace.id);
  usePresenceSocketSync(workspace.id);

  const canInvite = workspace.role === "OWNER" || workspace.role === "ADMIN";

  if (isLoading) {
    return <SidebarSkeleton />;
  }

  const named = (channels ?? []).filter((c) => c.type !== "DM");
  const dms = (channels ?? []).filter((c) => c.type === "DM");

  return (
    <aside className="h-full w-64 shrink-0 border-r border-base-300 flex flex-col bg-base-100">
      <div className="border-b border-base-300 p-4">
        <p className="font-bold truncate">{workspace.name}</p>
      </div>

      <div className="flex-1 overflow-y-auto py-2">
        {canInvite && workspace.memberCount <= 1 && (
          <div className="mx-3 mb-3 p-3 rounded-lg bg-primary/10 space-y-2">
            <p className="text-xs text-base-content/70">
              You&apos;re the only one here. Invite your team to start collaborating.
            </p>
            <button
              type="button"
              className="btn btn-xs btn-primary w-full"
              onClick={() => setShowInviteModal(true)}
            >
              <UserPlus className="size-3.5" /> Invite people
            </button>
          </div>
        )}

        <div className="px-3 py-1 flex items-center justify-between">
          <span className="text-xs font-semibold uppercase text-base-content/50">Channels</span>
          <button
            type="button"
            className="btn btn-xs btn-ghost btn-circle"
            onClick={() => setShowCreateModal(true)}
            title="Create a channel"
          >
            <Plus className="size-4" />
          </button>
        </div>
        <ul className="menu menu-sm px-1">
          {named.map((channel) => (
            <li key={channel.id}>
              <Link
                to={`/w/${workspace.slug}/c/${channel.id}`}
                className={channel.id === activeChannelId ? "active" : ""}
              >
                {channel.type === "PRIVATE" ? (
                  <Lock className="size-3.5" />
                ) : (
                  <Hash className="size-3.5" />
                )}
                <span className="truncate">{channel.name}</span>
                <UnreadBadge count={unreadCount(channel)} />
              </Link>
            </li>
          ))}
        </ul>

        <div className="px-3 py-1 mt-3 flex items-center justify-between">
          <span className="text-xs font-semibold uppercase text-base-content/50">
            Direct messages
          </span>
          <button
            type="button"
            className="btn btn-xs btn-ghost btn-circle"
            onClick={() => setShowMemberPicker(true)}
            title="New message"
          >
            <Plus className="size-4" />
          </button>
        </div>
        {dms.length > 0 && (
          <ul className="menu menu-sm px-1">
            {dms.map((dm) => (
              <li key={dm.id}>
                <Link
                  to={`/w/${workspace.slug}/c/${dm.id}`}
                  className={dm.id === activeChannelId ? "active" : ""}
                >
                  <div className="avatar placeholder relative shrink-0">
                    <div className="bg-neutral text-neutral-content rounded-full w-5">
                      {dm.dmPeer?.avatarUrl ? (
                        <img src={dm.dmPeer.avatarUrl} alt={dm.dmPeer.fullName} />
                      ) : (
                        <span className="text-[10px]">
                          {(dm.dmPeer?.fullName ?? "?").slice(0, 1).toUpperCase()}
                        </span>
                      )}
                    </div>
                    {dm.dmPeer && presence[dm.dmPeer.userId]?.status === "online" && (
                      <span className="absolute -bottom-0.5 -right-0.5 size-2 rounded-full bg-success border border-base-100" />
                    )}
                  </div>
                  <span className="truncate">{dm.dmPeer?.fullName ?? "Direct message"}</span>
                  <UnreadBadge count={unreadCount(dm)} />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="border-t border-base-300 p-2 space-y-1">
        {canInvite && (
          <button
            type="button"
            className="btn btn-sm btn-outline btn-primary w-full"
            onClick={() => setShowInviteModal(true)}
          >
            <UserPlus className="size-4" /> Invite people
          </button>
        )}
        <div className="flex gap-1">
          <Link to={`/w/${workspace.slug}/members`} className="btn btn-sm btn-ghost flex-1">
            <Users className="size-4" /> Members
          </Link>
          <Link to={`/w/${workspace.slug}/settings`} className="btn btn-sm btn-ghost flex-1">
            <Settings className="size-4" /> Settings
          </Link>
        </div>
      </div>

      {showCreateModal && (
        <CreateChannelModal
          workspaceId={workspace.id}
          workspaceSlug={workspace.slug}
          onClose={() => setShowCreateModal(false)}
        />
      )}
      {showInviteModal && (
        <InviteModal workspaceId={workspace.id} onClose={() => setShowInviteModal(false)} />
      )}
      {showMemberPicker && (
        <MemberPickerModal
          workspaceId={workspace.id}
          workspaceSlug={workspace.slug}
          onClose={() => setShowMemberPicker(false)}
        />
      )}
    </aside>
  );
}
