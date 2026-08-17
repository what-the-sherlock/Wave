import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeTestApp } from "../helpers/testApp.js";
import { createWorkspaceFixture } from "../helpers/workspaceFixture.js";
import { signUpTestUser } from "../helpers/authFixture.js";
import { isAuthServiceReachable, isDatabaseReachable } from "../helpers/db.js";
import { makeFakeLlmProvider } from "../helpers/aiFixture.js";
import { setLlmProvider, resetLlmProvider } from "../../src/ai/llmProvider.js";
import { ForbiddenError } from "../../src/errors/AppError.js";
import * as aiService from "../../src/ai/ai.service.js";

const dbUp = await isDatabaseReachable(process.env.DATABASE_URL!);
const authUp = await isAuthServiceReachable(process.env.SUPABASE_URL!, process.env.SUPABASE_ANON_KEY!);
const liveStackAvailable = dbUp && authUp;

describe.skipIf(!liveStackAvailable)("workspace ai-settings permission (integration, live Supabase)", () => {
  const app = makeTestApp();

  beforeAll(() => {
    setLlmProvider(makeFakeLlmProvider(() => "ok"));
  });
  afterAll(() => {
    resetLlmProvider();
  });

  async function inviteMember(owner: Awaited<ReturnType<typeof createWorkspaceFixture>>["owner"], workspaceId: string) {
    const member = await signUpTestUser(app);
    const inviteRes = await owner.agent
      .post(`/api/v1/workspaces/${workspaceId}/invites`)
      .send({ role: "MEMBER" });
    await member.agent.post(`/api/v1/invites/${inviteRes.body.token}/accept`);
    return member;
  }

  it("a MEMBER can toggle aiEnabled via ai-settings but still can't rename the workspace", async () => {
    const fixture = await createWorkspaceFixture(app);
    const member = await inviteMember(fixture.owner, fixture.workspace.id);

    const toggleRes = await member.agent
      .patch(`/api/v1/workspaces/${fixture.workspace.id}/ai-settings`)
      .send({ aiEnabled: false });
    expect(toggleRes.status).toBe(200);
    expect(toggleRes.body.settings.aiEnabled).toBe(false);

    const renameRes = await member.agent
      .patch(`/api/v1/workspaces/${fixture.workspace.id}`)
      .send({ name: "member rename attempt" });
    expect(renameRes.status).toBe(403);
  });

  it("disabling AI via the member-accessible route still blocks further AI use", async () => {
    const fixture = await createWorkspaceFixture(app);
    const member = await inviteMember(fixture.owner, fixture.workspace.id);

    const toggleRes = await member.agent
      .patch(`/api/v1/workspaces/${fixture.workspace.id}/ai-settings`)
      .send({ aiEnabled: false });
    expect(toggleRes.status).toBe(200);

    await expect(
      aiService.askQuestion(member.id, fixture.workspace.id, "anything"),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});
