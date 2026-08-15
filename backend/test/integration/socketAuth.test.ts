import type { AddressInfo } from "node:net";
import { io as ioClient, type Socket as ClientSocket } from "socket.io-client";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { buildServer, type ServerHandle } from "../../src/server.js";
import { signUpTestUser } from "../helpers/authFixture.js";
import { isAuthServiceReachable, isDatabaseReachable } from "../helpers/db.js";

const dbUp = await isDatabaseReachable(process.env.DATABASE_URL!);
const authUp = await isAuthServiceReachable(process.env.SUPABASE_URL!, process.env.SUPABASE_ANON_KEY!);
const liveStackAvailable = dbUp && authUp;

if (!liveStackAvailable) {
  // eslint-disable-next-line no-console -- test-runner diagnostic, not app code
  console.warn(
    "\n[skip] socketAuth.test.ts: local Supabase stack not reachable — run `supabase start`.\n",
  );
}

function waitForConnect(socket: ClientSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once("connect", () => resolve());
    socket.once("connect_error", (err: Error) => reject(err));
  });
}

function waitForConnectError(socket: ClientSocket): Promise<Error> {
  return new Promise((resolve, reject) => {
    socket.once("connect", () => reject(new Error("expected connect_error but got connect")));
    socket.once("connect_error", (err: Error) => resolve(err));
  });
}

/** Polls rather than sleeping a fixed duration — presence updates land
 * asynchronously after a connect/disconnect, and a fixed delay is either
 * too slow (wasted time) or occasionally too fast (flaky) depending on
 * transport and machine load. */
async function waitUntil(condition: () => Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`waitUntil: condition not met within ${timeoutMs}ms`);
}

describe.skipIf(!liveStackAvailable)("Socket.IO handshake auth (D1 regression)", () => {
  let handle: ServerHandle;
  let baseUrl: string;
  const openSockets: ClientSocket[] = [];

  beforeAll(async () => {
    handle = buildServer();
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

  function connect(cookie: string | undefined, extraQuery?: Record<string, string>): ClientSocket {
    const socket = ioClient(baseUrl, {
      // Default transports (polling first, upgrading to websocket) rather
      // than forcing websocket-only: the initial polling handshake is a
      // plain HTTP request, which is the most reliable way for a Node
      // client to carry a custom Cookie header to the auth middleware.
      reconnection: false,
      extraHeaders: cookie ? { Cookie: cookie } : {},
      query: extraQuery,
    });
    openSockets.push(socket);
    return socket;
  }

  it("rejects a connection with no cookie at all", async () => {
    const socket = connect(undefined);
    const err = await waitForConnectError(socket);
    expect(err.message).toBe("UNAUTHORIZED");
  });

  it(
    "rejects a connection carrying only a forged handshake.query.userId " +
      "— the exact vulnerable pattern the original app trusted (D1)",
    async () => {
      const socket = connect(undefined, { userId: "11111111-1111-4111-8111-111111111111" });
      const err = await waitForConnectError(socket);
      expect(err.message).toBe("UNAUTHORIZED");
    },
  );

  it("rejects a connection with a garbage/tampered cookie value", async () => {
    const socket = connect("sb-access=not-a-real-jwt");
    const err = await waitForConnectError(socket);
    expect(err.message).toBe("UNAUTHORIZED");
  });

  it("accepts a connection with a valid sb-access cookie and registers presence under the real user id", async () => {
    const user = await signUpTestUser(handle.app);

    const socket = connect(`sb-access=${user.accessToken}`);
    await waitForConnect(socket);

    await waitUntil(() => handle.presenceStore.isOnline(user.id));
  });

  it(
    "THE decisive case: a valid cookie for user A plus a forged query.userId " +
      "claiming to be user B results in the connection being identified as A, never B",
    async () => {
      const userA = await signUpTestUser(handle.app);
      const forgedVictimId = "99999999-9999-4999-8999-999999999999";

      const socket = connect(`sb-access=${userA.accessToken}`, { userId: forgedVictimId });
      await waitForConnect(socket);
      await waitUntil(() => handle.presenceStore.isOnline(userA.id));

      expect(await handle.presenceStore.isOnline(forgedVictimId)).toBe(false);
    },
  );

  it(
    "a token this server cannot validate (expired, or — as here, signed for a " +
      "different verification scheme than this environment uses) is rejected at " +
      "the socket handshake exactly like at the HTTP layer",
    async () => {
      const { signExpiredAccessToken } = await import("../helpers/jwt.js");
      const expired = await signExpiredAccessToken("11111111-1111-4111-8111-111111111111");
      const socket = connect(`sb-access=${expired}`);
      const err = await waitForConnectError(socket);
      expect(err.message).toBe("UNAUTHORIZED");
    },
  );

  it("disconnecting removes the user from presence", async () => {
    const user = await signUpTestUser(handle.app);
    const socket = connect(`sb-access=${user.accessToken}`);
    await waitForConnect(socket);
    await waitUntil(() => handle.presenceStore.isOnline(user.id));

    socket.disconnect();
    await waitUntil(async () => !(await handle.presenceStore.isOnline(user.id)));
  });
});
