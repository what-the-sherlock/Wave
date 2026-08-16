import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeTestApp } from "../helpers/testApp.js";
import { createChannelFixture } from "../helpers/channelFixture.js";
import { isAuthServiceReachable, isDatabaseReachable } from "../helpers/db.js";
import { makeCapturingQueue, makeFakeLlmProvider } from "../helpers/aiFixture.js";
import { setLlmProvider, resetLlmProvider, unavailableLlmProvider } from "../../src/ai/llmProvider.js";
import { setQueue, resetQueue } from "../../src/queue/index.js";
import { ForbiddenError, ServiceUnavailableError, ValidationError } from "../../src/errors/AppError.js";
import * as aiService from "../../src/ai/ai.service.js";

const dbUp = await isDatabaseReachable(process.env.DATABASE_URL!);
const authUp = await isAuthServiceReachable(process.env.SUPABASE_URL!, process.env.SUPABASE_ANON_KEY!);
const liveStackAvailable = dbUp && authUp;

describe.skipIf(!liveStackAvailable)("AI request guards (integration, live Supabase)", () => {
  const app = makeTestApp();

  beforeAll(() => {
    setLlmProvider(makeFakeLlmProvider(() => "ok"));
    setQueue(makeCapturingQueue());
  });
  afterAll(() => {
    resetLlmProvider();
    resetQueue();
  });

  it("a user is blocked once the hourly per-user cap (20/hour) is reached", async () => {
    const fixture = await createChannelFixture(app);
    for (let i = 0; i < 20; i++) {
      await aiService.askQuestion(fixture.owner.id, fixture.workspace.id, `question number ${i}`);
    }
    await expect(
      aiService.askQuestion(fixture.owner.id, fixture.workspace.id, "one too many"),
    ).rejects.toBeInstanceOf(ForbiddenError);
  }, 30_000);

  it("asking in a workspace with AI disabled is rejected", async () => {
    const fixture = await createChannelFixture(app);
    await fixture.owner.agent
      .patch(`/api/v1/workspaces/${fixture.workspace.id}`)
      .send({ settings: { aiEnabled: false } });

    await expect(
      aiService.askQuestion(fixture.owner.id, fixture.workspace.id, "anything"),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("catch-up summary is rejected below the minimum unread threshold", async () => {
    const fixture = await createChannelFixture(app);
    await expect(aiService.requestCatchupSummary(fixture.owner.id, fixture.channel.id)).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it("thread summary is rejected below the minimum reply threshold", async () => {
    const fixture = await createChannelFixture(app);
    const rootRes = await fixture.owner.agent
      .post(`/api/v1/channels/${fixture.channel.id}/messages`)
      .send({ body: "starting a short thread", clientMsgId: randomUUID() });

    await expect(
      aiService.requestThreadSummary(fixture.owner.id, fixture.channel.id, rootRes.body.id as string),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("every AI entry point degrades to a clear error when no provider is configured", async () => {
    setLlmProvider(unavailableLlmProvider);
    const fixture = await createChannelFixture(app);
    await expect(
      aiService.askQuestion(fixture.owner.id, fixture.workspace.id, "anything"),
    ).rejects.toBeInstanceOf(ServiceUnavailableError);
    setLlmProvider(makeFakeLlmProvider(() => "ok")); // restore for subsequent tests in this file
  });
});
