import { z } from "zod";

export const listNotificationsQuerySchema = z.object({
  // Cursor: the `createdAt` of the last notification already seen (ISO
  // 8601). Omitted for the first page. Mirrors the simplicity of
  // channel.schemas.ts's before/after cursors, minus the numeric seq
  // notifications don't have.
  before: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
});
export type ListNotificationsQuery = z.infer<typeof listNotificationsQuerySchema>;
