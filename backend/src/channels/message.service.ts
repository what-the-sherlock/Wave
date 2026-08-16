import { withRlsScope, type Tx } from "../db/rlsScope.js";
import { ForbiddenError, NotFoundError } from "../errors/AppError.js";
import { getRealtimeEmitter } from "../realtime/emitter.js";
import { getQueue } from "../queue/index.js";
import * as messageRepo from "./message.repository.js";
import * as reactionRepo from "./reaction.repository.js";
import * as mentionRepo from "./mention.repository.js";
import * as channelMemberRepo from "./channelMember.repository.js";
import * as channelRepo from "./channel.repository.js";
import * as workspaceMemberRepo from "../workspaces/member.repository.js";
import * as uploadRepo from "../uploads/upload.repository.js";
import { attachToMessageInTx } from "../uploads/upload.service.js";
import type { MessageAttachment } from "../uploads/upload.repository.js";
import type { Message, MessagePage } from "./message.repository.js";
import type { WorkspaceRole } from "../workspaces/workspace.repository.js";

export type { Message, MessagePage } from "./message.repository.js";

/** See channel.service.ts's `getWorkspaceRoleInTx` — same reasoning:
 * channel-scoped routes have no `:workspaceId` in the URL to resolve a role
 * from, so an author-or-workspace-admin check derives it here instead. */
async function getWorkspaceRoleInTx(
  tx: Tx,
  workspaceId: string,
  userId: string,
): Promise<WorkspaceRole | null> {
  const membership = await workspaceMemberRepo.findMembership(tx, workspaceId, userId);
  return membership && !membership.deactivatedAt ? membership.role : null;
}

export type SendMessageInput = {
  body: string;
  clientMsgId: string;
  threadRootId?: string;
  mentionedUserIds?: string[];
  mentionChannel?: boolean;
  attachmentIds?: string[];
};

export async function sendMessage(
  userId: string,
  channelId: string,
  input: SendMessageInput,
): Promise<Message> {
  const message = await withRlsScope({ userId }, async (tx) => {
    const row = await messageRepo.sendMessage(
      tx,
      channelId,
      input.body,
      input.clientMsgId,
      input.threadRootId ?? null,
    );

    const mentionRows = [
      ...(input.mentionedUserIds ?? []).map((mentionedUserId) => ({
        workspaceId: row.workspaceId,
        channelId,
        messageId: row.id,
        mentionedUserId,
        kind: "USER" as const,
      })),
      ...(input.mentionChannel
        ? [
            {
              workspaceId: row.workspaceId,
              channelId,
              messageId: row.id,
              mentionedUserId: null,
              kind: "CHANNEL" as const,
            },
          ]
        : []),
    ];
    await mentionRepo.insertMany(tx, mentionRows);

    if (input.attachmentIds?.length) {
      await attachToMessageInTx(tx, input.attachmentIds, row.id, userId, channelId);
    }

    // Enqueued on the SAME transaction as the insert (docs/realtime-
    // architecture.md §5) — the job only becomes visible to the
    // notification.fanout worker if this transaction commits, and never if
    // it rolls back. See queue/pgBossQueue.ts's sendTx.
    await getQueue().sendTx(tx, "notification.fanout", { messageId: row.id });

    return row;
  });

  const event = message.threadRootId ? "thread.reply.created" : "message.created";
  getRealtimeEmitter().toChannel(channelId, event, { ...message, clientMsgId: input.clientMsgId });
  return message;
}

export async function listMessages(
  userId: string,
  channelId: string,
  opts: { beforeSeq?: number; afterSeq?: number; limit?: number },
): Promise<MessagePage> {
  return withRlsScope({ userId }, (tx) => messageRepo.listByChannel(tx, channelId, opts));
}

export async function listThreadReplies(userId: string, threadRootId: string): Promise<Message[]> {
  return withRlsScope({ userId }, (tx) => messageRepo.listThreadReplies(tx, threadRootId));
}

export type ReactionSummary = { emoji: string; count: number; me: boolean };

/** Grouped by message id, for attaching to a page of message DTOs — see
 * `message.controller.ts`'s `list`. */
export async function getReactionSummaries(
  userId: string,
  messageIds: string[],
): Promise<Record<string, ReactionSummary[]>> {
  const rows = await withRlsScope({ userId }, (tx) =>
    reactionRepo.countsByMessageIds(tx, messageIds, userId),
  );
  const summaries: Record<string, ReactionSummary[]> = {};
  for (const row of rows) {
    (summaries[row.messageId] ??= []).push({ emoji: row.emoji, count: row.count, me: row.me });
  }
  return summaries;
}

/** Grouped by message id, for attaching to a page of message DTOs — see
 * message.controller.ts's `list`, mirrors getReactionSummaries above. */
export async function getAttachmentSummaries(
  userId: string,
  messageIds: string[],
): Promise<Record<string, MessageAttachment[]>> {
  const rows = await withRlsScope({ userId }, (tx) => uploadRepo.listByMessageIds(tx, messageIds));
  const summaries: Record<string, MessageAttachment[]> = {};
  for (const row of rows) {
    if (!row.messageId) continue;
    (summaries[row.messageId] ??= []).push(row);
  }
  return summaries;
}

export async function editMessage(
  userId: string,
  channelId: string,
  messageId: string,
  body: string,
): Promise<Message> {
  const updated = await withRlsScope({ userId }, async (tx) => {
    const existing = await messageRepo.findById(tx, messageId);
    if (!existing || existing.channelId !== channelId || existing.deletedAt) {
      throw new NotFoundError("Message not found");
    }
    if (existing.senderId !== userId) {
      const workspaceRole = await getWorkspaceRoleInTx(tx, existing.workspaceId, userId);
      if (workspaceRole !== "OWNER" && workspaceRole !== "ADMIN") {
        throw new ForbiddenError("Only the author or a workspace admin may edit this message");
      }
    }
    const row = await messageRepo.update(tx, messageId, body);
    if (!row) {
      throw new NotFoundError("Message not found");
    }
    return row;
  });

  getRealtimeEmitter().toChannel(channelId, "message.updated", {
    id: updated.id,
    channelId,
    body: updated.body,
    editedAt: updated.editedAt,
    seq: updated.seq,
  });
  return updated;
}

export async function deleteMessage(
  userId: string,
  channelId: string,
  messageId: string,
): Promise<void> {
  await withRlsScope({ userId }, async (tx) => {
    const existing = await messageRepo.findById(tx, messageId);
    if (!existing || existing.channelId !== channelId || existing.deletedAt) {
      throw new NotFoundError("Message not found");
    }
    if (existing.senderId !== userId) {
      const workspaceRole = await getWorkspaceRoleInTx(tx, existing.workspaceId, userId);
      if (workspaceRole !== "OWNER" && workspaceRole !== "ADMIN") {
        throw new ForbiddenError("Only the author or a workspace admin may delete this message");
      }
    }
    await messageRepo.softDelete(tx, messageId, userId);
  });
  getRealtimeEmitter().toChannel(channelId, "message.deleted", { id: messageId, channelId });
}

export type ReactionResult = { emoji: string; count: number; added: boolean };

/** Toggling is naturally idempotent per the `unique(message_id, user_id,
 * emoji)` constraint — this is the application-level toggle on top of it. */
export async function toggleReaction(
  userId: string,
  channelId: string,
  messageId: string,
  emoji: string,
): Promise<ReactionResult> {
  const result = await withRlsScope({ userId }, async (tx) => {
    const message = await messageRepo.findById(tx, messageId);
    if (!message || message.channelId !== channelId || message.deletedAt) {
      throw new NotFoundError("Message not found");
    }

    const existing = await reactionRepo.find(tx, messageId, userId, emoji);
    if (existing) {
      await reactionRepo.remove(tx, messageId, userId, emoji);
    } else {
      await reactionRepo.add(tx, {
        workspaceId: message.workspaceId,
        channelId,
        messageId,
        userId,
        emoji,
      });
    }
    const all = await reactionRepo.listByMessage(tx, messageId);
    const count = all.filter((r) => r.emoji === emoji).length;
    return { emoji, count, added: !existing };
  });

  getRealtimeEmitter().toChannel(
    channelId,
    result.added ? "message.reaction.added" : "message.reaction.removed",
    { messageId, emoji, userId, count: result.count },
  );
  return result;
}

export type MarkReadResult = { lastReadSeq: number; unread: number };

export async function markRead(
  userId: string,
  channelId: string,
  seq: number,
): Promise<MarkReadResult> {
  const result = await withRlsScope({ userId }, async (tx) => {
    const updated = await channelMemberRepo.markRead(tx, channelId, userId, seq);
    if (!updated) {
      throw new NotFoundError("Channel not found");
    }
    const channel = await channelRepo.findById(tx, channelId);
    const unread = channel ? Math.max(0, channel.lastMessageSeq - updated.lastReadSeq) : 0;
    return { lastReadSeq: updated.lastReadSeq, unread };
  });

  // Delivered to every device of this user, not just the caller — the
  // cross-device read-state sync the roadmap calls for
  // (docs/realtime-architecture.md §4's `channel.read.updated`).
  getRealtimeEmitter().toUser(userId, "channel.read.updated", {
    channelId,
    lastReadSeq: result.lastReadSeq,
    unread: result.unread,
  });
  return result;
}
