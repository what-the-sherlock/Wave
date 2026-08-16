import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { io as ioClient, type Socket as ClientSocket } from "socket.io-client";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { buildServer, type ServerHandle } from "../../src/server.js";
import { createChannelFixture, type ChannelFixture } from "../helpers/channelFixture.js";
import { isAuthServiceReachable, isDatabaseReachable } from "../helpers/db.js";

const dbUp = await isDatabaseReachable(process.env.DATABASE_URL!);
const authUp = await isAuthServiceReachable(process.env.SUPABASE_URL!, process.env.SUPABASE_ANON_KEY!);
const liveStackAvailable = dbUp && authUp;

type Ack = { ok: boolean; code?: string; [key: string]: unknown };

function connectSocket(baseUrl: string, accessToken: string): ClientSocket {
  return ioClient(baseUrl, {
    reconnection: false,
    extraHeaders: { Cookie: `sb-access=${accessToken}` },
  });
}

async function waitForConnect(socket: ClientSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once("connect", () => resolve());
    socket.once("connect_error", reject);
  });
}

async function joinAndOpenChannel(socket: ClientSocket, fixture: ChannelFixture): Promise<void> {
  await socket.timeout(3000).emitWithAck("workspace.join", { workspaceId: fixture.workspace.id });
}

describe.skipIf(!liveStackAvailable)("Phase 4 production real-time behaviour (integration, live Supabase)", () => {
  let handle: ServerHandle;
  let baseUrl: string;
  const openSockets: ClientSocket[] = [];

  beforeAll(async () => {
    handle = await buildServer();
    await new Promise<void>((resolve) => handle.httpServer.listen(0, resolve));
    const { port } = handle.httpServer.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(() => {
    for (const s of openSockets.splice(0)) s.disconnect();
  });

  afterAll(async () => {
    await handle.close();
  });

  function connect(accessToken: string): ClientSocket {
    const socket = connectSocket(baseUrl, accessToken);
    openSockets.push(socket);
    return socket;
  }

  describe("typing indicators", () => {
    it("typing.start broadcasts the current set of typers to the channel room", async () => {
      const fixture = await createChannelFixture(handle.app, "PUBLIC");
      const socket = connect(fixture.owner.accessToken);
      await waitForConnect(socket);
      await joinAndOpenChannel(socket, fixture);

      const typingUpdate = new Promise<{ channelId: string; userIds: string[] }>((resolve) => {
        socket.once("typing.updated", resolve);
      });
      socket.emit("typing.start", { channelId: fixture.channel.id });

      const payload = await Promise.race([
        typingUpdate,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("typing.updated not received within 2s")), 2000),
        ),
      ]);
      expect(payload.channelId).toBe(fixture.channel.id);
      expect(payload.userIds).toEqual([fixture.owner.id]);
    });

    it("rate-limits typing.start to 1 per 3s per channel — a second rapid call broadcasts nothing new", async () => {
      const fixture = await createChannelFixture(handle.app, "PUBLIC");
      const socket = connect(fixture.owner.accessToken);
      await waitForConnect(socket);
      await joinAndOpenChannel(socket, fixture);

      let updates = 0;
      socket.on("typing.updated", () => {
        updates += 1;
      });

      socket.emit("typing.start", { channelId: fixture.channel.id });
      socket.emit("typing.start", { channelId: fixture.channel.id });
      await new Promise((resolve) => setTimeout(resolve, 500));

      expect(updates).toBe(1);
    });
  });

  describe("read receipts", () => {
    it("channel.read over the socket acks {ok, unread} and the caller's other device gets channel.read.updated", async () => {
      const fixture = await createChannelFixture(handle.app, "PUBLIC");
      const sendRes = await fixture.owner.agent
        .post(`/api/v1/channels/${fixture.channel.id}/messages`)
        .send({ body: "hello", clientMsgId: randomUUID() });
      const seq = sendRes.body.seq as number;

      const deviceA = connect(fixture.owner.accessToken);
      const deviceB = connect(fixture.owner.accessToken);
      await Promise.all([waitForConnect(deviceA), waitForConnect(deviceB)]);
      await Promise.all([
        joinAndOpenChannel(deviceA, fixture),
        joinAndOpenChannel(deviceB, fixture),
      ]);

      const crossDeviceSync = new Promise<{ channelId: string; lastReadSeq: number; unread: number }>(
        (resolve) => {
          deviceB.once("channel.read.updated", resolve);
        },
      );

      const ack = (await deviceA
        .timeout(3000)
        .emitWithAck("channel.read", { channelId: fixture.channel.id, seq })) as Ack;
      expect(ack.ok).toBe(true);
      expect(ack.unread).toBe(0);

      const synced = await Promise.race([
        crossDeviceSync,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("channel.read.updated not received within 3s")), 3000),
        ),
      ]);
      expect(synced.channelId).toBe(fixture.channel.id);
      expect(synced.lastReadSeq).toBe(seq);
      expect(synced.unread).toBe(0);
    });

    it("rate-limits channel.read to 10 per 10s per channel", async () => {
      const fixture = await createChannelFixture(handle.app, "PUBLIC");
      const socket = connect(fixture.owner.accessToken);
      await waitForConnect(socket);
      await joinAndOpenChannel(socket, fixture);

      const acks: Ack[] = [];
      for (let i = 0; i < 11; i++) {
        acks.push(
          (await socket
            .timeout(3000)
            .emitWithAck("channel.read", { channelId: fixture.channel.id, seq: 0 })) as Ack,
        );
      }

      expect(acks.slice(0, 10).every((a) => a.ok)).toBe(true);
      expect(acks[10]!.ok).toBe(false);
      expect(acks[10]!.code).toBe("RATE_LIMITED");
    });
  });

  describe("reconnect gap replay", () => {
    it("GET /channels/:id/messages?after= returns only messages newer than the cursor, ascending", async () => {
      const fixture = await createChannelFixture(handle.app, "PUBLIC");
      const seqs: number[] = [];
      for (let i = 0; i < 4; i++) {
        const res = await fixture.owner.agent
          .post(`/api/v1/channels/${fixture.channel.id}/messages`)
          .send({ body: `m${i}`, clientMsgId: randomUUID() });
        seqs.push(res.body.seq as number);
      }

      const cursor = seqs[1]!; // pretend the client last saw the second message
      const replay = await fixture.owner.agent
        .get(`/api/v1/channels/${fixture.channel.id}/messages`)
        .query({ after: cursor });

      expect(replay.status).toBe(200);
      expect(replay.body.messages.map((m: { seq: number }) => m.seq)).toEqual(seqs.slice(2));
      expect(replay.body.hasMore).toBe(false);
    });

    it("rejects a query supplying both before and after", async () => {
      const fixture = await createChannelFixture(handle.app, "PUBLIC");
      const res = await fixture.owner.agent
        .get(`/api/v1/channels/${fixture.channel.id}/messages`)
        .query({ before: 5, after: 1 });
      expect(res.status).toBe(400);
    });
  });

  describe("socket rate limiting and connection caps", () => {
    it("rate-limits workspace.join to 10 per minute per socket", async () => {
      const fixture = await createChannelFixture(handle.app, "PUBLIC");
      const socket = connect(fixture.owner.accessToken);
      await waitForConnect(socket);

      const acks: Ack[] = [];
      for (let i = 0; i < 11; i++) {
        acks.push(
          (await socket
            .timeout(3000)
            .emitWithAck("workspace.join", { workspaceId: fixture.workspace.id })) as Ack,
        );
      }

      expect(acks.slice(0, 10).every((a) => a.ok)).toBe(true);
      expect(acks[10]!.ok).toBe(false);
      expect(acks[10]!.code).toBe("RATE_LIMITED");
    });

    it("the 11th concurrent socket for one user evicts the oldest", async () => {
      const fixture = await createChannelFixture(handle.app, "PUBLIC");
      const sockets: ClientSocket[] = [];
      for (let i = 0; i < 10; i++) {
        const s = connect(fixture.owner.accessToken);
        await waitForConnect(s);
        sockets.push(s);
      }

      const oldest = sockets[0]!;
      const oldestDisconnected = new Promise<void>((resolve) => {
        oldest.once("disconnect", () => resolve());
      });

      const eleventh = connect(fixture.owner.accessToken);
      await waitForConnect(eleventh);

      await Promise.race([
        oldestDisconnected,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("oldest socket was not evicted within 2s")), 2000),
        ),
      ]);
      expect(oldest.connected).toBe(false);
      expect(eleventh.connected).toBe(true);
    });
  });
});
