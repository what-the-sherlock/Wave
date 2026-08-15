import { describe, expect, it } from "vitest";
import { loadPrivilegedConfig } from "../../src/config/privileged.js";

describe("loadPrivilegedConfig", () => {
  it("parses a valid service role key", () => {
    const config = loadPrivilegedConfig({ SUPABASE_SERVICE_ROLE_KEY: "s".repeat(40) });
    expect(config.SUPABASE_SERVICE_ROLE_KEY).toBe("s".repeat(40));
  });

  it("throws when the key is missing", () => {
    expect(() => loadPrivilegedConfig({})).toThrow(/SUPABASE_SERVICE_ROLE_KEY/);
  });

  it("throws when the key looks too short to be real", () => {
    expect(() => loadPrivilegedConfig({ SUPABASE_SERVICE_ROLE_KEY: "short" })).toThrow();
  });
});
