import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer, type ServerHandle } from "../../src/server.js";
import { channelRouter } from "../../src/channels/channel.routes.js";
import { collectScopedRoutes, buildPath } from "../helpers/routeIntrospection.js";
import { createChannelFixture, type ChannelFixture } from "../helpers/channelFixture.js";
import { createWorkspaceFixture, type WorkspaceFixture } from "../helpers/workspaceFixture.js";
import { signUpTestUser } from "../helpers/authFixture.js";
import { isAuthServiceReachable, isDatabaseReachable } from "../helpers/db.js";

const dbUp = await isDatabaseReachable(process.env.DATABASE_URL!);
const authUp = await isAuthServiceReachable(process.env.SUPABASE_URL!, process.env.SUPABASE_ANON_KEY!);
const liveStackAvailable = dbUp && authUp;

const BODIES_BY_PATH: Record<string, Record<string, unknown>> = {
  "/:channelId": { topic: "Adversarial topic change" },
  "/:channelId/members": { userId: "00000000-0000-4000-8000-000000000000" },
  "/:channelId/messages": { body: "hi", clientMsgId: "00000000-0000-4000-8000-000000000001" },
  "/:channelId/messages/:messageId": { body: "edited" },
  "/:channelId/messages/:messageId/reactions": { emoji: "👍" },
  "/:channelId/read": { seq: 1 },
};

describe.skipIf(!liveStackAvailable)("channel isolation (integration, live Supabase)", () => {
  let handle: ServerHandle;
  let A: WorkspaceFixture;
  let B: ChannelFixture;
  let bMessageId: string;

  beforeAll(async () => {
    handle = await buildServer();
    await new Promise<void>((resolve) => handle.httpServer.listen(0, resolve));

    [A, B] = await Promise.all([
      createWorkspaceFixture(handle.app),
      createChannelFixture(handle.app, "PRIVATE"),
    ]);
    const msgRes = await B.owner.agent
      .post(`/api/v1/channels/${B.channel.id}/messages`)
      .send({ body: "secret", clientMsgId: "11111111-1111-4111-8111-111111111111" });
    bMessageId = msgRes.body.id as string;
  });

  afterAll(async () => {
    await handle.close();
  });

  const routes = collectScopedRoutes(channelRouter, "", "channelId");

  it.each(routes)(
    "$method $path rejects a caller who is not a member of the target private channel (404, never 403)",
    async ({ method, path }) => {
      const params = { channelId: B.channel.id, userId: B.owner.id, messageId: bMessageId };
      const url = buildPath(path, params);
      const body = BODIES_BY_PATH[path] ?? {};

      const req = A.owner.agent[method as "get" | "post" | "patch" | "delete"](
        `/api/v1/channels${url}`,
      );
      const res = ["post", "patch", "put"].includes(method) ? await req.send(body) : await req;

      // B's channel is PRIVATE and A is not even a member of B's workspace,
      // so `resolveChannel`'s RLS-backed lookup can't see it at all — 404
      // uniformly, including /join (it never gets far enough to reach
      // joinPublicChannel's own type check).
      expect(res.status).toBe(404);
      expect(JSON.stringify(res.body)).not.toContain("secret");
    },
  );

  it(
    "a WORKSPACE member who is not a CHANNEL member gets 404 on a private channel's messages " +
      "(docs/implementation-roadmap.md Phase 3 DoD)",
    async () => {
      const outsider = await signUpTestUser(handle.app);
      const inviteRes = await B.owner.agent
        .post(`/api/v1/workspaces/${B.workspace.id}/invites`)
        .send({ role: "MEMBER" });
      await outsider.agent.post(`/api/v1/invites/${inviteRes.body.token}/accept`);

      // Now a confirmed workspace member, but never invited to the private
      // channel itself.
      const res = await outsider.agent.get(`/api/v1/channels/${B.channel.id}/messages`);
      expect(res.status).toBe(404);
    },
  );

  it("browsing a PUBLIC channel is visible workspace-wide without membership, but sending is not", async () => {
    const pub = await createChannelFixture(handle.app, "PUBLIC");
    const member = await signUpTestUser(handle.app);
    const inviteRes = await pub.owner.agent
      .post(`/api/v1/workspaces/${pub.workspace.id}/invites`)
      .send({ role: "MEMBER" });
    await member.agent.post(`/api/v1/invites/${inviteRes.body.token}/accept`);

    const getRes = await member.agent.get(`/api/v1/channels/${pub.channel.id}`);
    expect(getRes.status).toBe(200);

    // Discoverable, but posting requires joining first — the explicit
    // "browsing a public channel joins you" product decision
    // (docs/database-design.md §5.2).
    const sendRes = await member.agent
      .post(`/api/v1/channels/${pub.channel.id}/messages`)
      .send({ body: "hi", clientMsgId: "22222222-2222-4222-8222-222222222222" });
    expect(sendRes.status).toBe(403);

    const joinRes = await member.agent.post(`/api/v1/channels/${pub.channel.id}/join`);
    expect(joinRes.status).toBe(204);

    const sendAfterJoinRes = await member.agent
      .post(`/api/v1/channels/${pub.channel.id}/messages`)
      .send({ body: "hi", clientMsgId: "33333333-3333-4333-8333-333333333333" });
    expect(sendAfterJoinRes.status).toBe(201);
  });
});
