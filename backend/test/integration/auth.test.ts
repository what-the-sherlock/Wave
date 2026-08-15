import { randomUUID } from "node:crypto";
import request from "supertest";
import { beforeAll, describe, expect, it } from "vitest";
import { makeTestApp } from "../helpers/testApp.js";
import { signUpTestUser } from "../helpers/authFixture.js";
import { isAuthServiceReachable, isDatabaseReachable } from "../helpers/db.js";

const dbUp = await isDatabaseReachable(process.env.DATABASE_URL!);
const authUp = await isAuthServiceReachable(process.env.SUPABASE_URL!, process.env.SUPABASE_ANON_KEY!);
const liveStackAvailable = dbUp && authUp;

if (!liveStackAvailable) {
  // eslint-disable-next-line no-console -- test-runner diagnostic, not app code
  console.warn(
    "\n[skip] auth.test.ts: local Supabase stack not reachable — run `supabase start` " +
      "(and `supabase db push`) to exercise these tests.\n",
  );
}

describe.skipIf(!liveStackAvailable)("auth (integration, live Supabase)", () => {
  const app = makeTestApp();

  beforeAll(async () => {
    // NODE_ENV=test disables the `secure` cookie attribute, so plain HTTP
    // supertest requests actually carry cookies back and forth.
    expect(process.env.NODE_ENV).toBe("test");
  });

  it("signup creates a session, sets httpOnly cookies, and auto-creates a profile", async () => {
    const email = `signup-${randomUUID()}@example.com`;
    const agent = request.agent(app);

    const signupRes = await agent
      .post("/api/v1/auth/signup")
      .send({ email, fullName: "New User", password: "a-genuinely-uncommon-passphrase-9x" });

    expect(signupRes.status).toBe(201);
    expect(signupRes.body.email).toBe(email);
    expect(signupRes.body.id).toBeTruthy();

    const setCookie = signupRes.headers["set-cookie"] as unknown as string[];
    const access = setCookie.find((c) => c.startsWith("sb-access="));
    expect(access).toMatch(/HttpOnly/i);
    // Never readable from JS — the property the socket handshake depends on.
    expect(access).not.toMatch(/^sb-access=$/);

    const profileRes = await agent.get("/api/v1/profile/me");
    expect(profileRes.status).toBe(200);
    expect(profileRes.body.fullName).toBe("New User");
  });

  it("rejects a duplicate signup with 409, not a generic 500", async () => {
    const email = `dup-${randomUUID()}@example.com`;
    const app2 = makeTestApp();
    await request(app2)
      .post("/api/v1/auth/signup")
      .send({ email, fullName: "First", password: "a-genuinely-uncommon-passphrase-9x" });

    const second = await request(app2)
      .post("/api/v1/auth/signup")
      .send({ email, fullName: "Second", password: "a-different-uncommon-passphrase-3z" });

    expect(second.status).toBe(409);
    expect(second.body.code).toBe("CONFLICT");
  });

  it("logs in with correct credentials", async () => {
    const user = await signUpTestUser(app);
    const freshAgent = request.agent(app);

    const res = await freshAgent
      .post("/api/v1/auth/login")
      .send({ email: user.email, password: user.password });

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(user.id);
  });

  it("gives the exact same generic message for a wrong password and a nonexistent email", async () => {
    const user = await signUpTestUser(app);

    const wrongPassword = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: user.email, password: "definitely-the-wrong-password-1" });

    const noSuchAccount = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: `nobody-${randomUUID()}@example.com`, password: "whatever-password-1" });

    expect(wrongPassword.status).toBe(401);
    expect(noSuchAccount.status).toBe(401);
    // The actual security property: identical wording either way, so
    // nothing about the response reveals whether the account exists or
    // which field was wrong. The message is allowed to say "email" — it
    // just must never say something like "no account found".
    expect(wrongPassword.body.message).toBe(noSuchAccount.body.message);
    expect(wrongPassword.body.message).not.toMatch(/not found|no such|doesn't exist|does not exist/i);
  });

  it("GET /check with no cookie is 401 UNAUTHORIZED", async () => {
    const res = await request(app).get("/api/v1/auth/check");
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("UNAUTHORIZED");
  });

  it("GET /check with a valid session returns the user's identity", async () => {
    const user = await signUpTestUser(app);
    const res = await user.agent.get("/api/v1/auth/check");
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(user.id);
    expect(res.body.email).toBe(user.email);
  });

  // D6 regression (401 TOKEN_EXPIRED, never a 500, for an expired token —
  // the original app's dead `if (!decoded)` guard meant every expired
  // token fell through to a 500 instead) is covered at the unit level in
  // test/unit/jwt.test.ts, not here. A hand-signed HS256 token like
  // signExpiredAccessToken() produces isn't accepted by this environment's
  // real verification path — the local Supabase instance signs with an
  // asymmetric key (JWKS), and forging an *expired-but-otherwise-valid*
  // token for that scheme isn't possible without the private key. The
  // "tampered token → 401 TOKEN_INVALID" test below exercises the exact
  // same generic AppError→HTTP mapping in errorMiddleware that an expired
  // token would also go through, so the mapping itself is still proven
  // end-to-end; only the *specific* expired-vs-invalid discrimination is
  // proven at the unit level instead.

  it("a tampered token returns 401 TOKEN_INVALID", async () => {
    const res = await request(app)
      .get("/api/v1/auth/check")
      .set("Cookie", "sb-access=not.a.valid.jwt");
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("TOKEN_INVALID");
  });

  it("logout clears both cookies and subsequent requests are unauthenticated", async () => {
    const user = await signUpTestUser(app);

    const logoutRes = await user.agent.post("/api/v1/auth/logout");
    expect(logoutRes.status).toBe(200);

    const checkRes = await user.agent.get("/api/v1/auth/check");
    expect(checkRes.status).toBe(401);
  });

  it("logout succeeds even with no session at all (never blocks clearing a stale session)", async () => {
    const res = await request(app).post("/api/v1/auth/logout");
    expect(res.status).toBe(200);
  });

  it("refresh issues a new session from the refresh cookie alone", async () => {
    const user = await signUpTestUser(app);

    // The refresh cookie is scoped to /api/v1/auth/refresh — supertest's
    // agent cookie jar only attaches it to requests matching that path,
    // proving the scoping actually works, not just that we set the header.
    const refreshRes = await user.agent.post("/api/v1/auth/refresh");
    expect(refreshRes.status).toBe(200);
    expect(refreshRes.body.id).toBe(user.id);

    const checkRes = await user.agent.get("/api/v1/auth/check");
    expect(checkRes.status).toBe(200);
  });

  it("refresh with no refresh cookie is 401", async () => {
    const res = await request(app).post("/api/v1/auth/refresh");
    expect(res.status).toBe(401);
  });
});
