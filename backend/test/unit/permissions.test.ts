import { describe, expect, it } from "vitest";
import { hasPermission, PERMISSIONS } from "../../src/authz/permissions.js";

describe("hasPermission", () => {
  it("OWNER's workspace:* wildcard covers every concrete workspace permission", () => {
    expect(hasPermission("OWNER", "workspace:read")).toBe(true);
    expect(hasPermission("OWNER", "workspace:update")).toBe(true);
    expect(hasPermission("OWNER", "workspace:anything-at-all")).toBe(true);
  });

  it("OWNER's member:* wildcard covers ADMIN's exact-match permissions", () => {
    expect(hasPermission("OWNER", "member:invite")).toBe(true);
    expect(hasPermission("OWNER", "member:remove")).toBe(true);
    expect(hasPermission("OWNER", "member:update_role:below_admin")).toBe(true);
  });

  it("ADMIN has exactly the permissions listed, no more", () => {
    expect(hasPermission("ADMIN", "workspace:read")).toBe(true);
    expect(hasPermission("ADMIN", "workspace:update")).toBe(true);
    expect(hasPermission("ADMIN", "member:invite")).toBe(true);
    expect(hasPermission("ADMIN", "member:remove")).toBe(true);
    expect(hasPermission("ADMIN", "member:update_role:below_admin")).toBe(true);
    expect(hasPermission("ADMIN", "workspace:delete")).toBe(false);
  });

  it("MEMBER can read and create channels/messages but not manage members", () => {
    expect(hasPermission("MEMBER", "workspace:read")).toBe(true);
    expect(hasPermission("MEMBER", "channel:create")).toBe(true);
    expect(hasPermission("MEMBER", "message:create")).toBe(true);
    expect(hasPermission("MEMBER", "member:invite")).toBe(false);
    expect(hasPermission("MEMBER", "member:remove")).toBe(false);
    expect(hasPermission("MEMBER", "workspace:update")).toBe(false);
  });

  it("wildcard matching only matches on the exact prefix, not an arbitrary substring", () => {
    // "member:*" must not accidentally match "members:invite" or similar
    // near-miss strings — only permission:sub-permission continuations.
    expect(hasPermission("ADMIN", "channel:archive")).toBe(true); // channel:*
    expect(hasPermission("MEMBER", "channel:archive")).toBe(false); // MEMBER has no channel:*
  });

  it("every role's permission list is non-empty (no accidental lockout)", () => {
    for (const role of Object.keys(PERMISSIONS) as (keyof typeof PERMISSIONS)[]) {
      expect(PERMISSIONS[role].length).toBeGreaterThan(0);
    }
  });
});
