import { and, asc, eq, gt, isNull } from "drizzle-orm";
import type { Tx } from "../db/rlsScope.js";
import { channelMembers, messages } from "../db/schema.js";
import type { Message } from "../db/schema.js";

export type UnreadWindow = {
  messages: Message[];
  truncated: boolean;
  lastReadSeq: number;
};

/**
 * The catch-up window is defined exactly by the read watermark, not a "last
 * 24 hours" heuristic (docs/ai-architecture.md §3.1) — `last_read_seq`
 * already exists for the unread badge (Phase 4); this is its second payoff.
 * Capped at `limit` (+1 to detect truncation) — the free-tier catch-up cap
 * is 200, per docs/free-tier-plan.md §4.
 */
export async function fetchUnreadWindow(
  tx: Tx,
  channelId: string,
  userId: string,
  limit: number,
): Promise<UnreadWindow | undefined> {
  const [membership] = await tx
    .select({ lastReadSeq: channelMembers.lastReadSeq })
    .from(channelMembers)
    .where(and(eq(channelMembers.channelId, channelId), eq(channelMembers.userId, userId)))
    .limit(1);
  if (!membership) return undefined;

  const rows = await tx
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.channelId, channelId),
        isNull(messages.deletedAt),
        isNull(messages.threadRootId),
        gt(messages.seq, membership.lastReadSeq),
      ),
    )
    .orderBy(asc(messages.seq))
    .limit(limit + 1);

  return { messages: rows.slice(0, limit), truncated: rows.length > limit, lastReadSeq: membership.lastReadSeq };
}
