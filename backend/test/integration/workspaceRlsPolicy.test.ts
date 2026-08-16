import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { withRlsScope } from "../../src/db/rlsScope.js";
import { workspaces, workspaceMembers, invites } from "../../src/db/schema.js";
import { makeTestApp } from "../helpers/testApp.js";
import { createWorkspaceFixture, type WorkspaceFixture } from "../helpers/workspaceFixture.js";
import { isAuthServiceReachable, isDatabaseReachable } from "../helpers/db.js";

const dbUp = await isDatabaseReachable(process.env.DATABASE_URL!);
const authUp = await isAuthServiceReachable(process.env.SUPABASE_URL!, process.env.SUPABASE_ANON_KEY!);
const liveStackAvailable = dbUp && authUp;

/**
 * Proves the *database* enforces workspace isolation, independent of the
 * HTTP layer — the same discipline as test/integration/rlsPolicy.test.ts,
 * extended to the three Phase 2 tables. This is what would still fail even
 * if every repository method forgot its scope filter entirely.
 */
describe.skipIf(!liveStackAvailable)("Workspace Row-Level Security (integration, live Supabase)", () => {
  const app = makeTestApp();
  let A: WorkspaceFixture;
  let B: WorkspaceFixture;

  beforeAll(async () => {
    [A, B] = await Promise.all([createWorkspaceFixture(app), createWorkspaceFixture(app)]);
  });

  it("user A sees zero rows of workspace B across workspaces/workspace_members/invites", async () => {
    // Give B an invite to make sure the invites-table check has a real row
    // to fail to see.
    await B.owner.agent
      .post(`/api/v1/workspaces/${B.workspace.id}/invites`)
      .send({ role: "MEMBER" });

    const [wsRows, memberRows, inviteRows] = await withRlsScope({ userId: A.owner.id }, (tx) =>
      Promise.all([
        tx.select().from(workspaces).where(eq(workspaces.id, B.workspace.id)),
        tx.select().from(workspaceMembers).where(eq(workspaceMembers.workspaceId, B.workspace.id)),
        tx.select().from(invites).where(eq(invites.workspaceId, B.workspace.id)),
      ]),
    );

    expect(wsRows).toHaveLength(0);
    expect(memberRows).toHaveLength(0);
    expect(inviteRows).toHaveLength(0);
  });

  it(
    "pooled-connection scope does not leak between interleaved workspace-scoped requests " +
      "(docs/security-model.md §4 — the exact pattern transaction-mode pooling risks)",
    async () => {
      const [rowsForA, rowsForB] = await Promise.all([
        withRlsScope({ userId: A.owner.id }, (tx) => tx.select().from(workspaces)),
        withRlsScope({ userId: B.owner.id }, (tx) => tx.select().from(workspaces)),
      ]);

      expect(rowsForA.map((w) => w.id)).toEqual([A.workspace.id]);
      expect(rowsForB.map((w) => w.id)).toEqual([B.workspace.id]);
    },
  );

  it(
    "a member selecting workspace_members for their own workspace does not recurse or hang " +
      "(proves the SECURITY DEFINER helper pattern actually breaks the recursion trap)",
    async () => {
      const rows = await withRlsScope({ userId: A.owner.id }, (tx) =>
        tx.select().from(workspaceMembers).where(eq(workspaceMembers.workspaceId, A.workspace.id)),
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.userId).toBe(A.owner.id);
      expect(rows[0]?.role).toBe("OWNER");
    },
  );

  it("workspace_members visible to A never includes a row for a user outside A's workspaces", async () => {
    const rows = await withRlsScope({ userId: A.owner.id }, (tx) =>
      tx.select().from(workspaceMembers),
    );
    expect(rows.every((r) => r.workspaceId === A.workspace.id)).toBe(true);
    expect(rows.some((r) => r.userId === B.owner.id)).toBe(false);
  });
});
