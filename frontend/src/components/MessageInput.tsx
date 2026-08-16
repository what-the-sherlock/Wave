import { useMemo, useRef, useState, type ClipboardEvent, type KeyboardEvent } from "react";
import { Paperclip, Send } from "lucide-react";
import toast from "react-hot-toast";
import { useChannelMembers } from "../hooks/useChannels";
import { useSendMessage } from "../hooks/useMessages";
import { useNotifyTyping } from "../hooks/useTyping";
import { usePresignUpload } from "../hooks/useUploads";
import Dropzone from "./Dropzone";
import UploadProgress, { type PendingUploadState } from "./UploadProgress";
import { ALLOWED_MIME_TYPES, MAX_ATTACHMENTS_PER_MESSAGE, MAX_UPLOAD_BYTES } from "../constants/uploads";
import type { ChannelMember } from "../types/channel";

type CompletedUpload = { localId: string; attachmentId: string };

/**
 * Mentions are resolved client-side: typing `@` opens a filtered dropdown of
 * channel members, and picking one records their id. At submit time, only
 * mentions whose `@FullName` text is still present in the body are sent —
 * simple, and avoids over-notifying someone the user tagged and then
 * deleted the tag for, without needing a full rich-text/contenteditable
 * mention system.
 */
export default function MessageInput({
  channelId,
  threadRootId,
}: {
  channelId: string;
  threadRootId?: string;
}) {
  const [body, setBody] = useState("");
  const [mentioned, setMentioned] = useState<Map<string, string>>(new Map()); // userId -> "@FullName"
  const [showMentionList, setShowMentionList] = useState(false);
  const [mentionQuery, setMentionQuery] = useState("");
  const [pendingUploads, setPendingUploads] = useState<PendingUploadState[]>([]);
  const [completedUploads, setCompletedUploads] = useState<CompletedUpload[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { data: members } = useChannelMembers(channelId);
  const sendMessage = useSendMessage(channelId);
  const notifyTyping = useNotifyTyping(threadRootId ? undefined : channelId);
  const presignUpload = usePresignUpload(channelId);

  const attachmentCount = pendingUploads.length + completedUploads.length;

  const filteredMembers = useMemo(() => {
    if (!members) return [];
    const q = mentionQuery.toLowerCase();
    return members.filter((m) => m.fullName.toLowerCase().includes(q)).slice(0, 8);
  }, [members, mentionQuery]);

  const handleChange = (value: string) => {
    setBody(value);
    if (value.length > body.length) {
      notifyTyping();
    }
    const cursor = textareaRef.current?.selectionStart ?? value.length;
    const uptoCursor = value.slice(0, cursor);
    const match = /@([^\s@]*)$/.exec(uptoCursor);
    if (match) {
      setShowMentionList(true);
      setMentionQuery(match[1] ?? "");
    } else {
      setShowMentionList(false);
    }
  };

  const pickMention = (member: ChannelMember) => {
    const cursor = textareaRef.current?.selectionStart ?? body.length;
    const uptoCursor = body.slice(0, cursor);
    const replaced = uptoCursor.replace(/@([^\s@]*)$/, `@${member.fullName} `);
    const next = replaced + body.slice(cursor);
    setBody(next);
    setMentioned((prev) => new Map(prev).set(member.userId, `@${member.fullName}`));
    setShowMentionList(false);
    textareaRef.current?.focus();
  };

  const handleFiles = (files: File[]) => {
    for (const file of files) {
      if (attachmentCount >= MAX_ATTACHMENTS_PER_MESSAGE) {
        toast.error(`A message may have at most ${MAX_ATTACHMENTS_PER_MESSAGE} attachments`);
        break;
      }
      if (!(ALLOWED_MIME_TYPES as readonly string[]).includes(file.type)) {
        toast.error(`${file.name}: unsupported file type`);
        continue;
      }
      if (file.size > MAX_UPLOAD_BYTES) {
        toast.error(`${file.name}: file is too large`);
        continue;
      }

      const localId = crypto.randomUUID();
      setPendingUploads((prev) => [...prev, { localId, name: file.name, status: "uploading" }]);
      presignUpload.mutate(file, {
        onSuccess: (result) => {
          setPendingUploads((prev) => prev.filter((u) => u.localId !== localId));
          setCompletedUploads((prev) => [...prev, { localId, attachmentId: result.attachmentId }]);
        },
        onError: () => {
          setPendingUploads((prev) =>
            prev.map((u) => (u.localId === localId ? { ...u, status: "error" } : u)),
          );
        },
      });
    }
  };

  const removeUpload = (localId: string) => {
    setPendingUploads((prev) => prev.filter((u) => u.localId !== localId));
    setCompletedUploads((prev) => prev.filter((u) => u.localId !== localId));
  };

  const handlePaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(e.clipboardData.files);
    if (files.length > 0) {
      handleFiles(files);
    }
  };

  const handleSubmit = () => {
    const trimmed = body.trim();
    const attachmentIds = completedUploads.map((u) => u.attachmentId);
    if (!trimmed && attachmentIds.length === 0) return;
    if (pendingUploads.length > 0) {
      toast("Wait for attachments to finish uploading", { icon: "⏳" });
      return;
    }

    const mentionedUserIds = [...mentioned.entries()]
      .filter(([, tag]) => trimmed.includes(tag))
      .map(([userId]) => userId);
    const mentionChannel = /(^|\s)@channel(\s|$)/.test(trimmed);

    sendMessage.mutate({ body: trimmed, threadRootId, mentionedUserIds, mentionChannel, attachmentIds });
    setBody("");
    setMentioned(new Map());
    setShowMentionList(false);
    setCompletedUploads([]);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !showMentionList) {
      e.preventDefault();
      handleSubmit();
    }
  };

  return (
    <div className="relative border-t border-base-300 p-3">
      {showMentionList && filteredMembers.length > 0 && (
        <ul className="menu menu-sm bg-base-100 border border-base-300 rounded-box absolute bottom-full mb-1 left-3 w-64 shadow-lg z-10">
          {filteredMembers.map((m) => (
            <li key={m.userId}>
              <button type="button" onClick={() => pickMention(m)}>
                {m.fullName}
              </button>
            </li>
          ))}
        </ul>
      )}
      <Dropzone onFiles={handleFiles}>
        <UploadProgress uploads={pendingUploads} onRemove={removeUpload} />
        <div className="flex items-end gap-2 mt-2">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept={ALLOWED_MIME_TYPES.join(",")}
            className="hidden"
            onChange={(e) => {
              handleFiles(Array.from(e.target.files ?? []));
              e.target.value = "";
            }}
          />
          <button
            type="button"
            className="btn btn-ghost btn-square shrink-0"
            onClick={() => fileInputRef.current?.click()}
            title="Attach a file"
            disabled={attachmentCount >= MAX_ATTACHMENTS_PER_MESSAGE}
          >
            <Paperclip className="size-4" />
          </button>
          <textarea
            ref={textareaRef}
            className="textarea textarea-bordered flex-1 resize-none min-h-[2.5rem]"
            rows={1}
            placeholder={threadRootId ? "Reply in thread..." : "Message..."}
            value={body}
            onChange={(e) => handleChange(e.target.value)}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
          />
          <button
            type="button"
            className="btn btn-primary btn-square shrink-0"
            onClick={handleSubmit}
            disabled={
              (!body.trim() && completedUploads.length === 0) || pendingUploads.length > 0
            }
          >
            <Send className="size-4" />
          </button>
        </div>
      </Dropzone>
    </div>
  );
}
