import { withRlsScope, type Tx } from "../db/rlsScope.js";
import { ConflictError, ForbiddenError, NotFoundError } from "../errors/AppError.js";
import { getRealtimeEmitter } from "../realtime/emitter.js";
import * as channelRepo from "./channel.repository.js";
import * as channelMemberRepo from "./channelMember.repository.js";
import * as workspaceMemberRepo from "../workspaces/member.repository.js";
import * as profileRepo from "../profiles/profile.repository.js";
import type { Channel, ChannelType } from "./channel.repository.js";
import type { DmPeer, MemberWithProfile } from "./channelMember.repository.js";
import type { WorkspaceRole } from "../workspaces/workspace.repository.js";

export type { Channel, ChannelType } from "./channel.repository.js";
export type ChannelRole = "ADMIN" | "MEMBER";
export type ChannelPeer = { userId: string; fullName: string; avatarUrl: string | null };
export type ChannelWithMembership = {
  channel: Channel;
  membership: ChannelMembershipInfo | null;
  dmPeer: ChannelPeer | null;
};
export type ChannelMembershipInfo = { role: ChannelRole; lastReadSeq: number; mutedUntil: Date | null };

function toChannelPeer(peer: Pick<DmPeer, "userId" | "fullName" | "avatarUrl">): ChannelPeer {
  return { userId: peer.userId, fullName: peer.fullName, avatarUrl: peer.avatarUrl };
}

function peerFromProfile(userId: string, profile: { fullName: string; avatarUrl: string | null }): ChannelPeer {
  return { userId, fullName: profile.fullName, avatarUrl: profile.avatarUrl };
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "23505";
}

/**
 * Channel-scoped routes (`/api/v1/channels/:channelId/...`, per
 * docs/realtime-architecture.md §5's documented path) have no `:workspaceId`
 * in the URL for `resolveWorkspace` to populate `req.workspace.role` from,
 * so the actor's workspace-level role (OWNER/ADMIN always outrank a
 * channel's own ADMIN — docs/security-model.md §4) is resolved here instead,
 * inside the same RLS-scoped transaction as the rest of the operation.
 */
async function getWorkspaceRoleInTx(
  tx: Tx,
  workspaceId: string,
  userId: string,
): Promise<WorkspaceRole | null> {
  const membership = await workspaceMemberRepo.findMembership(tx, workspaceId, userId);
  return membership && !membership.deactivatedAt ? membership.role : null;
}

function canManageChannel(
  workspaceRole: WorkspaceRole | null,
  channelRole: ChannelRole | null,
): boolean {
  return workspaceRole === "OWNER" || workspaceRole === "ADMIN" || channelRole === "ADMIN";
}

/**
 * Called from `workspace.service.ts`'s `createWorkspace`, inside the SAME
 * transaction, so the workspace + its #general channel are atomic together
 * — the `#general` placeholder the roadmap calls for, deferred from Phase 2
 * to here because the `channels` table did not exist yet
 * (docs/implementation-roadmap.md Phase 2 plan, "deliberate deviations").
 */
export async function createGeneralChannelInTx(
  tx: Tx,
  workspaceId: string,
  ownerId: string,
): Promise<void> {
  const channel = await channelRepo.insert(tx, {
    workspaceId,
    name: "general",
    type: "PUBLIC",
    createdBy: ownerId,
    memberCount: 1,
  });
  await channelMemberRepo.insertBootstrapMember(tx, {
    workspaceId,
    channelId: channel.id,
    userId: ownerId,
    role: "ADMIN",
  });
}

export type CreateChannelInput = {
  name: string;
  type: Exclude<ChannelType, "DM">;
  topic?: string;
  description?: string;
};

export async function createChannel(
  userId: string,
  workspaceId: string,
  input: CreateChannelInput,
): Promise<ChannelWithMembership> {
  try {
    const result = await withRlsScope({ userId }, async (tx) => {
      const channel = await channelRepo.insert(tx, {
        workspaceId,
        name: input.name,
        type: input.type,
        topic: input.topic,
        description: input.description,
        createdBy: userId,
        memberCount: 1,
      });
      await channelMemberRepo.insertBootstrapMember(tx, {
        workspaceId,
        channelId: channel.id,
        userId,
        role: "ADMIN",
      });
      return {
        channel,
        membership: { role: "ADMIN" as const, lastReadSeq: 0, mutedUntil: null },
        dmPeer: null,
      };
    });
    getRealtimeEmitter().joinUserToChannel(userId, result.channel.id);
    if (result.channel.type === "PUBLIC") {
      getRealtimeEmitter().toWorkspace(workspaceId, "channel.created", result.channel);
    } else {
      getRealtimeEmitter().toUser(userId, "channel.created", result.channel);
    }
    return result;
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new ConflictError(`A channel named "${input.name}" already exists`);
    }
    throw err;
  }
}

/**
 * Every visible channel, each with the caller's own membership (`null` for
 * a public channel they can see but haven't joined) and, for DMs, the other
 * participant's name/avatar — DM channels have no `name` of their own, so
 * without this every DM would render identically
 * (docs/implementation-roadmap.md Phase 3, "DMs as channels").
 */
export async function listChannels(userId: string, workspaceId: string): Promise<ChannelWithMembership[]> {
  return withRlsScope({ userId }, async (tx) => {
    const rows = await channelRepo.listForWorkspaceWithMembership(tx, workspaceId, userId);
    const dmChannelIds = rows.filter((r) => r.type === "DM").map((r) => r.id);
    const peers = await channelMemberRepo.listDmPeers(tx, dmChannelIds, userId);
    const peerByChannelId = new Map(peers.map((p) => [p.channelId, p]));

    return rows.map(({ role, lastReadSeq, mutedUntil, ...channel }) => {
      const peer = peerByChannelId.get(channel.id);
      return {
        channel,
        membership: role ? { role, lastReadSeq: lastReadSeq ?? 0, mutedUntil } : null,
        dmPeer: peer ? toChannelPeer(peer) : null,
      };
    });
  });
}

/**
 * RLS's `can_read_channel` already scopes visibility (public channels
 * workspace-wide, private/DM only for members), so `undefined` here is the
 * only signal needed for a 404 — indistinguishable from "doesn't exist"
 * (docs/security-model.md §4).
 */
export async function getChannelForUser(
  userId: string,
  channelId: string,
): Promise<ChannelWithMembership | undefined> {
  return withRlsScope({ userId }, async (tx) => {
    const channel = await channelRepo.findById(tx, channelId);
    if (!channel) return undefined;
    const membership = await channelMemberRepo.findMembership(tx, channelId, userId);
    const dmPeer =
      channel.type === "DM"
        ? (await channelMemberRepo.listDmPeers(tx, [channelId], userId))[0]
        : undefined;
    return {
      channel,
      membership: membership
        ? { role: membership.role, lastReadSeq: membership.lastReadSeq, mutedUntil: membership.mutedUntil }
        : null,
      dmPeer: dmPeer ? toChannelPeer(dmPeer) : null,
    };
  });
}

export async function joinPublicChannel(userId: string, channelId: string): Promise<void> {
  await withRlsScope({ userId }, async (tx) => {
    const channel = await channelRepo.findById(tx, channelId);
    if (!channel) {
      throw new NotFoundError("Channel not found");
    }
    if (channel.type !== "PUBLIC") {
      throw new ForbiddenError("Only public channels can be joined directly");
    }
    const existing = await channelMemberRepo.findMembership(tx, channelId, userId);
    if (existing) return;
    await channelMemberRepo.insert(tx, {
      workspaceId: channel.workspaceId,
      channelId,
      userId,
      role: "MEMBER",
    });
    await channelRepo.adjustMemberCount(tx, channelId, 1);
  });
  getRealtimeEmitter().joinUserToChannel(userId, channelId);
}

export async function inviteToPrivateChannel(
  actorUserId: string,
  channelId: string,
  targetUserId: string,
): Promise<void> {
  await withRlsScope({ userId: actorUserId }, async (tx) => {
    const channel = await channelRepo.findById(tx, channelId);
    if (!channel) {
      throw new NotFoundError("Channel not found");
    }
    const actorWorkspaceRole = await getWorkspaceRoleInTx(tx, channel.workspaceId, actorUserId);
    const actorMembership = await channelMemberRepo.findMembership(tx, channelId, actorUserId);
    if (!canManageChannel(actorWorkspaceRole, actorMembership?.role ?? null)) {
      throw new ForbiddenError("Only a channel or workspace admin may invite members");
    }
    const existing = await channelMemberRepo.findMembership(tx, channelId, targetUserId);
    if (existing) return;
    await channelMemberRepo.insert(tx, {
      workspaceId: channel.workspaceId,
      channelId,
      userId: targetUserId,
      role: "MEMBER",
    });
    await channelRepo.adjustMemberCount(tx, channelId, 1);
  });
  getRealtimeEmitter().joinUserToChannel(targetUserId, channelId);
  getRealtimeEmitter().toChannel(channelId, "channel.member.added", { channelId, userId: targetUserId });
}

async function removeMemberInternal(
  actorUserId: string,
  channelId: string,
  targetUserId: string,
  guard: (workspaceRole: WorkspaceRole | null, actorMembership: MemberWithProfile | undefined) => void,
): Promise<void> {
  await withRlsScope({ userId: actorUserId }, async (tx) => {
    const channel = await channelRepo.findById(tx, channelId);
    if (!channel) {
      throw new NotFoundError("Channel not found");
    }
    const workspaceRole = await getWorkspaceRoleInTx(tx, channel.workspaceId, actorUserId);
    const actorMembership = await channelMemberRepo.findMembership(tx, channelId, actorUserId);
    guard(workspaceRole, actorMembership as MemberWithProfile | undefined);
    const removed = await channelMemberRepo.remove(tx, channelId, targetUserId);
    if (!removed) {
      throw new NotFoundError("Member not found");
    }
    await channelRepo.adjustMemberCount(tx, channelId, -1);
  });
  getRealtimeEmitter().evictUserFromChannel(targetUserId, channelId);
  getRealtimeEmitter().toChannel(channelId, "channel.member.removed", { channelId, userId: targetUserId });
}

export async function removeChannelMember(
  actorUserId: string,
  channelId: string,
  targetUserId: string,
): Promise<void> {
  return removeMemberInternal(actorUserId, channelId, targetUserId, (workspaceRole, actorMembership) => {
    if (!canManageChannel(workspaceRole, actorMembership?.role ?? null)) {
      throw new ForbiddenError("Only a channel or workspace admin may remove members");
    }
  });
}

export async function leaveChannel(userId: string, channelId: string): Promise<void> {
  return removeMemberInternal(userId, channelId, userId, () => undefined);
}

export async function archiveChannel(actorUserId: string, channelId: string): Promise<void> {
  const workspaceId = await withRlsScope({ userId: actorUserId }, async (tx) => {
    const channel = await channelRepo.findById(tx, channelId);
    if (!channel) {
      throw new NotFoundError("Channel not found");
    }
    const workspaceRole = await getWorkspaceRoleInTx(tx, channel.workspaceId, actorUserId);
    const actorMembership = await channelMemberRepo.findMembership(tx, channelId, actorUserId);
    if (!canManageChannel(workspaceRole, actorMembership?.role ?? null)) {
      throw new ForbiddenError("Only a channel or workspace admin may archive this channel");
    }
    const archived = await channelRepo.archive(tx, channelId);
    if (!archived) {
      throw new NotFoundError("Channel not found");
    }
    return archived.workspaceId;
  });
  getRealtimeEmitter().toWorkspace(workspaceId, "channel.archived", { channelId });
}

export type ChannelSettingsPatch = { topic?: string; description?: string };

export async function updateChannelSettings(
  actorUserId: string,
  channelId: string,
  patch: ChannelSettingsPatch,
): Promise<Channel> {
  return withRlsScope({ userId: actorUserId }, async (tx) => {
    const channel = await channelRepo.findById(tx, channelId);
    if (!channel) {
      throw new NotFoundError("Channel not found");
    }
    const workspaceRole = await getWorkspaceRoleInTx(tx, channel.workspaceId, actorUserId);
    const actorMembership = await channelMemberRepo.findMembership(tx, channelId, actorUserId);
    if (!canManageChannel(workspaceRole, actorMembership?.role ?? null)) {
      throw new ForbiddenError("Only a channel or workspace admin may update this channel");
    }
    const updated = await channelRepo.update(tx, channelId, patch);
    if (!updated) {
      throw new NotFoundError("Channel not found");
    }
    return updated;
  });
}

function dmKeyFor(userA: string, userB: string): string {
  return [userA, userB].sort().join(":");
}

/**
 * Create-or-get: guarded by the `channels_dm_key_uidx` unique partial index
 * rather than a check-then-insert, so a race between two clients opening
 * the same DM for the first time can never produce two channels for the
 * same pair (docs/database-design.md §4).
 */
export async function getOrCreateDm(
  userId: string,
  workspaceId: string,
  otherUserId: string,
): Promise<ChannelWithMembership> {
  if (userId === otherUserId) {
    throw new ConflictError("Cannot open a DM with yourself");
  }
  const dmKey = dmKeyFor(userId, otherUserId);
  const membership = { role: "MEMBER" as const, lastReadSeq: 0, mutedUntil: null };

  try {
    return await withRlsScope({ userId }, async (tx) => {
      const channel = await channelRepo.insert(tx, {
        workspaceId,
        type: "DM",
        dmKey,
        memberCount: 2,
      });
      await channelMemberRepo.insertBootstrapMember(tx, {
        workspaceId,
        channelId: channel.id,
        userId,
        role: "MEMBER",
      });
      await channelMemberRepo.insertBootstrapMember(tx, {
        workspaceId,
        channelId: channel.id,
        userId: otherUserId,
        role: "MEMBER",
      });
      const peerProfile = await profileRepo.findById(tx, otherUserId);
      return {
        channel,
        membership,
        dmPeer: peerProfile ? peerFromProfile(otherUserId, peerProfile) : null,
      };
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      const existing = await withRlsScope({ userId }, async (tx) => {
        const channel = await channelRepo.findDmByKey(tx, workspaceId, dmKey);
        if (!channel) return undefined;
        const peerProfile = await profileRepo.findById(tx, otherUserId);
        return { channel, peerProfile };
      });
      if (existing) {
        return {
          channel: existing.channel,
          membership,
          dmPeer: existing.peerProfile ? peerFromProfile(otherUserId, existing.peerProfile) : null,
        };
      }
    }
    throw err;
  }
}

export async function listMembers(userId: string, channelId: string): Promise<MemberWithProfile[]> {
  return withRlsScope({ userId }, (tx) => channelMemberRepo.listByChannel(tx, channelId));
}

export async function updateMyMembership(
  userId: string,
  channelId: string,
  patch: { mutedUntil: string | null },
): Promise<ChannelMembershipInfo> {
  const updated = await withRlsScope({ userId }, (tx) =>
    channelMemberRepo.setMutedUntil(tx, channelId, userId, patch.mutedUntil ? new Date(patch.mutedUntil) : null),
  );
  if (!updated) {
    throw new NotFoundError("Channel not found");
  }
  return { role: updated.role, lastReadSeq: updated.lastReadSeq, mutedUntil: updated.mutedUntil };
}

export type ChannelHeadSeq = { channelId: string; lastReadSeq: number; lastMessageSeq: number };

/** Powers the socket `workspace.join` handler: which `ch:{id}` rooms to
 * auto-join, and the head sequences the client needs for gap detection on
 * reconnect (docs/realtime-architecture.md §3, §4). */
export async function listMyChannelsInWorkspace(
  userId: string,
  workspaceId: string,
): Promise<ChannelHeadSeq[]> {
  return withRlsScope({ userId }, (tx) =>
    channelMemberRepo.listChannelIdsForUserInWorkspace(tx, workspaceId, userId),
  );
}
