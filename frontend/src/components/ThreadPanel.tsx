import { X } from "lucide-react";
import { useSession } from "../hooks/useSession";
import { useChannelMembers } from "../hooks/useChannels";
import { useThreadReplies } from "../hooks/useMessages";
import MessageItem from "./MessageItem";
import MessageInput from "./MessageInput";
import type { WorkspaceRole } from "../types/workspace";

export default function ThreadPanel({
  channelId,
  threadRootId,
  workspaceRole,
  onClose,
}: {
  channelId: string;
  threadRootId: string;
  workspaceRole: WorkspaceRole;
  onClose: () => void;
}) {
  const { data: session } = useSession();
  const { data: members } = useChannelMembers(channelId);
  const { data: replies, isLoading } = useThreadReplies(channelId, threadRootId);

  const memberById = new Map((members ?? []).map((m) => [m.userId, m]));
  const canModerate = workspaceRole === "OWNER" || workspaceRole === "ADMIN";

  return (
    <aside className="w-96 shrink-0 border-l border-base-300 flex flex-col bg-base-100">
      <div className="border-b border-base-300 p-3 flex items-center justify-between">
        <span className="font-semibold text-sm">Thread</span>
        <button type="button" className="btn btn-xs btn-ghost btn-circle" onClick={onClose}>
          <X className="size-4" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {isLoading && <p className="text-sm text-base-content/50 p-4">Loading replies...</p>}
        {replies?.map((reply) => {
          const sender = memberById.get(reply.senderId);
          return (
            <MessageItem
              key={reply.id}
              message={reply}
              channelId={channelId}
              senderName={sender?.fullName ?? "Unknown"}
              senderAvatarUrl={sender?.avatarUrl ?? null}
              canModerate={canModerate}
              isOwn={reply.senderId === session?.id}
            />
          );
        })}
        {replies?.length === 0 && (
          <p className="text-sm text-base-content/50 p-4">No replies yet.</p>
        )}
      </div>

      <MessageInput channelId={channelId} threadRootId={threadRootId} />
    </aside>
  );
}
