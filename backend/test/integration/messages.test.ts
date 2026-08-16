import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { makeTestApp } from "../helpers/testApp.js";
import { createChannelFixture } from "../helpers/channelFixture.js";
import { signUpTestUser } from "../helpers/authFixture.js";
import { isAuthServiceReachable, isDatabaseReachable } from "../helpers/db.js";

const dbUp = await isDatabaseReachable(process.env.DATABASE_URL!);
const authUp = await isAuthServiceReachable(process.env.SUPABASE_URL!, process.env.SUPABASE_ANON_KEY!);
const liveStackAvailable = dbUp && authUp;

describe.skipIf(!liveStackAvailable)("messages (integration, live Supabase)", () => {
  const app = makeTestApp();
  const adminPool = new Pool({ connectionString: process.env.DATABASE_URL! });

  afterAll(async () => {
    await adminPool.end();
  });

  async function currentSeq(channelId: string): Promise<number> {
    const { rows } = await adminPool.query<{ last_message_seq: number }>(
      "select last_message_seq from channels where id = $1",
      [channelId],
    );
    return rows[0]?.last_message_seq ?? 0;
  }

  it("idempotency: retrying the same clientMsgId never creates a second message", async () => {
    const fixture = await createChannelFixture(app);
    const clientMsgId = randomUUID();

    const first = await fixture.owner.agent
      .post(`/api/v1/channels/${fixture.channel.id}/messages`)
      .send({ body: "hello", clientMsgId });
    expect(first.status).toBe(201);

    const second = await fixture.owner.agent
      .post(`/api/v1/channels/${fixture.channel.id}/messages`)
      .send({ body: "hello", clientMsgId });
    expect(second.status).toBe(201);
    expect(second.body.id).toBe(first.body.id);
    expect(second.body.seq).toBe(first.body.seq);
  });

  it(
    "ordering: 100 concurrent sends from the same member produce 100 unique, gapless sequence numbers " +
      "(docs/implementation-roadmap.md Phase 3 DoD)",
    async () => {
      const fixture = await createChannelFixture(app);
      const startingSeq = await currentSeq(fixture.channel.id);

      const results = await Promise.all(
        Array.from({ length: 100 }, () =>
          fixture.owner.agent
            .post(`/api/v1/channels/${fixture.channel.id}/messages`)
            .send({ body: "concurrent", clientMsgId: randomUUID() }),
        ),
      );

      expect(results.every((r) => r.status === 201)).toBe(true);
      const seqs = results.map((r) => r.body.seq as number).sort((a, b) => a - b);
      const expected = Array.from({ length: 100 }, (_, i) => startingSeq + 1 + i);
      expect(seqs).toEqual(expected);
    },
    20_000,
  );

  it(
    "sequence rollback: a failed insert (FK violation on threadRootId) does not burn a seq " +
      "(docs/implementation-roadmap.md Phase 3 DoD — the Postgres-specific improvement)",
    async () => {
      const fixture = await createChannelFixture(app);
      const before = await currentSeq(fixture.channel.id);

      const res = await fixture.owner.agent
        .post(`/api/v1/channels/${fixture.channel.id}/messages`)
        .send({
          body: "doomed",
          clientMsgId: randomUUID(),
          threadRootId: "00000000-0000-4000-8000-000000000000", // no such message
        });
      expect(res.status).toBe(500); // an FK violation is not a modeled AppError case

      const after = await currentSeq(fixture.channel.id);
      expect(after).toBe(before);
    },
  );

  it("cursor pagination: loads a bounded page and paginates backward with no overlap or gaps", async () => {
    const fixture = await createChannelFixture(app);
    for (let i = 0; i < 12; i++) {
      await fixture.owner.agent
        .post(`/api/v1/channels/${fixture.channel.id}/messages`)
        .send({ body: `msg-${i}`, clientMsgId: randomUUID() });
    }

    const firstPage = await fixture.owner.agent
      .get(`/api/v1/channels/${fixture.channel.id}/messages`)
      .query({ limit: 5 });
    expect(firstPage.status).toBe(200);
    expect(firstPage.body.messages).toHaveLength(5);
    expect(firstPage.body.hasMore).toBe(true);
    const firstSeqs = firstPage.body.messages.map((m: { seq: number }) => m.seq);
    expect(firstSeqs).toEqual([...firstSeqs].sort((a, b) => b - a)); // newest first

    const oldestOnFirstPage = firstSeqs[firstSeqs.length - 1] as number;
    const secondPage = await fixture.owner.agent
      .get(`/api/v1/channels/${fixture.channel.id}/messages`)
      .query({ limit: 5, before: oldestOnFirstPage });
    expect(secondPage.status).toBe(200);
    const secondSeqs = secondPage.body.messages.map((m: { seq: number }) => m.seq);

    expect(secondSeqs.every((s: number) => s < oldestOnFirstPage)).toBe(true);
    expect(new Set([...firstSeqs, ...secondSeqs]).size).toBe(firstSeqs.length + secondSeqs.length);
  });

  it("edit: only the author or a workspace admin may edit, never an unrelated member", async () => {
    const fixture = await createChannelFixture(app);
    const msg = await fixture.owner.agent
      .post(`/api/v1/channels/${fixture.channel.id}/messages`)
      .send({ body: "original", clientMsgId: randomUUID() });

    const author = await fixture.owner.agent
      .patch(`/api/v1/channels/${fixture.channel.id}/messages/${msg.body.id}`)
      .send({ body: "edited by author" });
    expect(author.status).toBe(200);
    expect(author.body.editedAt).not.toBeNull();

    const other = await signUpTestUser(app);
    const inviteRes = await fixture.owner.agent
      .post(`/api/v1/workspaces/${fixture.workspace.id}/invites`)
      .send({ role: "MEMBER" });
    await other.agent.post(`/api/v1/invites/${inviteRes.body.token}/accept`);
    await other.agent.post(`/api/v1/channels/${fixture.channel.id}/join`);

    const forbidden = await other.agent
      .patch(`/api/v1/channels/${fixture.channel.id}/messages/${msg.body.id}`)
      .send({ body: "hijacked" });
    expect(forbidden.status).toBe(403);
  });

  it("soft delete: a deleted message's body is cleared but it stays out of scrollback", async () => {
    const fixture = await createChannelFixture(app);
    const msg = await fixture.owner.agent
      .post(`/api/v1/channels/${fixture.channel.id}/messages`)
      .send({ body: "to be deleted", clientMsgId: randomUUID() });

    const del = await fixture.owner.agent.delete(
      `/api/v1/channels/${fixture.channel.id}/messages/${msg.body.id}`,
    );
    expect(del.status).toBe(204);

    const page = await fixture.owner.agent.get(`/api/v1/channels/${fixture.channel.id}/messages`);
    expect(page.body.messages.some((m: { id: string }) => m.id === msg.body.id)).toBe(false);
  });

  it("threads: a reply increments the root message's reply_count and surfaces via the thread endpoint", async () => {
    const fixture = await createChannelFixture(app);
    const root = await fixture.owner.agent
      .post(`/api/v1/channels/${fixture.channel.id}/messages`)
      .send({ body: "root", clientMsgId: randomUUID() });

    await fixture.owner.agent
      .post(`/api/v1/channels/${fixture.channel.id}/messages`)
      .send({ body: "reply 1", clientMsgId: randomUUID(), threadRootId: root.body.id });
    await fixture.owner.agent
      .post(`/api/v1/channels/${fixture.channel.id}/messages`)
      .send({ body: "reply 2", clientMsgId: randomUUID(), threadRootId: root.body.id });

    const thread = await fixture.owner.agent.get(
      `/api/v1/channels/${fixture.channel.id}/messages/${root.body.id}/thread`,
    );
    expect(thread.status).toBe(200);
    expect(thread.body).toHaveLength(2);

    const mainPage = await fixture.owner.agent.get(`/api/v1/channels/${fixture.channel.id}/messages`);
    expect(mainPage.body.messages.some((m: { id: string }) => m.id === root.body.id)).toBe(true);
    const rootInMain = mainPage.body.messages.find((m: { id: string }) => m.id === root.body.id);
    expect(rootInMain.replyCount).toBe(2);
    // replies never appear in the main scrollback, only the thread panel
    expect(mainPage.body.messages.some((m: { threadRootId: string }) => m.threadRootId)).toBe(false);
  });

  it("reactions: toggling is idempotent — add, add again (removes), add again (adds)", async () => {
    const fixture = await createChannelFixture(app);
    const msg = await fixture.owner.agent
      .post(`/api/v1/channels/${fixture.channel.id}/messages`)
      .send({ body: "react to me", clientMsgId: randomUUID() });

    const add1 = await fixture.owner.agent
      .post(`/api/v1/channels/${fixture.channel.id}/messages/${msg.body.id}/reactions`)
      .send({ emoji: "🎉" });
    expect(add1.body).toEqual({ emoji: "🎉", count: 1, added: true });

    const remove = await fixture.owner.agent
      .post(`/api/v1/channels/${fixture.channel.id}/messages/${msg.body.id}/reactions`)
      .send({ emoji: "🎉" });
    expect(remove.body).toEqual({ emoji: "🎉", count: 0, added: false });

    const add2 = await fixture.owner.agent
      .post(`/api/v1/channels/${fixture.channel.id}/messages/${msg.body.id}/reactions`)
      .send({ emoji: "🎉" });
    expect(add2.body).toEqual({ emoji: "🎉", count: 1, added: true });
  });

  it("reaction summaries on the message list carry a per-viewer `me` flag", async () => {
    const fixture = await createChannelFixture(app, "PUBLIC");
    const other = await signUpTestUser(app);
    const inviteRes = await fixture.owner.agent
      .post(`/api/v1/workspaces/${fixture.workspace.id}/invites`)
      .send({ role: "MEMBER" });
    await other.agent.post(`/api/v1/invites/${inviteRes.body.token}/accept`);
    await other.agent.post(`/api/v1/channels/${fixture.channel.id}/join`);

    const msg = await fixture.owner.agent
      .post(`/api/v1/channels/${fixture.channel.id}/messages`)
      .send({ body: "react to me too", clientMsgId: randomUUID() });
    await fixture.owner.agent
      .post(`/api/v1/channels/${fixture.channel.id}/messages/${msg.body.id}/reactions`)
      .send({ emoji: "🔥" });

    const ownerView = await fixture.owner.agent.get(`/api/v1/channels/${fixture.channel.id}/messages`);
    const ownerReaction = ownerView.body.messages.find((m: { id: string }) => m.id === msg.body.id)
      .reactions[0];
    expect(ownerReaction).toEqual({ emoji: "🔥", count: 1, me: true });

    const otherView = await other.agent.get(`/api/v1/channels/${fixture.channel.id}/messages`);
    const otherReaction = otherView.body.messages.find((m: { id: string }) => m.id === msg.body.id)
      .reactions[0];
    expect(otherReaction).toEqual({ emoji: "🔥", count: 1, me: false });
  });

  it("mentions: recorded and channel.read watermark moves forward idempotently", async () => {
    const fixture = await createChannelFixture(app);
    const other = await signUpTestUser(app);
    const inviteRes = await fixture.owner.agent
      .post(`/api/v1/workspaces/${fixture.workspace.id}/invites`)
      .send({ role: "MEMBER" });
    await other.agent.post(`/api/v1/invites/${inviteRes.body.token}/accept`);
    await other.agent.post(`/api/v1/channels/${fixture.channel.id}/join`);

    const msg = await fixture.owner.agent
      .post(`/api/v1/channels/${fixture.channel.id}/messages`)
      .send({ body: "hey @you", clientMsgId: randomUUID(), mentionedUserIds: [other.id] });
    expect(msg.status).toBe(201);

    const read1 = await other.agent
      .post(`/api/v1/channels/${fixture.channel.id}/read`)
      .send({ seq: msg.body.seq });
    expect(read1.body.lastReadSeq).toBe(msg.body.seq);

    // greatest() semantics: a stale/out-of-order mark-read never moves the
    // watermark backwards (docs/database-design.md §8).
    const read2 = await other.agent
      .post(`/api/v1/channels/${fixture.channel.id}/read`)
      .send({ seq: msg.body.seq - 1 });
    expect(read2.body.lastReadSeq).toBe(msg.body.seq);
  });
});
