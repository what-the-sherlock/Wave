import { and, count, eq, inArray, sql } from "drizzle-orm";
import type { Tx } from "../db/rlsScope.js";
import { messageReactions } from "../db/schema.js";
import type { MessageReaction, NewMessageReaction } from "../db/schema.js";

export type { MessageReaction, NewMessageReaction } from "../db/schema.js";

export type ReactionCount = { messageId: string; emoji: string; count: number; me: boolean };

/** Aggregate counts for a page of messages in one query — feeds the
 * message-list response so reaction pills survive a reload instead of only
 * appearing for the current session's live socket events. `me` (via
 * `bool_or`, same aggregate query, no extra round trip) is what lets the
 * client highlight the viewer's own reactions and know which toggle a click
 * will perform without guessing from local-only state. */
export async function countsByMessageIds(
  tx: Tx,
  messageIds: string[],
  viewerUserId: string,
): Promise<ReactionCount[]> {
  if (messageIds.length === 0) return [];
  return tx
    .select({
      messageId: messageReactions.messageId,
      emoji: messageReactions.emoji,
      count: count(),
      me: sql<boolean>`bool_or(${messageReactions.userId} = ${viewerUserId})`,
    })
    .from(messageReactions)
    .where(inArray(messageReactions.messageId, messageIds))
    .groupBy(messageReactions.messageId, messageReactions.emoji);
}

export async function find(
  tx: Tx,
  messageId: string,
  userId: string,
  emoji: string,
): Promise<MessageReaction | undefined> {
  const [row] = await tx
    .select()
    .from(messageReactions)
    .where(
      and(
        eq(messageReactions.messageId, messageId),
        eq(messageReactions.userId, userId),
        eq(messageReactions.emoji, emoji),
      ),
    )
    .limit(1);
  return row;
}

export async function listByMessage(tx: Tx, messageId: string): Promise<MessageReaction[]> {
  return tx.select().from(messageReactions).where(eq(messageReactions.messageId, messageId));
}

export async function add(tx: Tx, data: NewMessageReaction): Promise<MessageReaction> {
  const [row] = await tx.insert(messageReactions).values(data).returning();
  if (!row) {
    throw new Error("message_reactions insert returned no row");
  }
  return row;
}

export async function remove(
  tx: Tx,
  messageId: string,
  userId: string,
  emoji: string,
): Promise<boolean> {
  const rows = await tx
    .delete(messageReactions)
    .where(
      and(
        eq(messageReactions.messageId, messageId),
        eq(messageReactions.userId, userId),
        eq(messageReactions.emoji, emoji),
      ),
    )
    .returning({ id: messageReactions.id });
  return rows.length > 0;
}
