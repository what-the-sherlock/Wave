import { and, eq } from "drizzle-orm";
import type { Tx } from "../db/rlsScope.js";
import { workspaceMembers, profiles } from "../db/schema.js";
import type { WorkspaceMember, NewWorkspaceMember } from "../db/schema.js";

export type { WorkspaceMember, NewWorkspaceMember } from "../db/schema.js";

export async function findMembership(
  tx: Tx,
  workspaceId: string,
  userId: string,
): Promise<WorkspaceMember | undefined> {
  const [row] = await tx
    .select()
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)))
    .limit(1);
  return row;
}

export type MemberWithProfile = WorkspaceMember & {
  fullName: string;
  avatarUrl: string | null;
};

export async function listByWorkspace(tx: Tx, workspaceId: string): Promise<MemberWithProfile[]> {
  const rows = await tx
    .select({
      id: workspaceMembers.id,
      workspaceId: workspaceMembers.workspaceId,
      userId: workspaceMembers.userId,
      role: workspaceMembers.role,
      displayName: workspaceMembers.displayName,
      invitedBy: workspaceMembers.invitedBy,
      joinedAt: workspaceMembers.joinedAt,
      deactivatedAt: workspaceMembers.deactivatedAt,
      fullName: profiles.fullName,
      avatarUrl: profiles.avatarUrl,
    })
    .from(workspaceMembers)
    .innerJoin(profiles, eq(workspaceMembers.userId, profiles.id))
    .where(eq(workspaceMembers.workspaceId, workspaceId));
  return rows;
}

export async function insert(tx: Tx, data: NewWorkspaceMember): Promise<WorkspaceMember> {
  const [row] = await tx.insert(workspaceMembers).values(data).returning();
  if (!row) {
    throw new Error("workspace_members insert returned no row");
  }
  return row;
}

/**
 * The one-time bootstrap insert (a workspace's creator becoming its OWNER,
 * matched by `wm_insert_bootstrap` — see the Phase 2 migration) deliberately
 * does not use `.returning()`. Postgres RLS re-checks the SELECT policy for
 * a RETURNING row, and that re-check's internal query — issued by
 * `is_workspace_member()`, itself a query against this same table — does
 * not see the row this very statement just inserted, so `RETURNING` here
 * fails with "new row violates row-level security policy" even though the
 * insert itself is permitted and succeeds. Nothing needs the row back: the
 * caller (workspace.service.ts's createWorkspace) already knows every field
 * it would contain.
 */
export async function insertOwnerBootstrap(
  tx: Tx,
  workspaceId: string,
  userId: string,
): Promise<void> {
  await tx.insert(workspaceMembers).values({ workspaceId, userId, role: "OWNER" });
}

export async function updateRole(
  tx: Tx,
  workspaceId: string,
  userId: string,
  role: WorkspaceMember["role"],
): Promise<WorkspaceMember | undefined> {
  const [row] = await tx
    .update(workspaceMembers)
    .set({ role })
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)))
    .returning();
  return row;
}

export async function remove(tx: Tx, workspaceId: string, userId: string): Promise<boolean> {
  const rows = await tx
    .delete(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)))
    .returning({ id: workspaceMembers.id });
  return rows.length > 0;
}
