import { useEffect, useRef, useState } from "react";
import { MessageSquare, Pencil, Plus, Smile, Trash2 } from "lucide-react";
import { formatFullTimestamp, formatMessageTime } from "../lib/utils";
import { useDeleteMessage, useEditMessage, useToggleReaction } from "../hooks/useMessages";
import ImageAttachment from "./Lightbox";
import FileCard from "./FileCard";
import EmojiPicker from "./EmojiPicker";
import type { Message } from "../types/channel";

const QUICK_REACTIONS = ["👍", "🎉", "❤️", "😂", "👀", "🙌"];

/** A popup combining the six quick reactions with an expandable full
 * picker — used both from the hover toolbar's Smile button and from the
 * "+" beside existing reaction chips, so there is exactly one place this
 * behaviour is defined. */
function ReactionPopup({
  onPick,
  onClose,
  align = "right",
}: {
  onPick: (emoji: string) => void;
  onClose: () => void;
  align?: "left" | "right";
}) {
  const [expanded, setExpanded] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onClickOutside = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [onClose]);

  return (
    <div
      ref={rootRef}
      className={`absolute top-full mt-1 z-20 ${align === "right" ? "right-0" : "left-0"}`}
    >
      {expanded ? (
        <EmojiPicker onPick={onPick} />
      ) : (
        <div className="bg-base-100 border border-base-300 rounded-lg shadow-lg p-1 flex gap-0.5">
          {QUICK_REACTIONS.map((emoji) => (
            <button
              key={emoji}
              type="button"
              className="btn btn-xs btn-ghost text-base"
              onClick={() => onPick(emoji)}
            >
              {emoji}
            </button>
          ))}
          <button
            type="button"
            className="btn btn-xs btn-ghost"
            title="More emoji"
            onClick={() => setExpanded(true)}
          >
            <Plus className="size-3.5" />
          </button>
        </div>
      )}
    </div>
  );
}

export default function MessageItem({
  message,
  channelId,
  senderName,
  senderAvatarUrl,
  canModerate,
  isOwn,
  isGrouped = false,
  onOpenThread,
}: {
  message: Message;
  channelId: string;
  senderName: string;
  senderAvatarUrl: string | null;
  canModerate: boolean;
  isOwn: boolean;
  /** True when the previous rendered message was from the same sender
   * within the grouping window — collapses the avatar/name/timestamp
   * header, matching Discord/Slack-style consecutive-message grouping. */
  isGrouped?: boolean;
  onOpenThread?: (messageId: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.body ?? "");
  const [showReactionPicker, setShowReactionPicker] = useState(false);
  const [showAddPicker, setShowAddPicker] = useState(false);

  const editMessage = useEditMessage(channelId);
  const deleteMessage = useDeleteMessage(channelId);
  const toggleReaction = useToggleReaction(channelId);

  const isOptimistic = message.id.startsWith("optimistic-");
  const canEdit = (isOwn || canModerate) && !isOptimistic;

  const submitEdit = () => {
    if (!draft.trim()) return;
    editMessage.mutate({ messageId: message.id, body: draft.trim() });
    setEditing(false);
  };

  const react = (emoji: string) => {
    toggleReaction.mutate({ messageId: message.id, emoji });
    setShowReactionPicker(false);
    setShowAddPicker(false);
  };

  return (
    <div
      className={`group flex gap-3 px-4 hover:bg-base-200/50 relative ${isGrouped ? "py-0.5" : "py-1.5"}`}
    >
      <div className="w-9 shrink-0 flex items-start justify-center">
        {isGrouped ? (
          <span
            className="hidden group-hover:block text-[10px] text-base-content/40 mt-1"
            title={formatFullTimestamp(message.createdAt)}
          >
            {formatMessageTime(message.createdAt)}
          </span>
        ) : (
          <div className="avatar placeholder">
            <div className="bg-neutral text-neutral-content rounded-full w-9">
              {senderAvatarUrl ? (
                <img src={senderAvatarUrl} alt={senderName} />
              ) : (
                <span>{senderName.slice(0, 1).toUpperCase()}</span>
              )}
            </div>
          </div>
        )}
      </div>

      <div className="min-w-0 flex-1">
        {!isGrouped && (
          <div className="flex items-baseline gap-2">
            <span className="font-semibold text-sm">{senderName}</span>
            <span
              className="text-xs text-base-content/40"
              title={formatFullTimestamp(message.createdAt)}
            >
              {formatMessageTime(message.createdAt)}
            </span>
            {message.editedAt && <span className="text-xs text-base-content/40">(edited)</span>}
          </div>
        )}
        {isGrouped && message.editedAt && (
          <span className="text-xs text-base-content/40">(edited)</span>
        )}

        {editing ? (
          <div className="mt-1 space-y-1">
            <textarea
              className="textarea textarea-bordered textarea-sm w-full"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              autoFocus
            />
            <div className="flex gap-2">
              <button type="button" className="btn btn-xs btn-primary" onClick={submitEdit}>
                Save
              </button>
              <button type="button" className="btn btn-xs" onClick={() => setEditing(false)}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <p className="text-sm whitespace-pre-wrap break-words">{message.body}</p>
        )}

        {message.attachments.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {message.attachments.map((a) =>
              a.mimeType.startsWith("image/") ? (
                <ImageAttachment key={a.id} attachment={a} />
              ) : (
                <FileCard key={a.id} attachment={a} />
              ),
            )}
          </div>
        )}

        {message.reactions.length > 0 && (
          <div className="flex flex-wrap items-center gap-1 mt-1">
            {message.reactions.map((r) => (
              <button
                key={r.emoji}
                type="button"
                className={`btn btn-xs gap-1 ${r.me ? "btn-primary btn-outline" : "btn-outline"}`}
                onClick={() => toggleReaction.mutate({ messageId: message.id, emoji: r.emoji })}
                title={r.me ? "Remove your reaction" : "React"}
              >
                <span>{r.emoji}</span>
                <span>{r.count}</span>
              </button>
            ))}
            {!isOptimistic && (
              <div className="relative">
                <button
                  type="button"
                  className="btn btn-xs btn-ghost opacity-0 group-hover:opacity-100"
                  title="Add reaction"
                  onClick={() => setShowAddPicker((v) => !v)}
                >
                  <Plus className="size-3.5" />
                </button>
                {showAddPicker && (
                  <ReactionPopup
                    onPick={react}
                    onClose={() => setShowAddPicker(false)}
                    align="left"
                  />
                )}
              </div>
            )}
          </div>
        )}

        {!message.threadRootId && message.replyCount > 0 && onOpenThread && (
          <button
            type="button"
            className="btn btn-xs btn-ghost mt-1 text-primary"
            onClick={() => onOpenThread(message.id)}
          >
            <MessageSquare className="size-3.5" />
            {message.replyCount} {message.replyCount === 1 ? "reply" : "replies"}
          </button>
        )}
      </div>

      {!isOptimistic && !editing && (
        <div className="hidden group-hover:flex items-center gap-0.5 absolute right-3 top-0 bg-base-100 border border-base-300 rounded-lg shadow-sm">
          <div className="relative">
            <button
              type="button"
              className="btn btn-xs btn-ghost"
              onClick={() => setShowReactionPicker((v) => !v)}
              title="React"
            >
              <Smile className="size-3.5" />
            </button>
            {showReactionPicker && (
              <ReactionPopup onPick={react} onClose={() => setShowReactionPicker(false)} />
            )}
          </div>
          {!message.threadRootId && onOpenThread && (
            <button
              type="button"
              className="btn btn-xs btn-ghost"
              onClick={() => onOpenThread(message.id)}
              title="Reply in thread"
            >
              <MessageSquare className="size-3.5" />
            </button>
          )}
          {canEdit && (
            <button
              type="button"
              className="btn btn-xs btn-ghost"
              onClick={() => setEditing(true)}
              title="Edit"
            >
              <Pencil className="size-3.5" />
            </button>
          )}
          {canEdit && (
            <button
              type="button"
              className="btn btn-xs btn-ghost text-error"
              onClick={() => deleteMessage.mutate(message.id)}
              title="Delete"
            >
              <Trash2 className="size-3.5" />
            </button>
          )}
        </div>
      )}
    </div>
  );
}
