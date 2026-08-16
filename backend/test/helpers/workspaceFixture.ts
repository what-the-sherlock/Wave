import type { Express } from "express";
import { randomUUID } from "node:crypto";
import { signUpTestUser, type SignedUpUser } from "./authFixture.js";

export type WorkspaceDto = {
  id: string;
  name: string;
  slug: string;
  iconUrl: string | null;
  memberCount: number;
  role: "OWNER" | "ADMIN" | "MEMBER";
};

export type WorkspaceFixture = {
  owner: SignedUpUser;
  workspace: WorkspaceDto;
};

/** Signs up a fresh user and has them create a fresh workspace — the base
 * fixture nearly every Phase 2 integration test builds on. */
export async function createWorkspaceFixture(
  app: Express,
  name = `Test Workspace ${randomUUID()}`,
): Promise<WorkspaceFixture> {
  const owner = await signUpTestUser(app);
  const res = await owner.agent.post("/api/v1/workspaces").send({ name });
  if (res.status !== 201) {
    throw new Error(
      `createWorkspaceFixture: workspace creation failed with ${res.status}: ${JSON.stringify(res.body)}`,
    );
  }
  return { owner, workspace: res.body as WorkspaceDto };
}
