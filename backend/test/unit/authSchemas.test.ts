import { describe, expect, it } from "vitest";
import { loginSchema, signUpSchema } from "../../src/auth/auth.schemas.js";

describe("signUpSchema", () => {
  it("accepts a reasonable signup payload", () => {
    const result = signUpSchema.safeParse({
      fullName: "Ada Lovelace",
      email: "Ada@Example.com",
      password: "a-genuinely-uncommon-passphrase-9x",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      // normalized: trimmed + lowercased email
      expect(result.data.email).toBe("ada@example.com");
    }
  });

  it("rejects a password shorter than 8 characters", () => {
    const result = signUpSchema.safeParse({
      fullName: "Ada",
      email: "ada@example.com",
      password: "short1",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a common password even if it meets the length minimum", () => {
    const result = signUpSchema.safeParse({
      fullName: "Ada",
      email: "ada@example.com",
      password: "password123",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an invalid email", () => {
    const result = signUpSchema.safeParse({
      fullName: "Ada",
      email: "not-an-email",
      password: "a-genuinely-uncommon-passphrase-9x",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an empty full name", () => {
    const result = signUpSchema.safeParse({
      fullName: "   ",
      email: "ada@example.com",
      password: "a-genuinely-uncommon-passphrase-9x",
    });
    expect(result.success).toBe(false);
  });
});

describe("loginSchema", () => {
  it("does not re-enforce password strength — an existing account's password might predate the policy", () => {
    const result = loginSchema.safeParse({ email: "ada@example.com", password: "123" });
    expect(result.success).toBe(true);
  });

  it("normalizes email casing and whitespace the same way signup does", () => {
    const result = loginSchema.safeParse({ email: "  Ada@Example.com  ", password: "x" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.email).toBe("ada@example.com");
    }
  });

  it("rejects an empty password", () => {
    const result = loginSchema.safeParse({ email: "ada@example.com", password: "" });
    expect(result.success).toBe(false);
  });
});
