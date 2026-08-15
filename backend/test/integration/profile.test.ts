import { describe, expect, it } from "vitest";
import request from "supertest";
import { makeTestApp } from "../helpers/testApp.js";
import { signUpTestUser } from "../helpers/authFixture.js";
import { isAuthServiceReachable, isDatabaseReachable } from "../helpers/db.js";

const dbUp = await isDatabaseReachable(process.env.DATABASE_URL!);
const authUp = await isAuthServiceReachable(process.env.SUPABASE_URL!, process.env.SUPABASE_ANON_KEY!);
const liveStackAvailable = dbUp && authUp;

describe.skipIf(!liveStackAvailable)("profile (integration, live Supabase)", () => {
  const app = makeTestApp();

  it("GET /me returns the profile the handle_new_user trigger created at signup", async () => {
    const user = await signUpTestUser(app, { fullName: "Grace Hopper" });
    const res = await user.agent.get("/api/v1/profile/me");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      id: user.id,
      fullName: "Grace Hopper",
      avatarUrl: null,
      timezone: "UTC",
    });
  });

  it("PUT /me updates fullName", async () => {
    const user = await signUpTestUser(app);
    const res = await user.agent.put("/api/v1/profile/me").send({ fullName: "Ada Lovelace" });
    expect(res.status).toBe(200);
    expect(res.body.fullName).toBe("Ada Lovelace");

    const getRes = await user.agent.get("/api/v1/profile/me");
    expect(getRes.body.fullName).toBe("Ada Lovelace");
  });

  it("PUT /me updates timezone", async () => {
    const user = await signUpTestUser(app);
    const res = await user.agent.put("/api/v1/profile/me").send({ timezone: "America/New_York" });
    expect(res.status).toBe(200);
    expect(res.body.timezone).toBe("America/New_York");
  });

  it("PUT /me with an empty body is rejected", async () => {
    const user = await signUpTestUser(app);
    const res = await user.agent.put("/api/v1/profile/me").send({});
    expect(res.status).toBe(400);
  });

  it("GET /me without a session is 401", async () => {
    const res = await request(app).get("/api/v1/profile/me");
    expect(res.status).toBe(401);
  });

  it("PUT /me without a session is 401", async () => {
    const res = await request(app).put("/api/v1/profile/me").send({ fullName: "Nope" });
    expect(res.status).toBe(401);
  });
});
