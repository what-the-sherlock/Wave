import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { emailLimiter, ipLimiter } from "../../src/middleware/rateLimit.js";
import { errorMiddleware } from "../../src/errors/errorMiddleware.js";

function buildApp(limiter: express.RequestHandler) {
  const app = express();
  app.use(express.json());
  app.post("/login", limiter, (_req, res) => res.status(200).json({ ok: true }));
  app.use(errorMiddleware);
  return app;
}

describe("rate limiting", () => {
  it("the concrete Phase 1 requirement: a 6th login attempt within the window is rejected", async () => {
    // Fresh, isolated limiter (5/window) so this test cannot be affected by
    // any other test's requests.
    const app = buildApp(ipLimiter(15 * 60 * 1000, 5));

    for (let i = 1; i <= 5; i++) {
      const res = await request(app).post("/login").send({});
      expect(res.status, `attempt ${i} should succeed`).toBe(200);
    }

    const sixth = await request(app).post("/login").send({});
    expect(sixth.status).toBe(429);
    expect(sixth.body.code).toBe("RATE_LIMITED");
  });

  it("email-keyed limiting bounds one account even across a distributed attack (no single IP)", async () => {
    const app = buildApp(emailLimiter(60 * 60 * 1000, 3));

    for (let i = 1; i <= 3; i++) {
      const res = await request(app)
        .post("/login")
        .set("X-Forwarded-For", `10.0.0.${i}`) // a different apparent IP each time
        .send({ email: "victim@example.com" });
      expect(res.status).toBe(200);
    }

    const fourth = await request(app)
      .post("/login")
      .set("X-Forwarded-For", "10.0.0.99")
      .send({ email: "victim@example.com" });
    expect(fourth.status).toBe(429);
  });

  it("email-keyed limiting does not cross-contaminate different accounts", async () => {
    const app = buildApp(emailLimiter(60 * 60 * 1000, 2));

    await request(app).post("/login").send({ email: "a@example.com" });
    await request(app).post("/login").send({ email: "a@example.com" });
    // a@example.com is now at its limit; b@example.com should be unaffected.
    const res = await request(app).post("/login").send({ email: "b@example.com" });
    expect(res.status).toBe(200);
  });

  it("email keying is case- and whitespace-insensitive, matching the auth schema's normalization", async () => {
    const app = buildApp(emailLimiter(60 * 60 * 1000, 1));

    const first = await request(app).post("/login").send({ email: "Case@Example.com" });
    expect(first.status).toBe(200);

    const second = await request(app).post("/login").send({ email: "  case@example.com  " });
    expect(second.status).toBe(429);
  });
});
