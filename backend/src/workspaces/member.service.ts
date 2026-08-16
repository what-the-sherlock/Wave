import { withRlsScope } from "../db/rlsScope.js";
import { ConflictError, ForbiddenError, NotFoundError } from "../errors/AppError.js";
import { getRealtimeEmitter } from "../realtime/emitter.js";
import * as workspaceRepo from "./workspace.repository.js";
import * as memberRepo from "./member.repository.js";
import type { MemberWithProfile } from "./member.repository.js";
import type { WorkspaceRole } from "./workspace.repository.js";

export type { MemberWithProfile } from "./member.repository.js";

export async function listMembers(userId: string, workspaceId: string): Promise<MemberWithProfile[]> {
  return withRlsScope({ userId }, (tx) => memberRepo.listByWorkspace(tx, workspaceId));
}

/**
 * `member:update_role:below_admin` (docs/security-model.md §4) is
 * intentionally near-inert today: with GUEST cut from v1 there is no role
 * below MEMBER, so an ADMIN can only ever perform a MEMBER→MEMBER no-op.
 * It activates without a handler change if GUEST returns — exactly the
 * payoff the roadmap's "Scope discipline" describes.
 */
export async function updateRole(
  actorUserId: string,
  actorRole: WorkspaceRole,
  workspaceId: string,
  targetUserId: string,
  newRole: WorkspaceRole,
): Promise<void> {
  return withRlsScope({ userId: actorUserId }, async (tx) => {
    const workspace = await workspaceRepo.findById(tx, workspaceId);
    if (!workspace) {
      throw new NotFoundError("Workspace not found");
    }
    const target = await memberRepo.findMembership(tx, workspaceId, targetUserId);
    if (!target) {
      throw new NotFoundError("Member not found");
    }
    if (targetUserId === workspace.ownerId) {
      throw new ConflictError("The workspace owner's role cannot be changed");
    }
    if (newRole === "OWNER") {
      throw new ConflictError("Ownership transfer is not supported");
    }
    if (actorRole === "ADMIN" && (target.role !== "MEMBER" || newRole !== "MEMBER")) {
      throw new ForbiddenError("Admins may not change the role of another admin");
    }

    const updated = await memberRepo.updateRole(tx, workspaceId, targetUserId, newRole);
    if (!updated) {
      throw new NotFoundError("Member not found");
    }
  });
}

async function removeMemberRow(
  actorUserId: string,
  workspaceId: string,
  targetUserId: string,
  guard: (workspace: workspaceRepo.Workspace, target: memberRepo.WorkspaceMember) => void,
): Promise<void> {
  await withRlsScope({ userId: actorUserId }, async (tx) => {
    const workspace = await workspaceRepo.findById(tx, workspaceId);
    if (!workspace) {
      throw new NotFoundError("Workspace not found");
    }
    const target = await memberRepo.findMembership(tx, workspaceId, targetUserId);
    if (!target) {
      throw new NotFoundError("Member not found");
    }
    guard(workspace, target);

    const removed = await memberRepo.remove(tx, workspaceId, targetUserId);
    if (!removed) {
      throw new NotFoundError("Member not found");
    }
    await workspaceRepo.adjustMemberCount(tx, workspaceId, -1);
  });

  getRealtimeEmitter().evictUserFromWorkspace(targetUserId, workspaceId);
  getRealtimeEmitter().toWorkspace(workspaceId, "workspace.member.removed", {
    workspaceId,
    userId: targetUserId,
  });
}

export async function removeMember(
  actorUserId: string,
  actorRole: WorkspaceRole,
  workspaceId: string,
  targetUserId: string,
): Promise<void> {
  return removeMemberRow(actorUserId, workspaceId, targetUserId, (workspace, target) => {
    if (targetUserId === workspace.ownerId) {
      throw new ConflictError("The workspace owner cannot be removed");
    }
    if (actorRole === "ADMIN" && target.role !== "MEMBER") {
      throw new ForbiddenError("Admins may only remove members, not other admins");
    }
  });
}

/** Ownership transfer is cut for v1 (docs/implementation-roadmap.md "Scope
 * discipline") — there is currently no path to vacate ownership, so the
 * owner cannot leave their own workspace. */
export async function leave(userId: string, workspaceId: string): Promise<void> {
  return removeMemberRow(userId, workspaceId, userId, (workspace) => {
    if (userId === workspace.ownerId) {
      throw new ConflictError(
        "The workspace owner cannot leave — ownership transfer is not supported",
      );
    }
  });
}
