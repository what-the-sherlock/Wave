import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { makeTestApp } from "../helpers/testApp.js";
import { createWorkspaceFixture, type WorkspaceFixture } from "../helpers/workspaceFixture.js";
import { signUpTestUser } from "../helpers/authFixture.js";
import { isAuthServiceReachable, isDatabaseReachable } from "../helpers/db.js";

const dbUp = await isDatabaseReachable(process.env.DATABASE_URL!);
const authUp = await isAuthServiceReachable(process.env.SUPABASE_URL!, process.env.SUPABASE_ANON_KEY!);
const liveStackAvailable = dbUp && authUp;

describe.skipIf(!liveStackAvailable)("invites (integration, live Supabase)", () => {
  const app = makeTestApp();
  const adminPool = new Pool({ connectionString: process.env.DATABASE_URL! });

  afterAll(async () => {
    await adminPool.end();
  });

  async function createInvite(
    fixture: WorkspaceFixture,
    body: Record<string, unknown> = {},
  ): Promise<{ id: string; token: string }> {
    const res = await fixture.owner.agent
      .post(`/api/v1/workspaces/${fixture.workspace.id}/invites`)
      .send({ role: "MEMBER", ...body });
    expect(res.status).toBe(201);
    return { id: res.body.id as string, token: res.body.token as string };
  }

  it("accept: a fresh user joins the workspace with the invite's role", async () => {
    const A = await createWorkspaceFixture(app);
    const invite = await createInvite(A);
    const joiner = await signUpTestUser(app);

    const res = await joiner.agent.post(`/api/v1/invites/${invite.token}/accept`);
    expect(res.status).toBe(200);
    expect(res.body.workspaceId).toBe(A.workspace.id);
    expect(res.body.role).toBe("MEMBER");

    const membersRes = await A.owner.agent.get(`/api/v1/workspaces/${A.workspace.id}/members`);
    expect(membersRes.body.some((m: { userId: string }) => m.userId === joiner.id)).toBe(true);
  });

  it("double-accept is idempotent: the second call succeeds without incrementing use_count", async () => {
    const A = await createWorkspaceFixture(app);
    const invite = await createInvite(A, { maxUses: 5 });
    const joiner = await signUpTestUser(app);

    const first = await joiner.agent.post(`/api/v1/invites/${invite.token}/accept`);
    expect(first.status).toBe(200);
    const second = await joiner.agent.post(`/api/v1/invites/${invite.token}/accept`);
    expect(second.status).toBe(200);
    expect(second.body.workspaceId).toBe(A.workspace.id);

    const { rows } = await adminPool.query<{ use_count: number }>(
      "select use_count from invites where id = $1",
      [invite.id],
    );
    expect(rows[0]?.use_count).toBe(1);
  });

  it("expired: an invite past its expires_at is rejected with 409", async () => {
    const A = await createWorkspaceFixture(app);
    const invite = await createInvite(A);
    await adminPool.query("update invites set expires_at = now() - interval '1 day' where id = $1", [
      invite.id,
    ]);
    const joiner = await signUpTestUser(app);

    const res = await joiner.agent.post(`/api/v1/invites/${invite.token}/accept`);
    expect(res.status).toBe(409);
  });

  it("revoked: a revoked invite is rejected with 409", async () => {
    const A = await createWorkspaceFixture(app);
    const invite = await createInvite(A);
    const revokeRes = await A.owner.agent.delete(
      `/api/v1/workspaces/${A.workspace.id}/invites/${invite.id}`,
    );
    expect(revokeRes.status).toBe(204);
    const joiner = await signUpTestUser(app);

    const res = await joiner.agent.post(`/api/v1/invites/${invite.token}/accept`);
    expect(res.status).toBe(409);
  });

  it("wrong email: an email-scoped invite rejects a different accepting user with 403", async () => {
    const A = await createWorkspaceFixture(app);
    const invite = await createInvite(A, { email: `only-for-${randomUUID()}@example.com` });
    const joiner = await signUpTestUser(app);

    const res = await joiner.agent.post(`/api/v1/invites/${invite.token}/accept`);
    expect(res.status).toBe(403);
  });

  it("exceeded uses: a maxUses:1 invite already consumed rejects a second, different user with 409", async () => {
    const A = await createWorkspaceFixture(app);
    const invite = await createInvite(A, { maxUses: 1 });
    const firstJoiner = await signUpTestUser(app);
    const secondJoiner = await signUpTestUser(app);

    const first = await firstJoiner.agent.post(`/api/v1/invites/${invite.token}/accept`);
    expect(first.status).toBe(200);

    const second = await secondJoiner.agent.post(`/api/v1/invites/${invite.token}/accept`);
    expect(second.status).toBe(409);
  });

  it("preview: shows workspace name without requiring membership, and reflects validity", async () => {
    const A = await createWorkspaceFixture(app);
    const invite = await createInvite(A);
    const stranger = await signUpTestUser(app);

    const res = await stranger.agent.get(`/api/v1/invites/${invite.token}`);
    expect(res.status).toBe(200);
    expect(res.body.workspaceName).toBe(A.workspace.name);
    expect(res.body.isValid).toBe(true);
  });

  it("an unknown token is rejected with 404, not 200/403 (does not confirm any invite exists)", async () => {
    const stranger = await signUpTestUser(app);
    const res = await stranger.agent.get(`/api/v1/invites/not-a-real-token`);
    expect(res.status).toBe(404);
  });

  it("a MEMBER cannot create invites (member:invite is OWNER/ADMIN only)", async () => {
    const A = await createWorkspaceFixture(app);
    const invite = await createInvite(A);
    const joiner = await signUpTestUser(app);
    await joiner.agent.post(`/api/v1/invites/${invite.token}/accept`);

    const res = await joiner.agent
      .post(`/api/v1/workspaces/${A.workspace.id}/invites`)
      .send({ role: "MEMBER" });
    expect(res.status).toBe(403);
  });
});
