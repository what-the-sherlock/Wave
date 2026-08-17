import type { WorkspaceRole } from "../workspaces/workspace.repository.js";

/**
 * Two distinct questions, two mechanisms (docs/security-model.md §4):
 *   - "which rows may I read/write?"  → Postgres RLS
 *   - "what actions may I perform?"   → this table
 *
 * Code checks permissions, never roles, so adding a role later (GUEST was
 * cut from v1 — see docs/implementation-roadmap.md "Scope discipline") is a
 * table edit here, not a search-and-replace across every handler.
 *
 * Ownership-qualified permissions (e.g. `member:update_role:below_admin`)
 * are resolved by the service against the specific resource; this table
 * only establishes *what role you have*.
 */
export const PERMISSIONS: Readonly<Record<WorkspaceRole, readonly string[]>> = Object.freeze({
  OWNER: ["workspace:*", "channel:*", "message:*", "member:*", "ai:*"],
  ADMIN: [
    "workspace:read",
    "workspace:update",
    "channel:*",
    "message:*",
    "member:invite",
    "member:remove",
    "member:update_role:below_admin",
    "ai:*",
  ],
  MEMBER: [
    "workspace:read",
    "channel:read",
    "channel:create",
    "channel:join_public",
    "message:create",
    "message:update:own",
    "message:delete:own",
    "ai:query",
    "ai:toggle",
  ],
});

/**
 * `"member:*"` satisfies a request for `"member:invite"` or
 * `"member:update_role:below_admin"` — the same wildcard-prefix convention
 * `PERMISSIONS` is written in.
 */
export function hasPermission(role: WorkspaceRole, permission: string): boolean {
  const granted = PERMISSIONS[role];
  return granted.some((entry) => {
    if (entry === permission) return true;
    if (entry.endsWith(":*")) {
      const prefix = entry.slice(0, -1); // "member:*" -> "member:"
      return permission.startsWith(prefix);
    }
    return false;
  });
}
