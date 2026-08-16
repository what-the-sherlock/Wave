import { and, eq, inArray, isNull, lt } from "drizzle-orm";
import type { Tx } from "../db/rlsScope.js";
import { messageAttachments } from "../db/schema.js";
import type { MessageAttachment, NewMessageAttachment } from "../db/schema.js";

export type { MessageAttachment, NewMessageAttachment } from "../db/schema.js";

export async function insert(tx: Tx, data: NewMessageAttachment): Promise<MessageAttachment> {
  const [row] = await tx.insert(messageAttachments).values(data).returning();
  if (!row) {
    throw new Error("message_attachments insert returned no row");
  }
  return row;
}

export async function findById(tx: Tx, id: string): Promise<MessageAttachment | undefined> {
  const [row] = await tx.select().from(messageAttachments).where(eq(messageAttachments.id, id)).limit(1);
  return row;
}

export async function findByIds(tx: Tx, ids: string[]): Promise<MessageAttachment[]> {
  if (ids.length === 0) return [];
  return tx.select().from(messageAttachments).where(inArray(messageAttachments.id, ids));
}

/**
 * Bulk-attaches unattached uploads to a just-sent message, scoped to the
 * uploader and the message's own channel — this WHERE clause, not a
 * re-parse of the storage path string, is what stops attaching an upload
 * reserved for a different channel/workspace (docs/security-model.md §9's
 * cross-workspace path check). Rows outside these bounds are silently
 * excluded from the update; `upload.service.ts` compares the returned count
 * against the requested id count to detect and reject that case.
 */
export async function attachToMessage(
  tx: Tx,
  attachmentIds: string[],
  messageId: string,
  uploadedBy: string,
  channelId: string,
): Promise<MessageAttachment[]> {
  if (attachmentIds.length === 0) return [];
  return tx
    .update(messageAttachments)
    .set({ messageId })
    .where(
      and(
        inArray(messageAttachments.id, attachmentIds),
        eq(messageAttachments.uploadedBy, uploadedBy),
        eq(messageAttachments.channelId, channelId),
        isNull(messageAttachments.messageId),
      ),
    )
    .returning();
}

export async function listByMessageIds(tx: Tx, messageIds: string[]): Promise<MessageAttachment[]> {
  if (messageIds.length === 0) return [];
  return tx
    .select()
    .from(messageAttachments)
    .where(inArray(messageAttachments.messageId, messageIds));
}

export async function updateProcessedResult(
  tx: Tx,
  id: string,
  patch: { width: number | null; height: number | null; thumbPath: string | null },
): Promise<void> {
  await tx.update(messageAttachments).set(patch).where(eq(messageAttachments.id, id));
}

/** Orphans: never attached to a message, older than `cutoff`. Used by
 * cleanupOrphans.worker.ts. */
export async function findOrphansOlderThan(tx: Tx, cutoff: Date): Promise<MessageAttachment[]> {
  return tx
    .select()
    .from(messageAttachments)
    .where(and(isNull(messageAttachments.messageId), lt(messageAttachments.createdAt, cutoff)));
}

export async function deleteByIds(tx: Tx, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await tx.delete(messageAttachments).where(inArray(messageAttachments.id, ids));
}
