import type { AddressInfo } from "node:net";
import type { Express } from "express";
import { io as ioClient, type Socket as ClientSocket } from "socket.io-client";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { buildServer, type ServerHandle } from "../../src/server.js";
import { createWorkspaceFixture, type WorkspaceFixture } from "../helpers/workspaceFixture.js";
import { signUpTestUser, type SignedUpUser } from "../helpers/authFixture.js";
import { isAuthServiceReachable, isDatabaseReachable } from "../helpers/db.js";

const dbUp = await isDatabaseReachable(process.env.DATABASE_URL!);
const authUp = await isAuthServiceReachable(process.env.SUPABASE_URL!, process.env.SUPABASE_ANON_KEY!);
const liveStackAvailable = dbUp && authUp;

type JoinAck = {
  ok: boolean;
  workspaceId: string;
  channels: unknown[];
  presence: { userId: string; status: string; lastSeenAt: number }[];
};

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

async function joinWorkspace(socket: ClientSocket, workspaceId: string): Promise<JoinAck> {
  return socket.timeout(3000).emitWithAck("workspace.join", { workspaceId }) as Promise<JoinAck>;
}

async function inviteMember(app: Express, fixture: WorkspaceFixture): Promise<SignedUpUser> {
  const member = await signUpTestUser(app);
  const inviteRes = await fixture.owner.agent
    .post(`/api/v1/workspaces/${fixture.workspace.id}/invites`)
    .send({ role: "MEMBER" });
  await member.agent.post(`/api/v1/invites/${inviteRes.body.token}/accept`);
  return member;
}

describe.skipIf(!liveStackAvailable)("presence broadcast (integration, live Supabase)", () => {
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

  it("workspace.join's ack roster includes the caller themselves, online", async () => {
    const fixture = await createWorkspaceFixture(handle.app);
    const socket = connect(fixture.owner.accessToken);
    await waitForConnect(socket);

    const ack = await joinWorkspace(socket, fixture.workspace.id);
    expect(ack.ok).toBe(true);
    expect(ack.presence).toContainEqual(
      expect.objectContaining({ userId: fixture.owner.id, status: "online" }),
    );
  });

  it("a member joining the workspace broadcasts presence.updated{online} to members already there", async () => {
    const fixture = await createWorkspaceFixture(handle.app);
    const member = await inviteMember(handle.app, fixture);

    const ownerSocket = connect(fixture.owner.accessToken);
    await waitForConnect(ownerSocket);
    await joinWorkspace(ownerSocket, fixture.workspace.id);

    const presenceUpdate = new Promise<{ userId: string; status: string }>((resolve) => {
      ownerSocket.on("presence.updated", (payload: { userId: string; status: string }) => {
        if (payload.userId === member.id) resolve(payload);
      });
    });

    const memberSocket = connect(member.accessToken);
    await waitForConnect(memberSocket);
    await joinWorkspace(memberSocket, fixture.workspace.id);

    const received = await Promise.race([
      presenceUpdate,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("presence.updated not received within 3s")), 3000),
      ),
    ]);
    expect(received.status).toBe("online");
  });

  it("the last socket of a user disconnecting broadcasts presence.updated{offline} to the workspace", async () => {
    const fixture = await createWorkspaceFixture(handle.app);
    const member = await inviteMember(handle.app, fixture);

    const ownerSocket = connect(fixture.owner.accessToken);
    await waitForConnect(ownerSocket);
    await joinWorkspace(ownerSocket, fixture.workspace.id);

    const memberSocket = connect(member.accessToken);
    await waitForConnect(memberSocket);
    await joinWorkspace(memberSocket, fixture.workspace.id);

    const offlineUpdate = new Promise<{ userId: string; status: string }>((resolve) => {
      ownerSocket.on("presence.updated", (payload: { userId: string; status: string }) => {
        if (payload.userId === member.id && payload.status === "offline") resolve(payload);
      });
    });

    memberSocket.disconnect();

    const received = await Promise.race([
      offlineUpdate,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("offline presence.updated not received within 3s")), 3000),
      ),
    ]);
    expect(received.status).toBe("offline");
  });

  it(
    "multi-device (D9): closing one of two tabs for the same member does not broadcast offline " +
      "— only the last tab closing does",
    async () => {
      const fixture = await createWorkspaceFixture(handle.app);
      const member = await inviteMember(handle.app, fixture);

      const ownerSocket = connect(fixture.owner.accessToken);
      await waitForConnect(ownerSocket);
      await joinWorkspace(ownerSocket, fixture.workspace.id);

      const memberTabA = connect(member.accessToken);
      const memberTabB = connect(member.accessToken);
      await Promise.all([waitForConnect(memberTabA), waitForConnect(memberTabB)]);
      await Promise.all([
        joinWorkspace(memberTabA, fixture.workspace.id),
        joinWorkspace(memberTabB, fixture.workspace.id),
      ]);

      let offlineEvents = 0;
      ownerSocket.on("presence.updated", (payload: { userId: string; status: string }) => {
        if (payload.userId === member.id && payload.status === "offline") offlineEvents += 1;
      });

      memberTabA.disconnect();
      // Give any (incorrect) offline broadcast time to arrive before asserting its absence.
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(offlineEvents).toBe(0);

      const offlineUpdate = new Promise<void>((resolve) => {
        ownerSocket.on("presence.updated", (payload: { userId: string; status: string }) => {
          if (payload.userId === member.id && payload.status === "offline") resolve();
        });
      });
      memberTabB.disconnect();
      await Promise.race([
        offlineUpdate,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("offline presence.updated not received within 3s")), 3000),
        ),
      ]);
    },
  );
});
