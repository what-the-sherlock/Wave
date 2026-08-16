import { randomUUID } from "node:crypto";
import { withRlsScope } from "../db/rlsScope.js";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../errors/AppError.js";
import { getQueue } from "../queue/index.js";
import * as channelRepo from "../channels/channel.repository.js";
import * as channelMemberRepo from "../channels/channelMember.repository.js";
import * as uploadRepo from "./upload.repository.js";
import * as storageClient from "./storageClient.js";
import type { MessageAttachment } from "./upload.repository.js";
import { MAX_ATTACHMENTS_PER_MESSAGE } from "./upload.schemas.js";

const DOWNLOAD_URL_TTL_SECONDS = 300;

/** Strips path separators and anything outside a conservative safe set —
 * the sanitized name becomes the trailing path segment of the storage
 * object, so this is the one piece of the path scheme that's ever
 * client-influenced (docs/security-model.md §9). */
function sanitizeFilename(filename: string): string {
  const base = filename.replace(/^.*[/\\]/, "");
  const cleaned = base.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-200);
  return cleaned.length > 0 ? cleaned : "file";
}

export type PresignResult = {
  attachmentId: string;
  uploadUrl: string;
  storagePath: string;
};

export async function presignUpload(
  userId: string,
  accessToken: string,
  input: { channelId: string; filename: string; mimeType: string; size: number },
): Promise<PresignResult> {
  const { channelId, filename, mimeType, size } = input;

  const attachment = await withRlsScope({ userId }, async (tx) => {
    const channel = await channelRepo.findById(tx, channelId);
    if (!channel) {
      throw new NotFoundError("Channel not found");
    }
    const membership = await channelMemberRepo.findMembership(tx, channelId, userId);
    if (!membership) {
      throw new ForbiddenError("Join this channel first");
    }

    const storagePath = `${channel.workspaceId}/${channelId}/${randomUUID()}/${sanitizeFilename(filename)}`;
    return uploadRepo.insert(tx, {
      workspaceId: channel.workspaceId,
      channelId,
      messageId: null,
      uploadedBy: userId,
      storagePath,
      name: sanitizeFilename(filename),
      mimeType,
      sizeBytes: size,
    });
  });

  const signed = await storageClient.createSignedUploadUrl(accessToken, attachment.storagePath);

  // A short delay rather than immediate eligibility: the client uploads
  // directly to Storage right after this response, so the first processing
  // attempt racing ahead of that PUT is the common case, not the exception.
  // pg-boss's retry (attachment.process: retryLimit 5, retryDelay 10s)
  // covers the rest.
  await getQueue().send("attachment.process", { attachmentId: attachment.id }, { startAfterSeconds: 5 });

  return {
    attachmentId: attachment.id,
    uploadUrl: signed.url,
    storagePath: attachment.storagePath,
  };
}

/**
 * Called from message.service.ts's sendMessage, inside its own RLS-scoped
 * transaction. Verifies every attachment id actually belongs to this
 * uploader and this channel by comparing the DB row's own columns (set at
 * presign time from the server-resolved channel) — never by trusting or
 * re-parsing anything client-supplied. A mismatch is a 400, matching the
 * "cross-workspace path rejected" adversarial test.
 */
export async function attachToMessageInTx(
  tx: Parameters<typeof uploadRepo.attachToMessage>[0],
  attachmentIds: string[],
  messageId: string,
  userId: string,
  channelId: string,
): Promise<MessageAttachment[]> {
  if (attachmentIds.length === 0) return [];
  if (attachmentIds.length > MAX_ATTACHMENTS_PER_MESSAGE) {
    throw new ConflictError(`A message may have at most ${MAX_ATTACHMENTS_PER_MESSAGE} attachments`);
  }
  const attached = await uploadRepo.attachToMessage(tx, attachmentIds, messageId, userId, channelId);
  if (attached.length !== attachmentIds.length) {
    throw new ValidationError("One or more attachments could not be found in this channel");
  }
  return attached;
}

export async function getDownloadUrl(
  userId: string,
  accessToken: string,
  attachmentId: string,
  variant: "original" | "thumb" = "original",
): Promise<string> {
  const attachment = await withRlsScope({ userId }, (tx) => uploadRepo.findById(tx, attachmentId));
  // RLS's attach_select policy already means a non-member's lookup returns
  // nothing — undefined here is indistinguishable from "doesn't exist"
  // (docs/security-model.md §4).
  if (!attachment) {
    throw new NotFoundError("Attachment not found");
  }
  // Falls back to the original when no thumbnail exists yet (still
  // processing, generation failed, or a non-image type) — always returns
  // something displayable rather than a distinct error state to handle.
  const path = variant === "thumb" && attachment.thumbPath ? attachment.thumbPath : attachment.storagePath;
  const isImage = attachment.mimeType.startsWith("image/");
  return storageClient.createSignedDownloadUrl(
    accessToken,
    path,
    DOWNLOAD_URL_TTL_SECONDS,
    isImage ? undefined : attachment.name,
  );
}
