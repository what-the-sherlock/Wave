export type ChannelType = "PUBLIC" | "PRIVATE" | "DM";
export type ChannelMemberRole = "ADMIN" | "MEMBER";

export type ChannelPeer = { userId: string; fullName: string; avatarUrl: string | null };

export type Channel = {
  id: string;
  workspaceId: string;
  name: string | null;
  type: ChannelType;
  topic: string | null;
  description: string | null;
  createdBy: string | null;
  lastMessageSeq: number;
  lastMessageAt: string | null;
  memberCount: number;
  archivedAt: string | null;
  createdAt: string;
  role: ChannelMemberRole | null;
  lastReadSeq: number | null;
  mutedUntil: string | null;
  dmPeer: ChannelPeer | null;
};

export type ChannelMember = {
  userId: string;
  fullName: string;
  avatarUrl: string | null;
  role: ChannelMemberRole;
  lastReadSeq: number;
  joinedAt: string;
};

export type ReactionSummary = { emoji: string; count: number; me: boolean };

export type Attachment = {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  thumbPath: string | null;
};

export type Message = {
  id: string;
  workspaceId: string;
  channelId: string;
  seq: number;
  senderId: string;
  body: string | null;
  clientMsgId: string;
  threadRootId: string | null;
  replyCount: number;
  lastReplyAt: string | null;
  editedAt: string | null;
  deletedAt: string | null;
  createdAt: string;
  reactions: ReactionSummary[];
  attachments: Attachment[];
};

export type MessagePage = { messages: Message[]; hasMore: boolean };

export type ReactionResult = { emoji: string; count: number; added: boolean };
