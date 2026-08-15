import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { asyncHandler } from "../../src/errors/asyncHandler.js";
import { errorMiddleware } from "../../src/errors/errorMiddleware.js";
import { ForbiddenError } from "../../src/errors/AppError.js";

describe("asyncHandler", () => {
  it("forwards a rejected promise to next() so errorMiddleware can handle it", async () => {
    const app = express();
    app.get(
      "/",
      asyncHandler(async () => {
        throw new ForbiddenError("nope");
      }),
    );
    app.use(errorMiddleware);

    const res = await request(app).get("/");
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("FORBIDDEN");
  });

  it("lets a successful handler respond normally", async () => {
    const app = express();
    app.get(
      "/",
      asyncHandler(async (_req, res) => {
        res.status(200).json({ ok: true });
      }),
    );
    app.use(errorMiddleware);

    const res = await request(app).get("/");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
});
