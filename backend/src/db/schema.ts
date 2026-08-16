import {
  pgTable,
  pgEnum,
  timestamp,
  text,
  uuid,
  integer,
  bigint,
  boolean,
  jsonb,
} from "drizzle-orm/pg-core";

/**
 * Mirrors supabase/migrations/20260815010000_profiles.sql,
 * 20260815020000_workspaces.sql, and 20260815030000_channels_messages.sql.
 * Drizzle's schema is the typed *view* of the tables; the SQL migrations
 * are the source of truth for structure, policies, and grants
 * (docs/target-architecture.md §7).
 */
export const profiles = pgTable("profiles", {
  id: uuid("id").primaryKey(),
  fullName: text("full_name").notNull(),
  avatarUrl: text("avatar_url"),
  timezone: text("timezone").notNull().default("UTC"),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type Profile = typeof profiles.$inferSelect;
export type NewProfile = typeof profiles.$inferInsert;

export const workspaceRoleEnum = pgEnum("workspace_role", ["OWNER", "ADMIN", "MEMBER"]);

export type WorkspaceSettings = {
  allowPublicInvites: boolean;
  aiEnabled: boolean;
};

export const workspaces = pgTable("workspaces", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  slug: text("slug").notNull(),
  iconUrl: text("icon_url"),
  ownerId: uuid("owner_id").notNull(),
  settings: jsonb("settings").notNull().$type<WorkspaceSettings>(),
  memberCount: integer("member_count").notNull().default(0),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type Workspace = typeof workspaces.$inferSelect;
export type NewWorkspace = typeof workspaces.$inferInsert;

export const workspaceMembers = pgTable("workspace_members", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull(),
  userId: uuid("user_id").notNull(),
  role: workspaceRoleEnum("role").notNull().default("MEMBER"),
  displayName: text("display_name"),
  invitedBy: uuid("invited_by"),
  joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
  deactivatedAt: timestamp("deactivated_at", { withTimezone: true }),
});

export type WorkspaceMember = typeof workspaceMembers.$inferSelect;
export type NewWorkspaceMember = typeof workspaceMembers.$inferInsert;

export const invites = pgTable("invites", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull(),
  email: text("email"),
  tokenHash: text("token_hash").notNull(),
  role: workspaceRoleEnum("role").notNull().default("MEMBER"),
  channelIds: uuid("channel_ids").array().notNull().default([]),
  invitedBy: uuid("invited_by").notNull(),
  maxUses: integer("max_uses").notNull().default(1),
  useCount: integer("use_count").notNull().default(0),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type Invite = typeof invites.$inferSelect;
export type NewInvite = typeof invites.$inferInsert;

export const channelTypeEnum = pgEnum("channel_type", ["PUBLIC", "PRIVATE", "DM"]);
export const channelRoleEnum = pgEnum("channel_role", ["ADMIN", "MEMBER"]);
export const mentionKindEnum = pgEnum("mention_kind", ["USER", "CHANNEL"]);

export const channels = pgTable("channels", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull(),
  name: text("name"),
  type: channelTypeEnum("type").notNull(),
  topic: text("topic"),
  description: text("description"),
  createdBy: uuid("created_by"),
  lastMessageSeq: bigint("last_message_seq", { mode: "number" }).notNull().default(0),
  lastMessageAt: timestamp("last_message_at", { withTimezone: true }),
  memberCount: integer("member_count").notNull().default(0),
  dmKey: text("dm_key"),
  aiExcluded: boolean("ai_excluded").notNull().default(false),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type Channel = typeof channels.$inferSelect;
export type NewChannel = typeof channels.$inferInsert;

export const channelMembers = pgTable("channel_members", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull(),
  channelId: uuid("channel_id").notNull(),
  userId: uuid("user_id").notNull(),
  role: channelRoleEnum("role").notNull().default("MEMBER"),
  lastReadSeq: bigint("last_read_seq", { mode: "number" }).notNull().default(0),
  lastReadAt: timestamp("last_read_at", { withTimezone: true }),
  mutedUntil: timestamp("muted_until", { withTimezone: true }),
  joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
});

export type ChannelMember = typeof channelMembers.$inferSelect;
export type NewChannelMember = typeof channelMembers.$inferInsert;

export const messages = pgTable("messages", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull(),
  channelId: uuid("channel_id").notNull(),
  seq: bigint("seq", { mode: "number" }).notNull(),
  senderId: uuid("sender_id").notNull(),
  body: text("body"),
  clientMsgId: uuid("client_msg_id").notNull(),
  threadRootId: uuid("thread_root_id"),
  replyCount: integer("reply_count").notNull().default(0),
  lastReplyAt: timestamp("last_reply_at", { withTimezone: true }),
  editedAt: timestamp("edited_at", { withTimezone: true }),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  deletedBy: uuid("deleted_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  // `search_vector` (generated tsvector column) is deliberately omitted here
  // — nothing in the app selects or writes through it until Phase 6's full-
  // text search lands, and Drizzle has no native tsvector column builder.
  // The SQL migration is the source of truth for it regardless.
});

export type Message = typeof messages.$inferSelect;
export type NewMessage = typeof messages.$inferInsert;

export const messageReactions = pgTable("message_reactions", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull(),
  channelId: uuid("channel_id").notNull(),
  messageId: uuid("message_id").notNull(),
  userId: uuid("user_id").notNull(),
  emoji: text("emoji").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type MessageReaction = typeof messageReactions.$inferSelect;
export type NewMessageReaction = typeof messageReactions.$inferInsert;

export const messageMentions = pgTable("message_mentions", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull(),
  channelId: uuid("channel_id").notNull(),
  messageId: uuid("message_id").notNull(),
  mentionedUserId: uuid("mentioned_user_id"),
  kind: mentionKindEnum("kind").notNull(),
});

export type MessageMention = typeof messageMentions.$inferSelect;
export type NewMessageMention = typeof messageMentions.$inferInsert;

/**
 * Mirrors supabase/migrations/20260816010000_notifications.sql (Phase 5).
 */
export const notificationTypeEnum = pgEnum("notification_type", [
  "MENTION",
  "DM",
  "THREAD_REPLY",
  "CHANNEL_INVITE",
  "WORKSPACE_INVITE",
  "SYSTEM",
]);

export const notifications = pgTable("notifications", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull(),
  userId: uuid("user_id").notNull(),
  type: notificationTypeEnum("type").notNull(),
  actorId: uuid("actor_id"),
  channelId: uuid("channel_id"),
  messageId: uuid("message_id"),
  preview: text("preview"),
  readAt: timestamp("read_at", { withTimezone: true }),
  emailedAt: timestamp("emailed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type Notification = typeof notifications.$inferSelect;
export type NewNotification = typeof notifications.$inferInsert;

/**
 * Mirrors supabase/migrations/20260816020000_attachments.sql (Phase 6).
 */
export const messageAttachments = pgTable("message_attachments", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull(),
  channelId: uuid("channel_id").notNull(),
  messageId: uuid("message_id"),
  uploadedBy: uuid("uploaded_by").notNull(),
  storagePath: text("storage_path").notNull(),
  name: text("name").notNull(),
  mimeType: text("mime_type").notNull(),
  sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
  width: integer("width"),
  height: integer("height"),
  thumbPath: text("thumb_path"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type MessageAttachment = typeof messageAttachments.$inferSelect;
export type NewMessageAttachment = typeof messageAttachments.$inferInsert;
