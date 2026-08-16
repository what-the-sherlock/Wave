import { and, eq, gt, inArray, ne, sql } from "drizzle-orm";
import type { Tx } from "../db/rlsScope.js";
import { channelMembers, channels, profiles } from "../db/schema.js";
import type { ChannelMember, NewChannelMember } from "../db/schema.js";

export type { ChannelMember, NewChannelMember } from "../db/schema.js";

export async function findMembership(
  tx: Tx,
  channelId: string,
  userId: string,
): Promise<ChannelMember | undefined> {
  const [row] = await tx
    .select()
    .from(channelMembers)
    .where(and(eq(channelMembers.channelId, channelId), eq(channelMembers.userId, userId)))
    .limit(1);
  return row;
}

export type MemberWithProfile = ChannelMember & {
  fullName: string;
  avatarUrl: string | null;
};

export async function listByChannel(tx: Tx, channelId: string): Promise<MemberWithProfile[]> {
  return tx
    .select({
      id: channelMembers.id,
      workspaceId: channelMembers.workspaceId,
      channelId: channelMembers.channelId,
      userId: channelMembers.userId,
      role: channelMembers.role,
      lastReadSeq: channelMembers.lastReadSeq,
      lastReadAt: channelMembers.lastReadAt,
      mutedUntil: channelMembers.mutedUntil,
      joinedAt: channelMembers.joinedAt,
      fullName: profiles.fullName,
      avatarUrl: profiles.avatarUrl,
    })
    .from(channelMembers)
    .innerJoin(profiles, eq(channelMembers.userId, profiles.id))
    .where(eq(channelMembers.channelId, channelId));
}

/** Every channel this user belongs to, workspace-wide, with each channel's
 * current head sequence — used to auto-join `ch:{id}` socket rooms and
 * return gap-detection cursors in the `workspace.join` ack
 * (docs/realtime-architecture.md §3, §4). */
export async function listChannelIdsForUserInWorkspace(
  tx: Tx,
  workspaceId: string,
  userId: string,
): Promise<{ channelId: string; lastReadSeq: number; lastMessageSeq: number }[]> {
  return tx
    .select({
      channelId: channelMembers.channelId,
      lastReadSeq: channelMembers.lastReadSeq,
      lastMessageSeq: channels.lastMessageSeq,
    })
    .from(channelMembers)
    .innerJoin(channels, eq(channelMembers.channelId, channels.id))
    .where(and(eq(channelMembers.workspaceId, workspaceId), eq(channelMembers.userId, userId)));
}

export type DmPeer = { channelId: string; userId: string; fullName: string; avatarUrl: string | null };

/**
 * For each given DM channel id, the single other member — DMs are always
 * exactly two people (group DMs are cut per docs/implementation-roadmap.md
 * "Scope discipline": "a private channel already is a group DM"), so this
 * is one row per channel id, not a fan-out. Used to render a DM's real
 * counterpart name/avatar instead of a generic label, since DM channels
 * have no `name` of their own.
 */
export async function listDmPeers(tx: Tx, channelIds: string[], userId: string): Promise<DmPeer[]> {
  if (channelIds.length === 0) return [];
  return tx
    .select({
      channelId: channelMembers.channelId,
      userId: channelMembers.userId,
      fullName: profiles.fullName,
      avatarUrl: profiles.avatarUrl,
    })
    .from(channelMembers)
    .innerJoin(profiles, eq(channelMembers.userId, profiles.id))
    .where(and(inArray(channelMembers.channelId, channelIds), ne(channelMembers.userId, userId)));
}

/** Which of the given users currently have this channel muted — used by
 * the notification.fanout worker to filter recipients before insert
 * (docs/realtime-architecture.md §5). */
export async function listMutedUserIds(
  tx: Tx,
  channelId: string,
  userIds: string[],
  now: Date,
): Promise<string[]> {
  if (userIds.length === 0) return [];
  const rows = await tx
    .select({ userId: channelMembers.userId })
    .from(channelMembers)
    .where(
      and(
        eq(channelMembers.channelId, channelId),
        inArray(channelMembers.userId, userIds),
        gt(channelMembers.mutedUntil, now),
      ),
    );
  return rows.map((r) => r.userId);
}

export async function setMutedUntil(
  tx: Tx,
  channelId: string,
  userId: string,
  mutedUntil: Date | null,
): Promise<ChannelMember | undefined> {
  const [row] = await tx
    .update(channelMembers)
    .set({ mutedUntil })
    .where(and(eq(channelMembers.channelId, channelId), eq(channelMembers.userId, userId)))
    .returning();
  return row;
}

export async function insert(tx: Tx, data: NewChannelMember): Promise<ChannelMember> {
  const [row] = await tx.insert(channelMembers).values(data).returning();
  if (!row) {
    throw new Error("channel_members insert returned no row");
  }
  return row;
}

/**
 * The channel-creator's bootstrap membership deliberately skips
 * `.returning()` for the same reason `member.repository.ts`'s
 * `insertOwnerBootstrap` does: Postgres re-checks the SELECT policy for a
 * RETURNING row, and that check's `is_channel_member()` call — itself a
 * query against this same table — does not see the row this very statement
 * just inserted (docs/implementation-roadmap.md Phase 2 plan, "the RETURNING
 * re-check" — the same class of bug, one table over). Nothing needs the row
 * back here.
 */
export async function insertBootstrapMember(
  tx: Tx,
  data: Omit<NewChannelMember, "id" | "joinedAt">,
): Promise<void> {
  await tx.insert(channelMembers).values(data);
}

export async function remove(tx: Tx, channelId: string, userId: string): Promise<boolean> {
  const rows = await tx
    .delete(channelMembers)
    .where(and(eq(channelMembers.channelId, channelId), eq(channelMembers.userId, userId)))
    .returning({ id: channelMembers.id });
  return rows.length > 0;
}

/** Idempotent and safe out of order from multiple devices — `greatest()`
 * means a late-arriving update from a slow device can never move the
 * watermark backwards (docs/database-design.md §8). */
export async function markRead(
  tx: Tx,
  channelId: string,
  userId: string,
  seq: number,
): Promise<ChannelMember | undefined> {
  const [row] = await tx
    .update(channelMembers)
    .set({ lastReadSeq: sql`greatest(${channelMembers.lastReadSeq}, ${seq})`, lastReadAt: new Date() })
    .where(and(eq(channelMembers.channelId, channelId), eq(channelMembers.userId, userId)))
    .returning();
  return row;
}
