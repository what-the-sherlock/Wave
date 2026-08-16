import { and, count, desc, eq, isNull, lt } from "drizzle-orm";
import type { Tx } from "../db/rlsScope.js";
import { notifications } from "../db/schema.js";
import type { NewNotification, Notification } from "../db/schema.js";

export type { Notification, NewNotification } from "../db/schema.js";

const MAX_PAGE_SIZE = 50;
const DEFAULT_PAGE_SIZE = 30;

export type NotificationPage = { notifications: Notification[]; hasMore: boolean };

export async function listForUser(
  tx: Tx,
  userId: string,
  opts: { before?: Date; limit?: number },
): Promise<NotificationPage> {
  const limit = Math.min(opts.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
  const conditions = [eq(notifications.userId, userId)];
  if (opts.before) {
    conditions.push(lt(notifications.createdAt, opts.before));
  }

  const rows = await tx
    .select()
    .from(notifications)
    .where(and(...conditions))
    .orderBy(desc(notifications.createdAt))
    .limit(limit + 1);

  return { notifications: rows.slice(0, limit), hasMore: rows.length > limit };
}

export async function unreadCount(tx: Tx, userId: string): Promise<number> {
  const [row] = await tx
    .select({ value: count() })
    .from(notifications)
    .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)));
  return row?.value ?? 0;
}

export async function markRead(
  tx: Tx,
  userId: string,
  notificationId: string,
): Promise<Notification | undefined> {
  const [row] = await tx
    .update(notifications)
    .set({ readAt: new Date() })
    .where(and(eq(notifications.id, notificationId), eq(notifications.userId, userId)))
    .returning();
  return row;
}

export async function markAllRead(tx: Tx, userId: string): Promise<void> {
  await tx
    .update(notifications)
    .set({ readAt: new Date() })
    .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)));
}

/**
 * Idempotent bulk insert for the notification.fanout worker: rows that
 * collide with the `unique(user_id, message_id, type)` constraint (a retried
 * job re-running the same fan-out) are silently dropped. Returns only the
 * rows actually inserted, so the caller emits `notification.created`/queues
 * `email.send` only for what's genuinely new on this run.
 */
export async function insertManyIfAbsent(
  tx: Tx,
  rows: NewNotification[],
): Promise<Notification[]> {
  if (rows.length === 0) return [];
  return tx
    .insert(notifications)
    .values(rows)
    .onConflictDoNothing({ target: [notifications.userId, notifications.messageId, notifications.type] })
    .returning();
}

export async function findById(tx: Tx, notificationId: string): Promise<Notification | undefined> {
  const [row] = await tx.select().from(notifications).where(eq(notifications.id, notificationId)).limit(1);
  return row;
}

export async function markEmailed(tx: Tx, notificationId: string): Promise<void> {
  await tx.update(notifications).set({ emailedAt: new Date() }).where(eq(notifications.id, notificationId));
}
