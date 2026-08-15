import express from "express";
import request from "supertest";
import { z } from "zod";
import { describe, expect, it } from "vitest";
import { validate } from "../../src/middleware/validate.js";
import { errorMiddleware } from "../../src/errors/errorMiddleware.js";

const bodySchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  age: z.coerce.number().int().min(0).optional(),
});

function buildApp() {
  const app = express();
  app.use(express.json());
  app.post("/body", validate({ body: bodySchema }), (req, res) => {
    res.status(200).json(req.body);
  });
  app.get(
    "/params/:id",
    validate({ params: z.object({ id: z.string().uuid() }) }),
    (req, res) => {
      res.status(200).json(req.params);
    },
  );
  app.use(errorMiddleware);
  return app;
}

describe("validate middleware", () => {
  it("normalizes the body per schema (trim, lowercase) and replaces req.body", async () => {
    const res = await request(buildApp())
      .post("/body")
      .send({ email: "  Alice@Example.COM  " });
    expect(res.status).toBe(200);
    expect(res.body.email).toBe("alice@example.com");
  });

  it("rejects an invalid body with 400 VALIDATION_ERROR", async () => {
    const res = await request(buildApp()).post("/body").send({ email: "not-an-email" });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_ERROR");
  });

  it("validates route params too", async () => {
    const res = await request(buildApp()).get("/params/not-a-uuid");
    expect(res.status).toBe(400);
  });

  it("accepts a valid uuid param", async () => {
    const res = await request(buildApp()).get(
      "/params/11111111-1111-4111-8111-111111111111",
    );
    expect(res.status).toBe(200);
  });
});
