import { and, eq, isNull, sql } from "drizzle-orm";
import type { Tx } from "../db/rlsScope.js";
import { channelMembers, channels } from "../db/schema.js";
import type { Channel, ChannelMember, NewChannel } from "../db/schema.js";

export type { Channel, NewChannel } from "../db/schema.js";
export type ChannelType = "PUBLIC" | "PRIVATE" | "DM";

export async function findById(tx: Tx, channelId: string): Promise<Channel | undefined> {
  const [row] = await tx.select().from(channels).where(eq(channels.id, channelId)).limit(1);
  return row;
}

export async function findByWorkspaceAndName(
  tx: Tx,
  workspaceId: string,
  name: string,
): Promise<Channel | undefined> {
  const [row] = await tx
    .select()
    .from(channels)
    .where(and(eq(channels.workspaceId, workspaceId), eq(channels.name, name)))
    .limit(1);
  return row;
}

export async function findDmByKey(
  tx: Tx,
  workspaceId: string,
  dmKey: string,
): Promise<Channel | undefined> {
  const [row] = await tx
    .select()
    .from(channels)
    .where(and(eq(channels.workspaceId, workspaceId), eq(channels.dmKey, dmKey)))
    .limit(1);
  return row;
}

export type ChannelWithMembershipRow = Channel & {
  role: ChannelMember["role"] | null;
  lastReadSeq: number | null;
  mutedUntil: Date | null;
};

/**
 * RLS (can_read_channel) already restricts this to channels the caller may
 * see — public channels workspace-wide, private/DM channels only if a
 * member — so no application-level filter is needed here. Left-joined
 * against the caller's own `channel_members` row so the sidebar list
 * carries real role/lastReadSeq/mutedUntil instead of reporting membership
 * as `null` for every channel — a public channel the caller can see but
 * hasn't joined correctly comes back with `role: null`; every channel they
 * belong to comes back with their actual membership, exactly what
 * `getChannelForUser` already returns for a single channel.
 */
export async function listForWorkspaceWithMembership(
  tx: Tx,
  workspaceId: string,
  userId: string,
): Promise<ChannelWithMembershipRow[]> {
  const rows = await tx
    .select({
      channel: channels,
      role: channelMembers.role,
      lastReadSeq: channelMembers.lastReadSeq,
      mutedUntil: channelMembers.mutedUntil,
    })
    .from(channels)
    .leftJoin(
      channelMembers,
      and(eq(channelMembers.channelId, channels.id), eq(channelMembers.userId, userId)),
    )
    .where(and(eq(channels.workspaceId, workspaceId), isNull(channels.archivedAt)));
  return rows.map((r) => ({ ...r.channel, role: r.role, lastReadSeq: r.lastReadSeq, mutedUntil: r.mutedUntil }));
}

export async function insert(tx: Tx, data: NewChannel): Promise<Channel> {
  const [row] = await tx.insert(channels).values(data).returning();
  if (!row) {
    throw new Error("channels insert returned no row");
  }
  return row;
}

export type ChannelPatch = Partial<Pick<Channel, "topic" | "description" | "aiExcluded">>;

export async function update(
  tx: Tx,
  channelId: string,
  patch: ChannelPatch,
): Promise<Channel | undefined> {
  const [row] = await tx.update(channels).set(patch).where(eq(channels.id, channelId)).returning();
  return row;
}

export async function archive(tx: Tx, channelId: string): Promise<Channel | undefined> {
  const [row] = await tx
    .update(channels)
    .set({ archivedAt: new Date() })
    .where(eq(channels.id, channelId))
    .returning();
  return row;
}

/** `member_count` is a denormalized, eventually-consistent display counter —
 * never allowed to read as negative (docs/database-design.md §4). */
export async function adjustMemberCount(tx: Tx, channelId: string, delta: number): Promise<void> {
  await tx
    .update(channels)
    .set({ memberCount: sql`greatest(0, ${channels.memberCount} + ${delta})` })
    .where(eq(channels.id, channelId));
}
