import { randomBytes, createHash } from "node:crypto";
import { withRlsScope } from "../db/rlsScope.js";
import { config } from "../config/env.js";
import { ConflictError, ForbiddenError, NotFoundError } from "../errors/AppError.js";
import { getRealtimeEmitter } from "../realtime/emitter.js";
import * as workspaceRepo from "./workspace.repository.js";
import * as inviteRepo from "./invite.repository.js";
import * as profileRepo from "../profiles/profile.repository.js";
import type { Invite, InvitePreview } from "./invite.repository.js";
import type { WorkspaceRole } from "./workspace.repository.js";
import { sendInviteEmail } from "./inviteEmail.js";

export type { Invite, InvitePreview } from "./invite.repository.js";

const DEFAULT_EXPIRY_DAYS = 7;
const DEFAULT_MAX_USES_EMAIL = 1;
const DEFAULT_MAX_USES_LINK = 50;

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export type CreateInviteInput = {
  email?: string;
  role: WorkspaceRole;
  maxUses?: number;
  expiresInDays?: number;
};

export async function createInvite(
  actorUserId: string,
  workspaceId: string,
  input: CreateInviteInput,
): Promise<{ invite: Invite; token: string }> {
  const token = randomBytes(32).toString("base64url");
  const tokenHash = hashToken(token);
  const expiresAt = new Date(
    Date.now() + (input.expiresInDays ?? DEFAULT_EXPIRY_DAYS) * 24 * 60 * 60 * 1000,
  );
  const maxUses =
    input.maxUses ?? (input.email ? DEFAULT_MAX_USES_EMAIL : DEFAULT_MAX_USES_LINK);

  const { invite, workspaceName, inviterName } = await withRlsScope(
    { userId: actorUserId },
    async (tx) => {
      const workspace = await workspaceRepo.findById(tx, workspaceId);
      if (!workspace) {
        throw new NotFoundError("Workspace not found");
      }
      const inviter = await profileRepo.findById(tx, actorUserId);
      const created = await inviteRepo.insert(tx, {
        workspaceId,
        email: input.email ?? null,
        tokenHash,
        role: input.role,
        invitedBy: actorUserId,
        maxUses,
        expiresAt,
      });
      return {
        invite: created,
        workspaceName: workspace.name,
        inviterName: inviter?.fullName ?? "A teammate",
      };
    },
  );

  if (input.email) {
    const acceptUrl = `${config.CORS_ORIGINS[0]}/invite/${token}`;
    void sendInviteEmail({
      to: input.email,
      workspaceName,
      inviterName,
      acceptUrl,
    });
  }

  return { invite, token };
}

export async function listInvites(userId: string, workspaceId: string): Promise<Invite[]> {
  return withRlsScope({ userId }, (tx) => inviteRepo.listByWorkspace(tx, workspaceId));
}

export async function revokeInvite(
  userId: string,
  workspaceId: string,
  inviteId: string,
): Promise<void> {
  return withRlsScope({ userId }, async (tx) => {
    const revoked = await inviteRepo.revoke(tx, workspaceId, inviteId);
    if (!revoked) {
      throw new NotFoundError("Invite not found");
    }
  });
}

export async function previewInvite(userId: string, token: string): Promise<InvitePreview> {
  const preview = await withRlsScope({ userId }, (tx) =>
    inviteRepo.previewByTokenHash(tx, hashToken(token)),
  );
  if (!preview) {
    throw new NotFoundError("Invite not found");
  }
  return preview;
}

const INVITE_ERROR_MAP: Record<string, () => never> = {
  invite_not_found: () => {
    throw new NotFoundError("Invite not found");
  },
  invite_revoked: () => {
    throw new ConflictError("This invite has been revoked");
  },
  invite_expired: () => {
    throw new ConflictError("This invite has expired");
  },
  invite_exhausted: () => {
    throw new ConflictError("This invite has already been used");
  },
  invite_email_mismatch: () => {
    throw new ForbiddenError("This invite was issued for a different email address");
  },
};

export async function acceptInvite(
  userId: string,
  token: string,
): Promise<{ workspaceId: string; role: WorkspaceRole }> {
  try {
    const result = await withRlsScope({ userId }, (tx) =>
      inviteRepo.acceptByTokenHash(tx, hashToken(token)),
    );
    getRealtimeEmitter().toWorkspace(result.workspaceId, "workspace.member.joined", {
      workspaceId: result.workspaceId,
      userId,
      role: result.role,
    });
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const mapped = INVITE_ERROR_MAP[message];
    if (mapped) {
      mapped();
    }
    throw err;
  }
}
