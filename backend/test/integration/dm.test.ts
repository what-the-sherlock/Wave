import { describe, expect, it } from "vitest";
import { makeTestApp } from "../helpers/testApp.js";
import { createWorkspaceFixture } from "../helpers/workspaceFixture.js";
import { signUpTestUser } from "../helpers/authFixture.js";
import { isAuthServiceReachable, isDatabaseReachable } from "../helpers/db.js";

const dbUp = await isDatabaseReachable(process.env.DATABASE_URL!);
const authUp = await isAuthServiceReachable(process.env.SUPABASE_URL!, process.env.SUPABASE_ANON_KEY!);
const liveStackAvailable = dbUp && authUp;

describe.skipIf(!liveStackAvailable)("direct messages (integration, live Supabase)", () => {
  const app = makeTestApp();

  it("create-or-get: opening a DM twice from the same side returns the same channel", async () => {
    const workspace = await createWorkspaceFixture(app);
    const other = await signUpTestUser(app);
    const inviteRes = await workspace.owner.agent
      .post(`/api/v1/workspaces/${workspace.workspace.id}/invites`)
      .send({ role: "MEMBER" });
    await other.agent.post(`/api/v1/invites/${inviteRes.body.token}/accept`);

    const first = await workspace.owner.agent
      .post(`/api/v1/workspaces/${workspace.workspace.id}/dms`)
      .send({ userId: other.id });
    expect(first.status).toBe(200);
    expect(first.body.type).toBe("DM");
    expect(first.body.dmPeer).toEqual({
      userId: other.id,
      fullName: other.fullName,
      avatarUrl: null,
    });

    const second = await workspace.owner.agent
      .post(`/api/v1/workspaces/${workspace.workspace.id}/dms`)
      .send({ userId: other.id });
    expect(second.status).toBe(200);
    expect(second.body.id).toBe(first.body.id);
    expect(second.body.dmPeer.userId).toBe(other.id);
  });

  it(
    "a DM's channel list and single-channel views resolve the other participant as `dmPeer`, " +
      "reversed for each side, and a non-DM channel carries no dmPeer",
    async () => {
      const workspace = await createWorkspaceFixture(app);
      const other = await signUpTestUser(app);
      const inviteRes = await workspace.owner.agent
        .post(`/api/v1/workspaces/${workspace.workspace.id}/invites`)
        .send({ role: "MEMBER" });
      await other.agent.post(`/api/v1/invites/${inviteRes.body.token}/accept`);

      const dm = await workspace.owner.agent
        .post(`/api/v1/workspaces/${workspace.workspace.id}/dms`)
        .send({ userId: other.id });

      const ownerList = await workspace.owner.agent.get(
        `/api/v1/workspaces/${workspace.workspace.id}/channels`,
      );
      const ownerDmEntry = ownerList.body.find((c: { id: string }) => c.id === dm.body.id);
      expect(ownerDmEntry.dmPeer.userId).toBe(other.id);
      const ownerGeneralEntry = ownerList.body.find((c: { name: string }) => c.name === "general");
      expect(ownerGeneralEntry.dmPeer).toBeNull();
      // The list endpoint now carries real per-user membership (it used to
      // hardcode role/lastReadSeq to null for every channel).
      expect(ownerGeneralEntry.role).toBe("ADMIN");
      expect(ownerGeneralEntry.lastReadSeq).toBe(0);

      const otherSingle = await other.agent.get(`/api/v1/channels/${dm.body.id}`);
      expect(otherSingle.body.dmPeer.userId).toBe(workspace.owner.id);
      expect(otherSingle.body.dmPeer.fullName).toBe(workspace.owner.fullName);
    },
  );

  it(
    "create-or-get is race-safe: opening the same DM concurrently from both sides never produces " +
      "two channels for the same pair, guarded by the dm_key unique partial index " +
      "(docs/database-design.md §4)",
    async () => {
      const workspace = await createWorkspaceFixture(app);
      const other = await signUpTestUser(app);
      const inviteRes = await workspace.owner.agent
        .post(`/api/v1/workspaces/${workspace.workspace.id}/invites`)
        .send({ role: "MEMBER" });
      await other.agent.post(`/api/v1/invites/${inviteRes.body.token}/accept`);

      const [fromOwner, fromOther] = await Promise.all([
        workspace.owner.agent
          .post(`/api/v1/workspaces/${workspace.workspace.id}/dms`)
          .send({ userId: other.id }),
        other.agent
          .post(`/api/v1/workspaces/${workspace.workspace.id}/dms`)
          .send({ userId: workspace.owner.id }),
      ]);

      expect(fromOwner.status).toBe(200);
      expect(fromOther.status).toBe(200);
      expect(fromOwner.body.id).toBe(fromOther.body.id);
    },
  );

  it("a DM's messages are invisible to a third workspace member", async () => {
    const workspace = await createWorkspaceFixture(app);
    const other = await signUpTestUser(app);
    const third = await signUpTestUser(app);
    for (const user of [other, third]) {
      const inviteRes = await workspace.owner.agent
        .post(`/api/v1/workspaces/${workspace.workspace.id}/invites`)
        .send({ role: "MEMBER" });
      await user.agent.post(`/api/v1/invites/${inviteRes.body.token}/accept`);
    }

    const dm = await workspace.owner.agent
      .post(`/api/v1/workspaces/${workspace.workspace.id}/dms`)
      .send({ userId: other.id });
    await workspace.owner.agent
      .post(`/api/v1/channels/${dm.body.id}/messages`)
      .send({ body: "just us", clientMsgId: "44444444-4444-4444-8444-444444444444" });

    const res = await third.agent.get(`/api/v1/channels/${dm.body.id}/messages`);
    expect(res.status).toBe(404);
  });
});
