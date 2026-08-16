import { and, asc, desc, eq, gt, isNull, lt, sql } from "drizzle-orm";
import type { Tx } from "../db/rlsScope.js";
import { messages } from "../db/schema.js";
import type { Message } from "../db/schema.js";

export type { Message, NewMessage } from "../db/schema.js";

/** The shape a raw `tx.execute()` call actually returns: plain Postgres
 * column names (snake_case), unlike Drizzle's query-builder reads which map
 * to the camelCase `Message` type automatically. Raw SQL gets none of that
 * mapping for free — see `rowToMessage` below. */
type RawMessageRow = {
  id: string;
  workspace_id: string;
  channel_id: string;
  seq: number;
  sender_id: string;
  body: string | null;
  client_msg_id: string;
  thread_root_id: string | null;
  reply_count: number;
  last_reply_at: Date | null;
  edited_at: Date | null;
  deleted_at: Date | null;
  deleted_by: string | null;
  created_at: Date;
};

function rowToMessage(row: RawMessageRow): Message {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    channelId: row.channel_id,
    seq: row.seq,
    senderId: row.sender_id,
    body: row.body,
    clientMsgId: row.client_msg_id,
    threadRootId: row.thread_root_id,
    replyCount: row.reply_count,
    lastReplyAt: row.last_reply_at,
    editedAt: row.edited_at,
    deletedAt: row.deleted_at,
    deletedBy: row.deleted_by,
    createdAt: row.created_at,
  };
}

/**
 * Calls `send_message()` — the single-statement atomic, idempotent insert
 * with sequence assignment (docs/database-design.md §7). One round trip; a
 * retry with the same `clientMsgId` never burns a sequence number or
 * creates a second row.
 */
export async function sendMessage(
  tx: Tx,
  channelId: string,
  body: string,
  clientMsgId: string,
  threadRootId: string | null,
): Promise<Message> {
  const result = await tx.execute<RawMessageRow>(
    sql`select * from send_message(${channelId}, ${body}, ${clientMsgId}, ${threadRootId})`,
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error("send_message returned no row");
  }
  return rowToMessage(row);
}

export async function findById(tx: Tx, messageId: string): Promise<Message | undefined> {
  const [row] = await tx.select().from(messages).where(eq(messages.id, messageId)).limit(1);
  return row;
}

const MAX_PAGE_SIZE = 100;

export type MessagePage = { messages: Message[]; hasMore: boolean };

/**
 * Cursor pagination on `seq`, thread replies excluded (they surface only in
 * the thread panel via `listThreadReplies`) — the app breaks visibly past
 * ~1,000 messages without this (docs/implementation-roadmap.md "Not cut,
 * and worth defending").
 *
 * `beforeSeq` (newest-first) backs scrollback; `afterSeq` (oldest-first)
 * backs reconnect gap replay — `GET /messages?after={seq}` in
 * docs/realtime-architecture.md §7. The two are mutually exclusive
 * (enforced by `listMessagesQuerySchema`'s `.refine`), and reads the same
 * `(channel_id, seq)` index in either scan direction.
 */
export async function listByChannel(
  tx: Tx,
  channelId: string,
  opts: { beforeSeq?: number; afterSeq?: number; limit?: number },
): Promise<MessagePage> {
  const limit = Math.min(opts.limit ?? 50, MAX_PAGE_SIZE);
  const conditions = [
    eq(messages.channelId, channelId),
    isNull(messages.deletedAt),
    isNull(messages.threadRootId),
  ];

  if (opts.afterSeq !== undefined) {
    conditions.push(gt(messages.seq, opts.afterSeq));
    const rows = await tx
      .select()
      .from(messages)
      .where(and(...conditions))
      .orderBy(asc(messages.seq))
      .limit(limit + 1);
    return { messages: rows.slice(0, limit), hasMore: rows.length > limit };
  }

  if (opts.beforeSeq !== undefined) {
    conditions.push(lt(messages.seq, opts.beforeSeq));
  }

  const rows = await tx
    .select()
    .from(messages)
    .where(and(...conditions))
    .orderBy(desc(messages.seq))
    .limit(limit + 1);

  return { messages: rows.slice(0, limit), hasMore: rows.length > limit };
}

/** Distinct senders across a thread's replies (root message excluded — the
 * caller already knows the root's own sender). Used by the
 * notification.fanout worker to resolve "thread subscribers": there is no
 * explicit subscription table, so anyone who has posted in the thread is
 * treated as a subscriber to further replies. */
export async function listThreadParticipantIds(tx: Tx, threadRootId: string): Promise<string[]> {
  const rows = await tx
    .selectDistinct({ senderId: messages.senderId })
    .from(messages)
    .where(and(eq(messages.threadRootId, threadRootId), isNull(messages.deletedAt)));
  return rows.map((r) => r.senderId);
}

export async function listThreadReplies(tx: Tx, threadRootId: string): Promise<Message[]> {
  return tx
    .select()
    .from(messages)
    .where(and(eq(messages.threadRootId, threadRootId), isNull(messages.deletedAt)))
    .orderBy(messages.seq);
}

export async function update(
  tx: Tx,
  messageId: string,
  body: string,
): Promise<Message | undefined> {
  const [row] = await tx
    .update(messages)
    .set({ body, editedAt: new Date() })
    .where(eq(messages.id, messageId))
    .returning();
  return row;
}

/** Soft delete with tombstone — the row (and its seq, preserving ordering
 * and thread reply counts) stays; the body is cleared. */
export async function softDelete(
  tx: Tx,
  messageId: string,
  deletedBy: string,
): Promise<Message | undefined> {
  const [row] = await tx
    .update(messages)
    .set({ body: null, deletedAt: new Date(), deletedBy })
    .where(eq(messages.id, messageId))
    .returning();
  return row;
}
