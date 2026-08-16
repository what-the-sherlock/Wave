import type { Request, Response } from "express";
import { asyncHandler } from "../errors/asyncHandler.js";
import * as messageService from "./message.service.js";
import type { Message, ReactionSummary } from "./message.service.js";
import type { MessageAttachment } from "../uploads/upload.repository.js";
import type {
  ListMessagesQuery,
  MarkReadBody,
  ReactionBody,
  SendMessageBody,
  UpdateMessageBody,
} from "./channel.schemas.js";

function attachmentToDto(attachment: MessageAttachment) {
  return {
    id: attachment.id,
    name: attachment.name,
    mimeType: attachment.mimeType,
    sizeBytes: attachment.sizeBytes,
    width: attachment.width,
    height: attachment.height,
    thumbPath: attachment.thumbPath,
  };
}

function toDto(message: Message, reactions: ReactionSummary[] = [], attachments: MessageAttachment[] = []) {
  return {
    id: message.id,
    workspaceId: message.workspaceId,
    channelId: message.channelId,
    seq: message.seq,
    senderId: message.senderId,
    body: message.body,
    clientMsgId: message.clientMsgId,
    threadRootId: message.threadRootId,
    replyCount: message.replyCount,
    lastReplyAt: message.lastReplyAt,
    editedAt: message.editedAt,
    deletedAt: message.deletedAt,
    createdAt: message.createdAt,
    reactions,
    attachments: attachments.map(attachmentToDto),
  };
}

export const send = asyncHandler(async (req: Request, res: Response) => {
  const body = req.body as SendMessageBody;
  const message = await messageService.sendMessage(req.claims!.sub, req.channel!.id, body);
  const attachments = message.id
    ? (await messageService.getAttachmentSummaries(req.claims!.sub, [message.id]))[message.id]
    : undefined;
  res.status(201).json(toDto(message, [], attachments));
});

export const list = asyncHandler(async (req: Request, res: Response) => {
  const query = req.query as unknown as ListMessagesQuery;
  const page = await messageService.listMessages(req.claims!.sub, req.channel!.id, {
    beforeSeq: query.before,
    afterSeq: query.after,
    limit: query.limit,
  });
  const messageIds = page.messages.map((m) => m.id);
  const [reactionsByMessage, attachmentsByMessage] = await Promise.all([
    messageService.getReactionSummaries(req.claims!.sub, messageIds),
    messageService.getAttachmentSummaries(req.claims!.sub, messageIds),
  ]);
  res.status(200).json({
    messages: page.messages.map((m) => toDto(m, reactionsByMessage[m.id], attachmentsByMessage[m.id])),
    hasMore: page.hasMore,
  });
});

export const listThread = asyncHandler(async (req: Request, res: Response) => {
  const replies = await messageService.listThreadReplies(req.claims!.sub, req.params.messageId!);
  res.status(200).json(replies.map((m) => toDto(m)));
});

export const update = asyncHandler(async (req: Request, res: Response) => {
  const { body } = req.body as UpdateMessageBody;
  const message = await messageService.editMessage(
    req.claims!.sub,
    req.channel!.id,
    req.params.messageId!,
    body,
  );
  res.status(200).json(toDto(message));
});

export const remove = asyncHandler(async (req: Request, res: Response) => {
  await messageService.deleteMessage(req.claims!.sub, req.channel!.id, req.params.messageId!);
  res.status(204).send();
});

export const addReaction = asyncHandler(async (req: Request, res: Response) => {
  const { emoji } = req.body as ReactionBody;
  const result = await messageService.toggleReaction(
    req.claims!.sub,
    req.channel!.id,
    req.params.messageId!,
    emoji,
  );
  res.status(200).json(result);
});

export const markRead = asyncHandler(async (req: Request, res: Response) => {
  const { seq } = req.body as MarkReadBody;
  const result = await messageService.markRead(req.claims!.sub, req.channel!.id, seq);
  res.status(200).json(result);
});
