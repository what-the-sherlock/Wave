/** Mirrors backend/src/uploads/upload.schemas.ts — client-side checks here
 * are UX-only (fail fast before spending an upload round trip); the server
 * is the real gate. */
export const ALLOWED_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "application/pdf",
  "text/plain",
  "text/csv",
] as const;

export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
export const MAX_ATTACHMENTS_PER_MESSAGE = 4;
