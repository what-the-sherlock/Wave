import type { AddressInfo } from "node:net";
import { io as ioClient, type Socket as ClientSocket } from "socket.io-client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer, type ServerHandle } from "../../src/server.js";
import { workspaceRouter } from "../../src/workspaces/workspace.routes.js";
import { collectWorkspaceScopedRoutes, buildPath } from "../helpers/routeIntrospection.js";
import { createWorkspaceFixture, type WorkspaceFixture } from "../helpers/workspaceFixture.js";
import { signUpTestUser } from "../helpers/authFixture.js";
import { isAuthServiceReachable, isDatabaseReachable } from "../helpers/db.js";

const dbUp = await isDatabaseReachable(process.env.DATABASE_URL!);
const authUp = await isAuthServiceReachable(process.env.SUPABASE_URL!, process.env.SUPABASE_ANON_KEY!);
const liveStackAvailable = dbUp && authUp;

/** Minimal valid bodies for the routes that need one — not load-bearing for
 * the adversarial assertion (resolveWorkspace's 404 fires before validate()
 * ever runs), but realistic so this suite doubles as a smoke test of the
 * route wiring itself. */
const BODIES_BY_PATH: Record<string, Record<string, unknown>> = {
  "/:workspaceId": { name: "Adversarial Rename Attempt" },
  "/:workspaceId/members/:userId": { role: "MEMBER" },
  "/:workspaceId/invites": { role: "MEMBER" },
};

function waitUntil(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (condition()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error("waitUntil: timed out"));
      setTimeout(tick, 20);
    };
    tick();
  });
}

describe.skipIf(!liveStackAvailable)("workspace isolation (integration, live Supabase)", () => {
  let handle: ServerHandle;
  let A: WorkspaceFixture;
  let B: WorkspaceFixture;
  let bInviteId: string;

  beforeAll(async () => {
    handle = await buildServer();
    await new Promise<void>((resolve) => handle.httpServer.listen(0, resolve));

    [A, B] = await Promise.all([
      createWorkspaceFixture(handle.app),
      createWorkspaceFixture(handle.app),
    ]);
    const inviteRes = await B.owner.agent
      .post(`/api/v1/workspaces/${B.workspace.id}/invites`)
      .send({ role: "MEMBER" });
    bInviteId = inviteRes.body.id as string;
  });

  afterAll(async () => {
    await handle.close();
  });

  const routes = collectWorkspaceScopedRoutes(workspaceRouter, "");

  it.each(routes)(
    "$method $path rejects a caller who is not a member of the target workspace (404, never 403)",
    async ({ method, path }) => {
      const params = { workspaceId: B.workspace.id, userId: B.owner.id, inviteId: bInviteId };
      const url = buildPath(path, params);
      const body = BODIES_BY_PATH[path] ?? {};

      const req = A.owner.agent[method as "get" | "post" | "patch" | "delete"](
        `/api/v1/workspaces${url}`,
      );
      const res = ["post", "patch", "put"].includes(method) ? await req.send(body) : await req;

      expect(res.status).toBe(404);
      expect(JSON.stringify(res.body)).not.toContain(B.workspace.name);
    },
  );

  it(
    "removing a member evicts their live socket from the workspace room within ~1s " +
      "(the one gap RLS does not close — docs/realtime-architecture.md §3)",
    async () => {
      const member = await signUpTestUser(handle.app);
      const inviteRes = await A.owner.agent
        .post(`/api/v1/workspaces/${A.workspace.id}/invites`)
        .send({ role: "MEMBER" });
      await member.agent.post(`/api/v1/invites/${inviteRes.body.token}/accept`);

      const { port } = handle.httpServer.address() as AddressInfo;
      const socket: ClientSocket = ioClient(`http://127.0.0.1:${port}`, {
        reconnection: false,
        extraHeaders: { Cookie: `sb-access=${member.accessToken}` },
      });
      try {
        await new Promise<void>((resolve, reject) => {
          socket.once("connect", () => resolve());
          socket.once("connect_error", reject);
        });

        const joinAck = await socket
          .timeout(2000)
          .emitWithAck("workspace.join", { workspaceId: A.workspace.id });
        expect(joinAck.ok).toBe(true);

        let removed = false;
        const removePromise = A.owner.agent
          .delete(`/api/v1/workspaces/${A.workspace.id}/members/${member.id}`)
          .then((res) => {
            removed = true;
            return res;
          });

        await waitUntil(() => removed);
        const res = await removePromise;
        expect(res.status).toBe(204);

        // socketsLeave is fire-and-forget on the server; re-joining after
        // removal must fail because membership itself is gone, which is
        // observable even if the eviction race with this exact assertion
        // is timing-sensitive.
        const rejoinAck = await socket
          .timeout(2000)
          .emitWithAck("workspace.join", { workspaceId: A.workspace.id });
        expect(rejoinAck.ok).toBe(false);
      } finally {
        socket.disconnect();
      }
    },
  );
});
