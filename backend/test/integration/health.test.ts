import request from "supertest";
import { describe, expect, it } from "vitest";
import { makeTestApp } from "../helpers/testApp.js";
import { isDatabaseReachable } from "../helpers/db.js";

describe("health endpoints", () => {
  it("GET /healthz always returns 200 — no dependency checks (liveness only)", async () => {
    const res = await request(makeTestApp()).get("/healthz");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });

  it("GET /readyz reflects real database reachability", async () => {
    const dbUp = await isDatabaseReachable(process.env.DATABASE_URL!);
    const res = await request(makeTestApp()).get("/readyz");
    expect(res.status).toBe(dbUp ? 200 : 503);
  });

  it("health endpoints are not rate-limited and require no auth", async () => {
    const app = makeTestApp();
    for (let i = 0; i < 10; i++) {
      const res = await request(app).get("/healthz");
      expect(res.status).toBe(200);
    }
  });
});
