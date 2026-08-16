import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { makeTestApp } from "../helpers/testApp.js";
import { createChannelFixture, type ChannelFixture } from "../helpers/channelFixture.js";
import { signUpTestUser, type SignedUpUser } from "../helpers/authFixture.js";
import { isAuthServiceReachable, isDatabaseReachable } from "../helpers/db.js";
import { makeFakeEmbedder } from "../helpers/aiFixture.js";
import { setEmbedder, resetEmbedder } from "../../src/ai/embedder.js";
import { embeddingGenerateHandler } from "../../src/ai/embedding.worker.js";
import { retrieveForQuestion } from "../../src/ai/retrieval.service.js";
import { withRlsScope } from "../../src/db/rlsScope.js";

const dbUp = await isDatabaseReachable(process.env.DATABASE_URL!);
const authUp = await isAuthServiceReachable(process.env.SUPABASE_URL!, process.env.SUPABASE_ANON_KEY!);
const liveStackAvailable = dbUp && authUp;

describe.skipIf(!liveStackAvailable)("AI retrieval respects live channel removal (integration, live Supabase)", () => {
  const app = makeTestApp();
  let fixture: ChannelFixture;
  let member: SignedUpUser;
  const secret = `xqzwidget${randomUUID().slice(0, 8)}`;

  beforeAll(async () => {
    fixture = await createChannelFixture(app, "PRIVATE");
    member = await signUpTestUser(app);

    const inviteRes = await fixture.owner.agent
      .post(`/api/v1/workspaces/${fixture.workspace.id}/invites`)
      .send({ role: "MEMBER" });
    await member.agent.post(`/api/v1/invites/${inviteRes.body.token}/accept`);
    await fixture.owner.agent
      .post(`/api/v1/channels/${fixture.channel.id}/members`)
      .send({ userId: member.id });

    await fixture.owner.agent
      .post(`/api/v1/channels/${fixture.channel.id}/messages`)
      .send({ body: `the rollout plan mentions ${secret} explicitly`, clientMsgId: randomUUID() });

    setEmbedder(makeFakeEmbedder());
    await embeddingGenerateHandler({ channelId: fixture.channel.id });
  });

  afterEach(() => {
    resetEmbedder();
  });

  it("removing a member from the channel immediately stops AI retrieval from returning its content", async () => {
    const before = await withRlsScope({ userId: member.id }, (tx) =>
      retrieveForQuestion(tx, fixture.workspace.id, `what does the rollout plan mention?`),
    );
    expect(before.some((c) => c.body?.includes(secret))).toBe(true);

    await fixture.owner.agent.delete(`/api/v1/channels/${fixture.channel.id}/members/${member.id}`);

    const after = await withRlsScope({ userId: member.id }, (tx) =>
      retrieveForQuestion(tx, fixture.workspace.id, `what does the rollout plan mention?`),
    );
    expect(after.some((c) => c.body?.includes(secret))).toBe(false);
  });
});
