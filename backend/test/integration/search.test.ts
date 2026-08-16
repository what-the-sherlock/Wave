import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { makeTestApp } from "../helpers/testApp.js";
import { createChannelFixture, type ChannelFixture } from "../helpers/channelFixture.js";
import { signUpTestUser } from "../helpers/authFixture.js";
import { isAuthServiceReachable, isDatabaseReachable } from "../helpers/db.js";

const dbUp = await isDatabaseReachable(process.env.DATABASE_URL!);
const authUp = await isAuthServiceReachable(process.env.SUPABASE_URL!, process.env.SUPABASE_ANON_KEY!);
const liveStackAvailable = dbUp && authUp;

describe.skipIf(!liveStackAvailable)("search (integration, live Supabase)", () => {
  const app = makeTestApp();
  let fixture: ChannelFixture;

  beforeAll(async () => {
    fixture = await createChannelFixture(app);
  });

  it("finds a message by a distinctive term and returns a highlighted snippet", async () => {
    const distinctive = `xylophone${randomUUID().slice(0, 8)}`;
    await fixture.owner.agent
      .post(`/api/v1/channels/${fixture.channel.id}/messages`)
      .send({ body: `practicing the ${distinctive} today`, clientMsgId: randomUUID() });

    const res = await fixture.owner.agent
      .get(`/api/v1/workspaces/${fixture.workspace.id}/search`)
      .query({ q: distinctive });
    expect(res.status).toBe(200);
    expect(res.body.results.length).toBeGreaterThan(0);
    expect(res.body.results[0].snippet).toContain(distinctive);
  });

  it("a deleted message is excluded from results", async () => {
    const term = `deletedterm${randomUUID().slice(0, 8)}`;
    const msg = await fixture.owner.agent
      .post(`/api/v1/channels/${fixture.channel.id}/messages`)
      .send({ body: `will be gone ${term}`, clientMsgId: randomUUID() });
    await fixture.owner.agent.delete(`/api/v1/channels/${fixture.channel.id}/messages/${msg.body.id}`);

    const res = await fixture.owner.agent
      .get(`/api/v1/workspaces/${fixture.workspace.id}/search`)
      .query({ q: term });
    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(0);
  });

  it("never returns a hit from a workspace the caller isn't in", async () => {
    const fixtureB = await createChannelFixture(app);
    const shared = `crosstenant${randomUUID().slice(0, 8)}`;

    await fixtureB.owner.agent
      .post(`/api/v1/channels/${fixtureB.channel.id}/messages`)
      .send({ body: `secret ${shared} in workspace B`, clientMsgId: randomUUID() });

    const res = await fixture.owner.agent
      .get(`/api/v1/workspaces/${fixture.workspace.id}/search`)
      .query({ q: shared });
    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(0);
  });

  it("a message in a private channel is invisible to a workspace member who isn't a channel member", async () => {
    const privateFixture = await createChannelFixture(app, "PRIVATE");
    const term = `privatesearch${randomUUID().slice(0, 8)}`;
    await privateFixture.owner.agent
      .post(`/api/v1/channels/${privateFixture.channel.id}/messages`)
      .send({ body: `hidden ${term} content`, clientMsgId: randomUUID() });

    const outsider = await signUpTestUser(app);
    const invite = await privateFixture.owner.agent
      .post(`/api/v1/workspaces/${privateFixture.workspace.id}/invites`)
      .send({ role: "MEMBER" });
    await outsider.agent.post(`/api/v1/invites/${invite.body.token}/accept`);
    // Deliberately never joins the private channel itself.

    const res = await outsider.agent
      .get(`/api/v1/workspaces/${privateFixture.workspace.id}/search`)
      .query({ q: term });
    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(0);
  });
});
