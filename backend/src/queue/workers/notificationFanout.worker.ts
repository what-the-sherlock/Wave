import { withServiceRoleScope } from "../../db/rlsScope.js";
import { config } from "../../config/env.js";
import { getRealtimeEmitter } from "../../realtime/emitter.js";
import { getQueue } from "../index.js";
import * as messageRepo from "../../channels/message.repository.js";
import * as channelRepo from "../../channels/channel.repository.js";
import * as channelMemberRepo from "../../channels/channelMember.repository.js";
import * as mentionRepo from "../../channels/mention.repository.js";
import * as notificationRepo from "../../notifications/notification.repository.js";
import type { NewNotification } from "../../notifications/notification.repository.js";

type Candidate = { userId: string; type: NewNotification["type"] };

/**
 * Resolves fan-out recipients for one message: mentions (USER and expanded
 * CHANNEL), the other DM participant (only when there's no mention at all),
 * and thread participants (anyone who has replied in the thread — there is
 * no explicit subscription table, so authorship is the only signal
 * available). Precedence when a user qualifies more than one way: MENTION >
 * THREAD_REPLY > DM, first-write-wins via the Map. Exported standalone (pure
 * given its inputs) so it's unit-testable without a live database.
 */
export function resolveCandidates(params: {
  senderId: string;
  channelType: string;
  mentions: { kind: string; mentionedUserId: string | null }[];
  channelMemberIds: string[];
  threadParticipantIds: string[];
}): Candidate[] {
  const candidates = new Map<string, Candidate>();
  const setIfAbsent = (userId: string, type: Candidate["type"]) => {
    if (userId === params.senderId) return;
    if (!candidates.has(userId)) candidates.set(userId, { userId, type });
  };

  for (const mention of params.mentions) {
    if (mention.kind === "USER" && mention.mentionedUserId) {
      setIfAbsent(mention.mentionedUserId, "MENTION");
    }
  }
  const hasChannelMention = params.mentions.some((m) => m.kind === "CHANNEL");
  if (hasChannelMention) {
    for (const userId of params.channelMemberIds) setIfAbsent(userId, "MENTION");
  }

  if (params.channelType === "DM" && candidates.size === 0) {
    for (const userId of params.channelMemberIds) setIfAbsent(userId, "DM");
  }

  for (const userId of params.threadParticipantIds) setIfAbsent(userId, "THREAD_REPLY");

  return [...candidates.values()];
}

/** Given eligible candidates and the set of users who have this channel
 * muted, returns who should actually be notified. Standalone and pure for
 * the same reason as resolveCandidates. */
export function filterEligibleRecipients(candidates: Candidate[], mutedUserIds: Set<string>): Candidate[] {
  return candidates.filter((c) => !mutedUserIds.has(c.userId));
}

export async function notificationFanoutHandler(data: { messageId: string }): Promise<void> {
  await withServiceRoleScope(async (tx) => {
    const message = await messageRepo.findById(tx, data.messageId);
    if (!message || message.deletedAt) return;

    const channel = await channelRepo.findById(tx, message.channelId);
    if (!channel) return;

    const mentions = await mentionRepo.listByMessage(tx, message.id);
    const members = await channelMemberRepo.listByChannel(tx, channel.id);
    const threadParticipantIds = message.threadRootId
      ? await messageRepo.listThreadParticipantIds(tx, message.threadRootId)
      : [];

    const candidates = resolveCandidates({
      senderId: message.senderId,
      channelType: channel.type,
      mentions,
      channelMemberIds: members.map((m) => m.userId),
      threadParticipantIds,
    });
    if (candidates.length === 0) return;

    const mutedUserIds = new Set(
      await channelMemberRepo.listMutedUserIds(
        tx,
        channel.id,
        candidates.map((c) => c.userId),
        new Date(),
      ),
    );
    const eligible = filterEligibleRecipients(candidates, mutedUserIds);
    if (eligible.length === 0) return;

    const rows: NewNotification[] = eligible.map((c) => ({
      workspaceId: message.workspaceId,
      userId: c.userId,
      type: c.type,
      actorId: message.senderId,
      channelId: channel.id,
      messageId: message.id,
      preview: message.body ? message.body.slice(0, 200) : null,
    }));

    const inserted = await notificationRepo.insertManyIfAbsent(tx, rows);

    for (const row of inserted) {
      const unreadTotal = await notificationRepo.unreadCount(tx, row.userId);
      getRealtimeEmitter().toUser(row.userId, "notification.created", {
        id: row.id,
        workspaceId: row.workspaceId,
        type: row.type,
        actorId: row.actorId,
        channelId: row.channelId,
        messageId: row.messageId,
        preview: row.preview,
        readAt: row.readAt,
        createdAt: row.createdAt,
        unreadTotal,
      });

      if (config.FEATURE_EMAIL) {
        // The 5-minute delay is the entire "offline for 5 minutes"
        // mechanism (docs/implementation-roadmap.md Phase 5) — no
        // last-seen-at bookkeeping needed; email.send re-checks read state
        // and presence itself when the delay elapses.
        await getQueue().sendTx(tx, "email.send", { notificationId: row.id }, { startAfterSeconds: 300 });
      }
    }
  });
}
