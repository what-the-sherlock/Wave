import type { Express } from "express";
import request, { type Agent } from "supertest";
import { randomUUID } from "node:crypto";

export type SignedUpUser = {
  agent: Agent;
  id: string;
  email: string;
  fullName: string;
  password: string;
  /** The raw cookie values, for tests (like the socket handshake ones)
   * that need to hand a `Cookie` header to a client that doesn't share
   * supertest's agent jar. */
  accessToken: string;
  refreshToken: string;
};

export function extractCookie(res: request.Response, name: string): string | undefined {
  const cookies = (res.headers["set-cookie"] as unknown as string[] | undefined) ?? [];
  const found = cookies.find((c) => c.startsWith(`${name}=`));
  return found?.split(";")[0]?.split("=").slice(1).join("=");
}

/**
 * Signs up a fresh, randomly-named user against the real (locally running)
 * Supabase Auth instance and returns a supertest agent that carries the
 * session cookies GoTrue issued — so subsequent requests through the agent
 * are authenticated exactly the way a real browser session would be.
 */
export async function signUpTestUser(
  app: Express,
  overrides: Partial<Pick<SignedUpUser, "email" | "fullName" | "password">> = {},
): Promise<SignedUpUser> {
  const agent = request.agent(app);
  const email = overrides.email ?? `test-${randomUUID()}@example.com`;
  const fullName = overrides.fullName ?? "Test User";
  const password = overrides.password ?? "a-genuinely-uncommon-passphrase-9x";

  const res = await agent.post("/api/v1/auth/signup").send({ email, fullName, password });
  if (res.status !== 201) {
    throw new Error(
      `signUpTestUser: signup failed with ${res.status}: ${JSON.stringify(res.body)}`,
    );
  }

  const accessToken = extractCookie(res, "sb-access");
  const refreshToken = extractCookie(res, "sb-refresh");
  if (!accessToken || !refreshToken) {
    throw new Error("signUpTestUser: signup response did not set session cookies");
  }

  return { agent, id: res.body.id as string, email, fullName, password, accessToken, refreshToken };
}
