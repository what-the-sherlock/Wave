import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../../src/config/env.js";

const validEnv = {
  NODE_ENV: "production",
  PORT: "5001",
  DATABASE_URL: "postgres://user:pass@localhost:6543/postgres",
  SUPABASE_URL: "https://project.supabase.co",
  SUPABASE_ANON_KEY: "a".repeat(40),
  CORS_ORIGINS: "https://app.example.com, https://admin.example.com",
  LOG_LEVEL: "info",
} satisfies Record<string, string>;

describe("loadConfig", () => {
  it("parses a fully valid environment", () => {
    const config = loadConfig(validEnv);
    expect(config.PORT).toBe(5001);
    expect(config.NODE_ENV).toBe("production");
    expect(config.CORS_ORIGINS).toEqual([
      "https://app.example.com",
      "https://admin.example.com",
    ]);
    expect(config.isProduction).toBe(true);
    expect(config.isTest).toBe(false);
    expect(config.secureCookies).toBe(true);
  });

  it("defaults PORT to 5001 when absent (the original app had no fallback at all)", () => {
    const { PORT: _unused, ...rest } = validEnv;
    const config = loadConfig(rest);
    expect(config.PORT).toBe(5001);
  });

  it("marks cookies secure only in production — dev and test both run over plain HTTP", () => {
    expect(loadConfig({ ...validEnv, NODE_ENV: "development" }).secureCookies).toBe(false);
    expect(loadConfig({ ...validEnv, NODE_ENV: "test" }).secureCookies).toBe(false);
    expect(loadConfig({ ...validEnv, NODE_ENV: "production" }).secureCookies).toBe(true);
  });

  it("throws ConfigError — not a generic error — with a readable message when DATABASE_URL is missing", () => {
    const { DATABASE_URL: _unused, ...rest } = validEnv;
    expect(() => loadConfig(rest)).toThrow(ConfigError);
    try {
      loadConfig(rest);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as Error).message).toContain("DATABASE_URL");
    }
  });

  it("rejects a non-Postgres DATABASE_URL", () => {
    expect(() => loadConfig({ ...validEnv, DATABASE_URL: "mysql://localhost/db" })).toThrow(
      ConfigError,
    );
  });

  it("rejects a malformed SUPABASE_URL", () => {
    expect(() => loadConfig({ ...validEnv, SUPABASE_URL: "not-a-url" })).toThrow(ConfigError);
  });

  it("rejects an empty CORS_ORIGINS", () => {
    expect(() => loadConfig({ ...validEnv, CORS_ORIGINS: "   " })).toThrow(ConfigError);
  });

  it("rejects an invalid NODE_ENV rather than silently accepting it", () => {
    expect(() => loadConfig({ ...validEnv, NODE_ENV: "staging" })).toThrow(ConfigError);
  });

  it("SUPABASE_JWT_SECRET is optional (falls back to remote JWKS)", () => {
    const config = loadConfig(validEnv);
    expect(config.SUPABASE_JWT_SECRET).toBeUndefined();
  });
});
