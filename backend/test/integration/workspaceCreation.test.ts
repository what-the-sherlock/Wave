import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { withRlsScope } from "../../src/db/rlsScope.js";
import { workspaces } from "../../src/db/schema.js";
import * as workspaceRepo from "../../src/workspaces/workspace.repository.js";
import * as memberRepo from "../../src/workspaces/member.repository.js";
import { createWorkspace } from "../../src/workspaces/workspace.service.js";
import { makeTestApp } from "../helpers/testApp.js";
import { signUpTestUser } from "../helpers/authFixture.js";
import { isAuthServiceReachable, isDatabaseReachable } from "../helpers/db.js";

const dbUp = await isDatabaseReachable(process.env.DATABASE_URL!);
const authUp = await isAuthServiceReachable(process.env.SUPABASE_URL!, process.env.SUPABASE_ANON_KEY!);
const liveStackAvailable = dbUp && authUp;

describe.skipIf(!liveStackAvailable)("workspace creation (integration, live Supabase)", () => {
  const app = makeTestApp();

  it(
    "atomicity: a forced failure on the membership insert rolls back the workspace insert too " +
      "(real RLS-enforced rollback via wm_insert_bootstrap's role='OWNER' check, not a mock)",
    async () => {
      const user = await signUpTestUser(app);
      const name = `Atomicity Test ${randomUUID()}`;
      const slug = `atomicity-${randomUUID().slice(0, 8)}`;

      await expect(
        withRlsScope({ userId: user.id }, async (tx) => {
          const workspace = await workspaceRepo.insert(tx, {
            name,
            slug,
            ownerId: user.id,
            settings: { allowPublicInvites: false, aiEnabled: true },
            memberCount: 1,
          });
          // Bypasses workspace.service (which always inserts role: "OWNER")
          // to simulate a downstream failure — wm_insert_bootstrap's
          // `role = 'OWNER'` check rejects this, which should roll back the
          // workspace insert above along with it.
          await memberRepo.insert(tx, {
            workspaceId: workspace.id,
            userId: user.id,
            role: "ADMIN",
          });
        }),
      ).rejects.toThrow();

      const survivingRows = await withRlsScope({ userId: user.id }, (tx) =>
        tx.select().from(workspaces).where(eq(workspaces.slug, slug)),
      );
      expect(survivingRows).toHaveLength(0);
    },
  );

  it("slug collision retries with a suffix rather than failing", async () => {
    const user = await signUpTestUser(app);
    const sharedName = `Duplicate Name ${randomUUID()}`;

    const first = await createWorkspace(user.id, sharedName);
    const second = await createWorkspace(user.id, sharedName);

    expect(first.workspace.slug).not.toBe(second.workspace.slug);
    expect(second.workspace.slug.startsWith(first.workspace.slug)).toBe(true);
  });

  it("workspace creation is atomic end-to-end via the HTTP API: the creator is immediately the OWNER", async () => {
    const user = await signUpTestUser(app);
    const res = await user.agent
      .post("/api/v1/workspaces")
      .send({ name: `HTTP Creation ${randomUUID()}` });

    expect(res.status).toBe(201);
    expect(res.body.role).toBe("OWNER");
    expect(res.body.memberCount).toBe(1);

    const membersRes = await user.agent.get(`/api/v1/workspaces/${res.body.id}/members`);
    expect(membersRes.status).toBe(200);
    expect(membersRes.body).toHaveLength(1);
    expect(membersRes.body[0].userId).toBe(user.id);
    expect(membersRes.body[0].role).toBe("OWNER");
  });
});
