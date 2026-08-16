import { eq, sql } from "drizzle-orm";
import type { Tx } from "../db/rlsScope.js";
import { workspaces, workspaceMembers } from "../db/schema.js";
import type { Workspace, NewWorkspace } from "../db/schema.js";

export type { Workspace, NewWorkspace, WorkspaceSettings } from "../db/schema.js";
export type WorkspaceRole = "OWNER" | "ADMIN" | "MEMBER";

/**
 * The only module (besides `db/**`) permitted to import the drizzle
 * client/schema directly for workspace rows — enforced by
 * `eslint.config.js`, matching `profiles/profile.repository.ts`'s pattern.
 */

export async function findById(tx: Tx, workspaceId: string): Promise<Workspace | undefined> {
  const [row] = await tx.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
  return row;
}

export async function findBySlug(tx: Tx, slug: string): Promise<Workspace | undefined> {
  const [row] = await tx.select().from(workspaces).where(eq(workspaces.slug, slug)).limit(1);
  return row;
}

export type WorkspaceWithRole = { workspace: Workspace; role: WorkspaceRole };

export async function listForUser(tx: Tx, userId: string): Promise<WorkspaceWithRole[]> {
  const rows = await tx
    .select({ workspace: workspaces, role: workspaceMembers.role })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaceMembers.workspaceId, workspaces.id))
    .where(eq(workspaceMembers.userId, userId));
  return rows;
}

export async function insert(tx: Tx, data: NewWorkspace): Promise<Workspace> {
  const [row] = await tx.insert(workspaces).values(data).returning();
  if (!row) {
    throw new Error("workspace insert returned no row");
  }
  return row;
}

export type WorkspacePatch = Partial<Pick<Workspace, "name" | "iconUrl" | "settings">>;

export async function update(
  tx: Tx,
  workspaceId: string,
  patch: WorkspacePatch,
): Promise<Workspace | undefined> {
  const [row] = await tx
    .update(workspaces)
    .set(patch)
    .where(eq(workspaces.id, workspaceId))
    .returning();
  return row;
}

/**
 * `member_count` is a denormalized, eventually-consistent display counter
 * (docs/database-design.md §4) — never allowed to read as negative.
 */
export async function adjustMemberCount(
  tx: Tx,
  workspaceId: string,
  delta: number,
): Promise<void> {
  await tx
    .update(workspaces)
    .set({ memberCount: sql`greatest(0, ${workspaces.memberCount} + ${delta})` })
    .where(eq(workspaces.id, workspaceId));
}
