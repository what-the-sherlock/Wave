import { fileTypeFromBuffer } from "file-type";
import sharp from "sharp";
import { withServiceRoleScope } from "../../db/rlsScope.js";
import { logger } from "../../logging/logger.js";
import { getRealtimeEmitter } from "../../realtime/emitter.js";
import * as uploadRepo from "../../uploads/upload.repository.js";
import * as storageClient from "./storageAdminClient.js";

const THUMBNAIL_MAX_DIMENSION = 320;
/** file-type can only positively identify binary/container formats — plain
 * text has no reliable magic bytes, so these two declared types are exempt
 * from the "sniffed type must match declared type" check below (an
 * undetectable-by-design gap, not a missed one). */
const UNSNIFFABLE_MIME_TYPES = new Set(["text/plain", "text/csv"]);

/**
 * Downloads the just-uploaded object, verifies its actual content matches
 * the MIME type declared at presign time (the concrete defense against a
 * `.png` that is actually something else — docs/security-model.md §9), and
 * generates a thumbnail for images. Runs under service_role: it acts on an
 * attachment on behalf of the system, not a single user's RLS scope.
 */
export async function attachmentProcessHandler(data: { attachmentId: string }): Promise<void> {
  await withServiceRoleScope(async (tx) => {
    const attachment = await uploadRepo.findById(tx, data.attachmentId);
    if (!attachment) return; // deleted (e.g. by cleanup) before processing ran

    const buffer = Buffer.from(await storageClient.downloadObjectAsServiceRole(attachment.storagePath));
    const sniffed = await fileTypeFromBuffer(buffer);

    const mismatch =
      sniffed !== undefined
        ? sniffed.mime !== attachment.mimeType
        : !UNSNIFFABLE_MIME_TYPES.has(attachment.mimeType);

    if (mismatch) {
      logger.warn(
        { attachmentId: attachment.id, declared: attachment.mimeType, sniffed: sniffed?.mime },
        "attachment content does not match its declared MIME type — rejecting",
      );
      await storageClient.deleteObjectAsServiceRole(attachment.storagePath);
      await uploadRepo.deleteByIds(tx, [attachment.id]);
      return;
    }

    let thumbPath: string | null = null;
    let width: number | null = null;
    let height: number | null = null;

    if (attachment.mimeType.startsWith("image/")) {
      try {
        const image = sharp(buffer);
        const metadata = await image.metadata();
        width = metadata.width ?? null;
        height = metadata.height ?? null;

        const thumb = await image
          .resize(THUMBNAIL_MAX_DIMENSION, THUMBNAIL_MAX_DIMENSION, { fit: "inside", withoutEnlargement: true })
          .webp()
          .toBuffer();
        const candidateThumbPath = `${attachment.storagePath.replace(/\/[^/]+$/, "")}/thumb.webp`;
        await storageClient.uploadObjectAsServiceRole(candidateThumbPath, thumb, "image/webp");
        thumbPath = candidateThumbPath;
      } catch (err) {
        // A malformed image (e.g. truncated upload) degrades to "no
        // thumbnail" rather than failing the whole job — the original is
        // still a valid, downloadable attachment.
        logger.warn({ err, attachmentId: attachment.id }, "thumbnail generation failed");
      }
    }

    await uploadRepo.updateProcessedResult(tx, attachment.id, { width, height, thumbPath });

    // Only meaningful once the attachment has been attached to a sent
    // message; if the worker raced ahead of that (message_id still null),
    // there is no live view depending on this event — the attachment is
    // picked up normally the next time the message list is fetched.
    if (attachment.messageId) {
      getRealtimeEmitter().toUser(attachment.uploadedBy, "attachment.ready", {
        messageId: attachment.messageId,
        attachmentId: attachment.id,
        path: attachment.storagePath,
        thumbPath,
      });
    }
  });
}
