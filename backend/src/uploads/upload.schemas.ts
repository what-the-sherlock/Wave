import { z } from "zod";
import { config } from "../config/env.js";

/**
 * Allowlist, never a denylist (docs/security-model.md §9). Deliberately
 * short: images plus a handful of document types. `attachment.process`'s
 * magic-byte sniffing is the actual enforcement — this list is only the
 * first, cheap gate.
 */
export const ALLOWED_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "application/pdf",
  "text/plain",
  "text/csv",
] as const;

export const MAX_ATTACHMENTS_PER_MESSAGE = 4;

export const presignSchema = z.object({
  channelId: z.string().uuid(),
  filename: z.string().trim().min(1).max(255),
  mimeType: z.enum(ALLOWED_MIME_TYPES),
  size: z
    .number()
    .int()
    .positive()
    .max(config.MAX_UPLOAD_MB * 1024 * 1024, `File must be ${config.MAX_UPLOAD_MB}MB or smaller`),
});
export type PresignBody = z.infer<typeof presignSchema>;
