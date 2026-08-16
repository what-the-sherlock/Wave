import { randomBytes } from "node:crypto";
import { withRlsScope } from "../db/rlsScope.js";
import { ConflictError, NotFoundError } from "../errors/AppError.js";
import * as workspaceRepo from "./workspace.repository.js";
import * as memberRepo from "./member.repository.js";
import { createGeneralChannelInTx } from "../channels/channel.service.js";
import type { Workspace, WorkspaceRole, WorkspaceSettings } from "./workspace.repository.js";

export type { Workspace, WorkspaceRole, WorkspaceSettings } from "./workspace.repository.js";
export type WorkspaceWithRole = { workspace: Workspace; role: WorkspaceRole };

const MAX_SLUG_ATTEMPTS = 5;
const DEFAULT_SETTINGS: WorkspaceSettings = { allowPublicInvites: false, aiEnabled: true };

function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
  return base.length >= 3 ? base : `ws-${base}`;
}

function randomSuffix(): string {
  return randomBytes(3).toString("hex");
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "23505";
}

/**
 * Workspace + OWNER membership as a single atomic operation. Each slug
 * collision retries the *whole* transaction, not a statement within it —
 * Postgres aborts a transaction on the first error inside it, so retrying
 * the insert in the same `tx` after a unique-violation would just fail
 * again with "current transaction is aborted." A fresh `withRlsScope` call
 * per attempt sidesteps that entirely, and still gives forced non-slug
 * failures (e.g. a bad role on the membership insert) a clean rollback of
 * the workspace row too, via `withRlsScope`'s existing catch/ROLLBACK.
 */
export async function createWorkspace(userId: string, name: string): Promise<WorkspaceWithRole> {
  const base = slugify(name);

  for (let attempt = 0; attempt < MAX_SLUG_ATTEMPTS; attempt++) {
    const slug = attempt === 0 ? base : `${base}-${randomSuffix()}`;
    try {
      return await withRlsScope({ userId }, async (tx) => {
        const workspace = await workspaceRepo.insert(tx, {
          name,
          slug,
          ownerId: userId,
          settings: DEFAULT_SETTINGS,
          memberCount: 1,
        });
        await memberRepo.insertOwnerBootstrap(tx, workspace.id, userId);
        // The #general placeholder deferred from Phase 2 to here, now that
        // the channels table exists — atomic with the workspace itself
        // (docs/implementation-roadmap.md Phase 2 plan, "deliberate
        // deviations").
        await createGeneralChannelInTx(tx, workspace.id, userId);
        return { workspace, role: "OWNER" as const };
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        continue;
      }
      throw err;
    }
  }
  throw new ConflictError("Could not generate a unique workspace URL — try a different name");
}

export async function listMyWorkspaces(userId: string): Promise<WorkspaceWithRole[]> {
  return withRlsScope({ userId }, (tx) => workspaceRepo.listForUser(tx, userId));
}

/**
 * RLS already filters both `workspaces` and `workspace_members` to
 * member-visible rows, so a non-member's query returns nothing here —
 * `undefined` is the *only* signal, deliberately indistinguishable from
 * "doesn't exist," which is what lets callers return 404 rather than 403
 * (docs/security-model.md §4).
 */
export async function getByIdForUser(
  userId: string,
  workspaceId: string,
): Promise<WorkspaceWithRole | undefined> {
  return withRlsScope({ userId }, async (tx) => {
    const workspace = await workspaceRepo.findById(tx, workspaceId);
    if (!workspace) return undefined;
    const membership = await memberRepo.findMembership(tx, workspaceId, userId);
    if (!membership || membership.deactivatedAt) return undefined;
    return { workspace, role: membership.role };
  });
}

export async function getBySlugForUser(
  userId: string,
  slug: string,
): Promise<WorkspaceWithRole | undefined> {
  return withRlsScope({ userId }, async (tx) => {
    const workspace = await workspaceRepo.findBySlug(tx, slug);
    if (!workspace) return undefined;
    const membership = await memberRepo.findMembership(tx, workspace.id, userId);
    if (!membership || membership.deactivatedAt) return undefined;
    return { workspace, role: membership.role };
  });
}

/** Used by the socket `workspace.join` handler — the same RLS-scoped check
 * `resolveWorkspace` performs for HTTP, from a socket context instead. */
export async function verifyMembership(userId: string, workspaceId: string): Promise<boolean> {
  const result = await getByIdForUser(userId, workspaceId);
  return result !== undefined;
}

export type WorkspaceSettingsPatch = {
  name?: string;
  iconUrl?: string | null;
  settings?: Partial<WorkspaceSettings>;
};

export async function updateSettings(
  userId: string,
  workspaceId: string,
  patch: WorkspaceSettingsPatch,
): Promise<Workspace> {
  return withRlsScope({ userId }, async (tx) => {
    const existing = await workspaceRepo.findById(tx, workspaceId);
    if (!existing) {
      throw new NotFoundError("Workspace not found");
    }
    const updated = await workspaceRepo.update(tx, workspaceId, {
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.iconUrl !== undefined ? { iconUrl: patch.iconUrl } : {}),
      ...(patch.settings !== undefined
        ? { settings: { ...existing.settings, ...patch.settings } }
        : {}),
    });
    if (!updated) {
      throw new NotFoundError("Workspace not found");
    }
    return updated;
  });
}
