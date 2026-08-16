export type WorkspaceRole = "OWNER" | "ADMIN" | "MEMBER";

export type WorkspaceSettings = {
  allowPublicInvites: boolean;
  aiEnabled: boolean;
};

export type Workspace = {
  id: string;
  name: string;
  slug: string;
  iconUrl: string | null;
  memberCount: number;
  settings: WorkspaceSettings;
  role: WorkspaceRole;
  createdAt: string;
};

export type WorkspaceMember = {
  userId: string;
  fullName: string;
  avatarUrl: string | null;
  displayName: string | null;
  role: WorkspaceRole;
  joinedAt: string;
};

export type Invite = {
  id: string;
  email: string | null;
  role: WorkspaceRole;
  maxUses: number;
  useCount: number;
  expiresAt: string;
  revokedAt: string | null;
  createdAt: string;
};

export type CreatedInvite = Invite & { token: string };

export type InvitePreview = {
  workspaceName: string;
  workspaceIconUrl: string | null;
  inviterName: string;
  isValid: boolean;
};
