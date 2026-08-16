import { and, eq } from "drizzle-orm";
import { sql } from "drizzle-orm";
import type { Tx } from "../db/rlsScope.js";
import { invites } from "../db/schema.js";
import type { Invite, NewInvite } from "../db/schema.js";
import type { WorkspaceRole } from "./workspace.repository.js";

export type { Invite, NewInvite } from "../db/schema.js";

export async function insert(tx: Tx, data: NewInvite): Promise<Invite> {
  const [row] = await tx.insert(invites).values(data).returning();
  if (!row) {
    throw new Error("invites insert returned no row");
  }
  return row;
}

export async function listByWorkspace(tx: Tx, workspaceId: string): Promise<Invite[]> {
  return tx.select().from(invites).where(eq(invites.workspaceId, workspaceId));
}

export async function findById(
  tx: Tx,
  workspaceId: string,
  inviteId: string,
): Promise<Invite | undefined> {
  const [row] = await tx
    .select()
    .from(invites)
    .where(and(eq(invites.workspaceId, workspaceId), eq(invites.id, inviteId)))
    .limit(1);
  return row;
}

export async function revoke(
  tx: Tx,
  workspaceId: string,
  inviteId: string,
): Promise<Invite | undefined> {
  const [row] = await tx
    .update(invites)
    .set({ revokedAt: new Date() })
    .where(and(eq(invites.workspaceId, workspaceId), eq(invites.id, inviteId)))
    .returning();
  return row;
}

export type AcceptInviteResult = { workspaceId: string; role: WorkspaceRole };

/**
 * Calls the `accept_invite()` SECURITY DEFINER function (see the Phase 2
 * migration) — the only way a non-member can create their own membership
 * row, since RLS would otherwise refuse it. Business-rule failures (revoked,
 * expired, exhausted, email mismatch, not found) surface as the Postgres
 * error the function raised; `invite.service.ts` pattern-matches
 * `err.message` into the right `AppError`.
 */
export async function acceptByTokenHash(tx: Tx, tokenHash: string): Promise<AcceptInviteResult> {
  const result = await tx.execute<{ workspace_id: string; role: WorkspaceRole }>(
    sql`select * from accept_invite(${tokenHash})`,
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error("invite_not_found");
  }
  return { workspaceId: row.workspace_id, role: row.role };
}

export type InvitePreview = {
  workspaceName: string;
  workspaceIconUrl: string | null;
  inviterName: string;
  isValid: boolean;
};

export async function previewByTokenHash(
  tx: Tx,
  tokenHash: string,
): Promise<InvitePreview | undefined> {
  const result = await tx.execute<{
    workspace_name: string;
    workspace_icon_url: string | null;
    inviter_name: string;
    is_valid: boolean;
  }>(sql`select * from invite_preview(${tokenHash})`);
  const row = result.rows[0];
  if (!row) {
    return undefined;
  }
  return {
    workspaceName: row.workspace_name,
    workspaceIconUrl: row.workspace_icon_url,
    inviterName: row.inviter_name,
    isValid: row.is_valid,
  };
}
