import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { io as ioClient, type Socket as ClientSocket } from "socket.io-client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer, type ServerHandle } from "../../src/server.js";
import { createChannelFixture, type ChannelFixture } from "../helpers/channelFixture.js";
import { signUpTestUser, type SignedUpUser } from "../helpers/authFixture.js";
import { isAuthServiceReachable, isDatabaseReachable } from "../helpers/db.js";

const dbUp = await isDatabaseReachable(process.env.DATABASE_URL!);
const authUp = await isAuthServiceReachable(process.env.SUPABASE_URL!, process.env.SUPABASE_ANON_KEY!);
const liveStackAvailable = dbUp && authUp;

function connectSocket(baseUrl: string, accessToken: string): ClientSocket {
  return ioClient(baseUrl, {
    reconnection: false,
    extraHeaders: { Cookie: `sb-access=${accessToken}` },
  });
}

describe.skipIf(!liveStackAvailable)("realtime message delivery (integration, live Supabase)", () => {
  let handle: ServerHandle;
  let baseUrl: string;

  beforeAll(async () => {
    handle = await buildServer();
    await new Promise<void>((resolve) => handle.httpServer.listen(0, resolve));
    const { port } = handle.httpServer.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await handle.close();
  });

  it(
    "a member who joins a public channel via HTTP receives a subsequent message.created " +
      "over their already-open socket, with no reconnect — the exact frontend flow " +
      "(auto-join on first channel visit, then live delivery)",
    async () => {
      const fixture: ChannelFixture = await createChannelFixture(handle.app, "PUBLIC");
      const member: SignedUpUser = await signUpTestUser(handle.app);
      const inviteRes = await fixture.owner.agent
        .post(`/api/v1/workspaces/${fixture.workspace.id}/invites`)
        .send({ role: "MEMBER" });
      await member.agent.post(`/api/v1/invites/${inviteRes.body.token}/accept`);

      const socket = connectSocket(baseUrl, member.accessToken);
      try {
        await new Promise<void>((resolve, reject) => {
          socket.once("connect", () => resolve());
          socket.once("connect_error", reject);
        });

        const joinAck = await socket
          .timeout(3000)
          .emitWithAck("workspace.join", { workspaceId: fixture.workspace.id });
        expect(joinAck.ok).toBe(true);
        // Not a member of the channel yet — matches the frontend's state
        // right after landing on a public channel it hasn't joined.
        expect(joinAck.channels).toEqual([]);

        // The exact call the frontend's auto-join makes.
        const httpJoin = await member.agent.post(`/api/v1/channels/${fixture.channel.id}/join`);
        expect(httpJoin.status).toBe(204);

        const messageEvent = new Promise<{ body: string }>((resolve) => {
          socket.once("message.created", resolve);
        });

        const marker = `live-${randomUUID()}`;
        const sendRes = await fixture.owner.agent
          .post(`/api/v1/channels/${fixture.channel.id}/messages`)
          .send({ body: marker, clientMsgId: randomUUID() });
        expect(sendRes.status).toBe(201);

        const received = await Promise.race([
          messageEvent,
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("message.created not received within 3s")), 3000),
          ),
        ]);
        expect(received.body).toBe(marker);
      } finally {
        socket.disconnect();
      }
    },
  );
});
