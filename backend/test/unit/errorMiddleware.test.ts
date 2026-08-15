import express from "express";
import request from "supertest";
import { z } from "zod";
import { describe, expect, it } from "vitest";
import { errorMiddleware, notFoundMiddleware } from "../../src/errors/errorMiddleware.js";
import { ConflictError, NotFoundError, ValidationError } from "../../src/errors/AppError.js";
import { requestContextMiddleware } from "../../src/middleware/requestContext.js";

function buildApp() {
  const app = express();
  // requestId only exists once this middleware has run — matches the real
  // app, where it's the first thing registered (src/app.ts).
  app.use(requestContextMiddleware);
  app.get("/not-found-error", (_req, _res, next) => next(new NotFoundError("Channel not found")));
  app.get("/conflict", (_req, _res, next) => next(new ConflictError("Already exists")));
  app.get("/zod", (_req, _res, next) => {
    try {
      z.object({ name: z.string() }).parse({});
    } catch (err) {
      next(err);
    }
  });
  app.get("/validation-error", (_req, _res, next) =>
    next(new ValidationError("Bad input", { field: "email" })),
  );
  app.get("/boom", () => {
    throw new Error("raw internal failure with a stack trace nobody should see");
  });
  app.use(notFoundMiddleware);
  app.use(errorMiddleware);
  return app;
}

describe("errorMiddleware", () => {
  it("maps NotFoundError to 404 with its code", async () => {
    const res = await request(buildApp()).get("/not-found-error");
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("NOT_FOUND");
    expect(res.body.message).toBe("Channel not found");
  });

  it("maps ConflictError to 409", async () => {
    const res = await request(buildApp()).get("/conflict");
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("CONFLICT");
  });

  it("maps a raw ZodError to 400 VALIDATION_ERROR with details", async () => {
    const res = await request(buildApp()).get("/zod");
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_ERROR");
    expect(res.body.details).toBeDefined();
  });

  it("includes details on AppError subclasses that carry them", async () => {
    const res = await request(buildApp()).get("/validation-error");
    expect(res.status).toBe(400);
    expect(res.body.details).toEqual({ field: "email" });
  });

  it("never leaks a raw error's message for unexpected errors — generic 500", async () => {
    const res = await request(buildApp()).get("/boom");
    expect(res.status).toBe(500);
    expect(res.body.code).toBe("INTERNAL");
    expect(res.body.message).toBe("Something went wrong");
    expect(JSON.stringify(res.body)).not.toContain("stack trace");
  });

  it("every error response carries a requestId field", async () => {
    const res = await request(buildApp()).get("/not-found-error");
    expect("requestId" in res.body).toBe(true);
  });

  it("unmatched routes return a clean JSON 404, not an HTML page", async () => {
    const res = await request(buildApp()).get("/this/route/does/not/exist");
    expect(res.status).toBe(404);
    expect(res.type).toBe("application/json");
    expect(res.body.code).toBe("NOT_FOUND");
  });
});
