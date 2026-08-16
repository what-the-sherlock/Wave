import { z } from "zod";

export const createChannelSchema = z.object({
  name: z
    .string()
    .trim()
    .toLowerCase()
    // `-` last in the bracket expression, not between `9` and `_` — see the
    // Phase 3 migration's comment on the matching DB check constraint. In a
    // JS regex this doesn't throw, but `9-_` silently forms a much broader
    // range (through `:;<=>?@A-Z[\]^_`) than the intended literal hyphen.
    .regex(/^[a-z0-9_-]{1,80}$/, "Use lowercase letters, numbers, hyphens, and underscores only"),
  type: z.enum(["PUBLIC", "PRIVATE"]),
  topic: z.string().trim().max(250).optional(),
  description: z.string().trim().max(1000).optional(),
});
export type CreateChannelBody = z.infer<typeof createChannelSchema>;

export const updateChannelSchema = z
  .object({
    topic: z.string().trim().max(250).optional(),
    description: z.string().trim().max(1000).optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: "At least one field must be provided",
  });
export type UpdateChannelBody = z.infer<typeof updateChannelSchema>;

export const inviteToChannelSchema = z.object({
  userId: z.string().uuid(),
});
export type InviteToChannelBody = z.infer<typeof inviteToChannelSchema>;

export const openDmSchema = z.object({
  userId: z.string().uuid(),
});
export type OpenDmBody = z.infer<typeof openDmSchema>;

export const sendMessageSchema = z
  .object({
    // Empty only when at least one attachment is present (an image sent
    // with no caption, the common chat-app case) — enforced by the
    // .refine below rather than loosened unconditionally.
    body: z.string().trim().max(8000),
    clientMsgId: z.string().uuid(),
    threadRootId: z.string().uuid().optional(),
    mentionedUserIds: z.array(z.string().uuid()).max(50).optional(),
    mentionChannel: z.boolean().optional(),
    attachmentIds: z.array(z.string().uuid()).max(4).optional(),
  })
  .refine((data) => data.body.length > 0 || (data.attachmentIds?.length ?? 0) > 0, {
    message: "Message cannot be empty",
    path: ["body"],
  });
export type SendMessageBody = z.infer<typeof sendMessageSchema>;

export const updateMessageSchema = z.object({
  body: z.string().trim().min(1, "Message cannot be empty").max(8000),
});
export type UpdateMessageBody = z.infer<typeof updateMessageSchema>;

export const reactionSchema = z.object({
  emoji: z.string().trim().min(1).max(64),
});
export type ReactionBody = z.infer<typeof reactionSchema>;

export const listMessagesQuerySchema = z
  .object({
    before: z.coerce.number().int().positive().optional(),
    // Forward cursor for reconnect gap replay: `GET ?after={seq}` returns
    // messages newer than `seq`, ascending (docs/realtime-architecture.md
    // §7) — the counterpart to `before`'s backward scrollback pagination.
    after: z.coerce.number().int().nonnegative().optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })
  .refine((data) => data.before === undefined || data.after === undefined, {
    message: "Provide either before or after, not both",
  });
export type ListMessagesQuery = z.infer<typeof listMessagesQuerySchema>;

export const markReadSchema = z.object({
  seq: z.number().int().nonnegative(),
});
export type MarkReadBody = z.infer<typeof markReadSchema>;

/** `null` unmutes. A far-future timestamp represents "muted until I turn it
 * back on" — there is no separate boolean/enum state to keep in sync. */
export const muteChannelSchema = z.object({
  mutedUntil: z.string().datetime().nullable(),
});
export type MuteChannelBody = z.infer<typeof muteChannelSchema>;
