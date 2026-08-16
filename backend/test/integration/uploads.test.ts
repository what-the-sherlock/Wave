import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeTestApp } from "../helpers/testApp.js";
import { createChannelFixture, type ChannelFixture } from "../helpers/channelFixture.js";
import { signUpTestUser, type SignedUpUser } from "../helpers/authFixture.js";
import { isAuthServiceReachable, isDatabaseReachable } from "../helpers/db.js";
import { attachmentProcessHandler } from "../../src/queue/workers/attachmentProcess.worker.js";

const dbUp = await isDatabaseReachable(process.env.DATABASE_URL!);
const authUp = await isAuthServiceReachable(process.env.SUPABASE_URL!, process.env.SUPABASE_ANON_KEY!);
const liveStackAvailable = dbUp && authUp;

describe.skipIf(!liveStackAvailable)("uploads (integration, live Supabase)", () => {
  const app = makeTestApp();
  const adminPool = new Pool({ connectionString: process.env.DATABASE_URL! });
  // Shared across every test that doesn't specifically need a second
  // workspace/user — this budget-conscious sandbox's local Supabase Auth
  // signup allowance is small, so fixtures are reused wherever the test's
  // own point doesn't require isolation.
  let fixture: ChannelFixture;
  let outsider: SignedUpUser;

  beforeAll(async () => {
    fixture = await createChannelFixture(app, "PRIVATE");
    outsider = await signUpTestUser(app);
  });

  afterAll(async () => {
    await adminPool.end();
  });

  async function presign(
    channelFixture: ChannelFixture,
    body: Partial<{ channelId: string; filename: string; mimeType: string; size: number }> = {},
  ) {
    return channelFixture.owner.agent.post("/api/v1/uploads/presign").send({
      channelId: channelFixture.channel.id,
      filename: "test.png",
      mimeType: "image/png",
      size: 1024,
      ...body,
    });
  }

  it("presigns a path scoped to the caller's own workspace/channel", async () => {
    const res = await presign(fixture);
    expect(res.status).toBe(201);
    expect(res.body.storagePath.startsWith(`${fixture.workspace.id}/${fixture.channel.id}/`)).toBe(true);
    expect(typeof res.body.uploadUrl).toBe("string");
  });

  it("presign against a channel the caller isn't a member of is rejected", async () => {
    const res = await outsider.agent
      .post("/api/v1/uploads/presign")
      .send({ channelId: fixture.channel.id, filename: "x.png", mimeType: "image/png", size: 100 });
    expect([403, 404]).toContain(res.status);
  });

  it("rejects a file over the size cap before ever touching Storage", async () => {
    const res = await presign(fixture, { size: 100 * 1024 * 1024 });
    expect(res.status).toBe(400);
  });

  it("rejects a disallowed MIME type at presign time", async () => {
    const res = await presign(fixture, { mimeType: "application/x-msdownload" });
    expect(res.status).toBe(400);
  });

  it(
    "MIME spoofing: content that doesn't match the declared type is deleted by attachment.process, " +
      "not silently trusted",
    async () => {
      const res = await presign(fixture, { mimeType: "image/png", filename: "fake.png" });
      expect(res.status).toBe(201);

      // Upload plain-text bytes under a claimed image/png MIME type.
      const uploadRes = await fetch(res.body.uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": "image/png" },
        body: "this is not a png, it is plain text pretending to be one",
      });
      expect(uploadRes.ok).toBe(true);

      await attachmentProcessHandler({ attachmentId: res.body.attachmentId });

      const { rows } = await adminPool.query("select 1 from message_attachments where id = $1", [
        res.body.attachmentId,
      ]);
      expect(rows).toHaveLength(0);
    },
  );

  it("a valid image survives attachment.process and gets a thumbnail", async () => {
    const res = await presign(fixture, { mimeType: "image/png", filename: "real.png" });

    // A genuinely sharp-decodable 4x4 PNG — generated via sharp itself
    // rather than hand-crafted bytes, since a hand-minimized PNG can pass
    // header-only metadata parsing while still failing a real pixel decode
    // (exactly the "malformed image" case attachment.process degrades
    // gracefully for, which is not what this test is checking).
    const pngBytes = await sharp({
      create: { width: 4, height: 4, channels: 3, background: { r: 255, g: 0, b: 0 } },
    })
      .png()
      .toBuffer();

    const uploadRes = await fetch(res.body.uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": "image/png" },
      body: pngBytes,
    });
    expect(uploadRes.ok).toBe(true);

    await attachmentProcessHandler({ attachmentId: res.body.attachmentId });

    const { rows } = await adminPool.query<{ thumb_path: string | null; width: number | null }>(
      "select thumb_path, width from message_attachments where id = $1",
      [res.body.attachmentId],
    );
    expect(rows[0]?.thumb_path).not.toBeNull();
    expect(rows[0]?.width).toBe(4);
  });

  it("more than 4 attachments on one message is rejected at the schema layer", async () => {
    const ids = Array.from({ length: 5 }, () => randomUUID());
    const send = await fixture.owner.agent
      .post(`/api/v1/channels/${fixture.channel.id}/messages`)
      .send({ body: "too many", clientMsgId: randomUUID(), attachmentIds: ids });
    expect(send.status).toBe(400);
  });

  it("an attachment-only message (empty body) is accepted", async () => {
    const res = await presign(fixture);
    const uploadRes = await fetch(res.body.uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": "image/png" },
      body: "irrelevant bytes for this test",
    });
    expect(uploadRes.ok).toBe(true);

    const send = await fixture.owner.agent
      .post(`/api/v1/channels/${fixture.channel.id}/messages`)
      .send({ body: "", clientMsgId: randomUUID(), attachmentIds: [res.body.attachmentId] });
    expect(send.status).toBe(201);
    expect(send.body.attachments).toHaveLength(1);
  });

  it("download-url requires channel membership — RLS-backed, so a non-member gets 404", async () => {
    const res = await presign(fixture);
    const download = await outsider.agent.get(`/api/v1/uploads/${res.body.attachmentId}/download-url`);
    expect(download.status).toBe(404);
  });

  it("a path/attachment from another channel cannot be attached to this message — 400, not silently accepted", async () => {
    const fixtureB = await createChannelFixture(app);

    const presignInB = await presign(fixtureB);
    expect(presignInB.status).toBe(201);

    const send = await fixture.owner.agent
      .post(`/api/v1/channels/${fixture.channel.id}/messages`)
      .send({
        body: "sneaky",
        clientMsgId: randomUUID(),
        attachmentIds: [presignInB.body.attachmentId],
      });
    expect(send.status).toBe(400);
  });
});
