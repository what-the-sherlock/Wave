import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import {
  ACCESS_COOKIE_NAME,
  clearSessionCookies,
  readAccessToken,
  readRefreshToken,
  REFRESH_COOKIE_NAME,
  setSessionCookies,
} from "../../src/auth/cookies.js";
import cookieParser from "cookie-parser";

function buildApp() {
  const app = express();
  app.use(cookieParser());
  app.get("/set", (_req, res) => {
    setSessionCookies(res, { accessToken: "at-value", refreshToken: "rt-value", expiresIn: 3600 });
    res.status(200).end();
  });
  app.get("/clear", (_req, res) => {
    clearSessionCookies(res);
    res.status(200).end();
  });
  app.get("/read", (req, res) => {
    res.status(200).json({
      access: readAccessToken(req) ?? null,
      refresh: readRefreshToken(req) ?? null,
    });
  });
  return app;
}

describe("session cookies", () => {
  it("sets the access cookie httpOnly, sameSite=strict, path=/", async () => {
    const res = await request(buildApp()).get("/set");
    const cookies = res.headers["set-cookie"] as unknown as string[];
    const access = cookies.find((c) => c.startsWith(`${ACCESS_COOKIE_NAME}=`));
    expect(access).toBeDefined();
    expect(access).toMatch(/HttpOnly/i);
    expect(access).toMatch(/SameSite=Strict/i);
    expect(access).toMatch(/Path=\//);
  });

  it("scopes the refresh cookie to the refresh endpoint path only", async () => {
    const res = await request(buildApp()).get("/set");
    const cookies = res.headers["set-cookie"] as unknown as string[];
    const refresh = cookies.find((c) => c.startsWith(`${REFRESH_COOKIE_NAME}=`));
    expect(refresh).toBeDefined();
    expect(refresh).toMatch(/Path=\/api\/v1\/auth\/refresh/);
    expect(refresh).toMatch(/HttpOnly/i);
    expect(refresh).toMatch(/SameSite=Strict/i);
  });

  it("clears both cookies with attributes matching how they were set (D18)", async () => {
    const agent = request.agent(buildApp());
    await agent.get("/set");
    const clearRes = await agent.get("/clear");
    const cookies = clearRes.headers["set-cookie"] as unknown as string[];
    const access = cookies.find((c) => c.startsWith(`${ACCESS_COOKIE_NAME}=`));
    const refresh = cookies.find((c) => c.startsWith(`${REFRESH_COOKIE_NAME}=`));
    expect(access).toMatch(/Expires=Thu, 01 Jan 1970/);
    expect(refresh).toMatch(/Expires=Thu, 01 Jan 1970/);
    expect(refresh).toMatch(/Path=\/api\/v1\/auth\/refresh/);

    // And a subsequent read sees neither cookie any more.
    const readRes = await agent.get("/read");
    expect(readRes.body).toEqual({ access: null, refresh: null });
  });

  it("round-trips through the browser via an agent (cookies actually apply)", async () => {
    const agent = request.agent(buildApp());
    await agent.get("/set");
    const readRes = await agent.get("/read");
    expect(readRes.body.access).toBe("at-value");
  });
});
