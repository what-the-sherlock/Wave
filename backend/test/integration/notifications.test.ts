import { randomUUID } from "node:crypto";
import { describe, expect, it, beforeAll } from "vitest";
import { makeTestApp } from "../helpers/testApp.js";
import { createChannelFixture, type ChannelFixture } from "../helpers/channelFixture.js";
import { signUpTestUser, type SignedUpUser } from "../helpers/authFixture.js";
import { isAuthServiceReachable, isDatabaseReachable } from "../helpers/db.js";
import { notificationFanoutHandler } from "../../src/queue/workers/notificationFanout.worker.js";

const dbUp = await isDatabaseReachable(process.env.DATABASE_URL!);
const authUp = await isAuthServiceReachable(process.env.SUPABASE_URL!, process.env.SUPABASE_ANON_KEY!);
const liveStackAvailable = dbUp && authUp;

describe.skipIf(!liveStackAvailable)("notifications (integration, live Supabase)", () => {
  const app = makeTestApp();
  let fixture: ChannelFixture;
  let member: SignedUpUser;

  beforeAll(async () => {
    fixture = await createChannelFixture(app);
    member = await signUpTestUser(app);
    const invite = await fixture.owner.agent
      .post(`/api/v1/workspaces/${fixture.workspace.id}/invites`)
      .send({ role: "MEMBER" });
    await member.agent.post(`/api/v1/invites/${invite.body.token}/accept`);
    await member.agent.post(`/api/v1/channels/${fixture.channel.id}/join`);
  });

  async function sendMention(): Promise<{ id: string }> {
    const res = await fixture.owner.agent
      .post(`/api/v1/channels/${fixture.channel.id}/messages`)
      .send({ body: "hey @you", clientMsgId: randomUUID(), mentionedUserIds: [member.id] });
    expect(res.status).toBe(201);
    return res.body as { id: string };
  }

  it("a mention fans out to exactly one notification for the mentioned user, never the sender", async () => {
    const message = await sendMention();
    await notificationFanoutHandler({ messageId: message.id });

    const memberList = await member.agent.get("/api/v1/notifications");
    expect(memberList.body.notifications.some((n: { messageId: string }) => n.messageId === message.id)).toBe(
      true,
    );

    const ownerList = await fixture.owner.agent.get("/api/v1/notifications");
    expect(ownerList.body.notifications.some((n: { messageId: string }) => n.messageId === message.id)).toBe(
      false,
    );
  });

  it("idempotency: re-running the fanout for the same message never creates a second notification", async () => {
    const message = await sendMention();
    await notificationFanoutHandler({ messageId: message.id });
    await notificationFanoutHandler({ messageId: message.id });
    await notificationFanoutHandler({ messageId: message.id });

    const list = await member.agent.get("/api/v1/notifications");
    const matches = list.body.notifications.filter(
      (n: { messageId: string }) => n.messageId === message.id,
    );
    expect(matches).toHaveLength(1);
  });

  it("a muted channel produces no notification for the muter", async () => {
    const farFuture = new Date("9999-12-31T00:00:00Z").toISOString();
    const mute = await member.agent
      .patch(`/api/v1/channels/${fixture.channel.id}/members/me`)
      .send({ mutedUntil: farFuture });
    expect(mute.status).toBe(200);

    try {
      const message = await sendMention();
      await notificationFanoutHandler({ messageId: message.id });

      const list = await member.agent.get("/api/v1/notifications");
      expect(list.body.notifications.some((n: { messageId: string }) => n.messageId === message.id)).toBe(
        false,
      );
    } finally {
      await member.agent.patch(`/api/v1/channels/${fixture.channel.id}/members/me`).send({ mutedUntil: null });
    }
  });

  it("mark read / mark all read: unread count decrements and reaches zero", async () => {
    const message = await sendMention();
    await notificationFanoutHandler({ messageId: message.id });

    const before = await member.agent.get("/api/v1/notifications/unread-count");
    expect(before.body.count).toBeGreaterThan(0);

    const markAll = await member.agent.post("/api/v1/notifications/read-all");
    expect(markAll.status).toBe(204);

    const after = await member.agent.get("/api/v1/notifications/unread-count");
    expect(after.body.count).toBe(0);
  });

  it("marking a specific notification read requires ownership — another user's id 404s, never 403", async () => {
    const message = await sendMention();
    await notificationFanoutHandler({ messageId: message.id });

    const memberList = await member.agent.get("/api/v1/notifications");
    const notificationId = memberList.body.notifications.find(
      (n: { messageId: string }) => n.messageId === message.id,
    ).id as string;

    const hijack = await fixture.owner.agent.post(`/api/v1/notifications/${notificationId}/read`);
    expect(hijack.status).toBe(404);
  });
});
