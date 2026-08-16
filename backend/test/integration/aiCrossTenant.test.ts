import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { makeTestApp } from "../helpers/testApp.js";
import { createChannelFixture, type ChannelFixture } from "../helpers/channelFixture.js";
import { isAuthServiceReachable, isDatabaseReachable } from "../helpers/db.js";
import {
  makeCapturingEmitter,
  makeCapturingQueue,
  makeFakeEmbedder,
  makeFakeLlmProvider,
} from "../helpers/aiFixture.js";
import { setEmbedder, resetEmbedder } from "../../src/ai/embedder.js";
import { setLlmProvider, resetLlmProvider } from "../../src/ai/llmProvider.js";
import { setQueue, resetQueue } from "../../src/queue/index.js";
import { setRealtimeEmitter, resetRealtimeEmitter } from "../../src/realtime/emitter.js";
import { embeddingGenerateHandler } from "../../src/ai/embedding.worker.js";
import { aiProcessHandler } from "../../src/ai/ai.worker.js";
import * as aiService from "../../src/ai/ai.service.js";
import type { AiProcessJob } from "../../src/ai/aiJob.js";

const dbUp = await isDatabaseReachable(process.env.DATABASE_URL!);
const authUp = await isAuthServiceReachable(process.env.SUPABASE_URL!, process.env.SUPABASE_ANON_KEY!);
const liveStackAvailable = dbUp && authUp;

/**
 * The Phase 7 hard gate (docs/implementation-roadmap.md Phase 7 DoD): index
 * a message in Workspace B, ask a related question from Workspace A, and
 * assert neither the answer text nor its citations contain anything from B
 * — proven by capturing exactly what context the LLM provider actually
 * received, not just what it echoed back. Nothing here uses a real Groq key
 * or downloads a real embedding model (see test/helpers/aiFixture.ts).
 */
describe.skipIf(!liveStackAvailable)("AI cross-tenant isolation (integration, live Supabase)", () => {
  const app = makeTestApp();
  let A: ChannelFixture;
  let B: ChannelFixture;
  const secret = `zzzflamingo${randomUUID().slice(0, 8)}`;

  beforeAll(async () => {
    [A, B] = await Promise.all([createChannelFixture(app), createChannelFixture(app)]);
    setEmbedder(makeFakeEmbedder());

    await B.owner.agent
      .post(`/api/v1/channels/${B.channel.id}/messages`)
      .send({ body: `the secret launch codeword is ${secret}`, clientMsgId: randomUUID() });

    await embeddingGenerateHandler({ channelId: B.channel.id });
  });

  afterEach(() => {
    resetEmbedder();
    setEmbedder(makeFakeEmbedder()); // keep the fake active across tests in this file
    resetLlmProvider();
    resetQueue();
    resetRealtimeEmitter();
  });

  it("Workspace A's retrieval never surfaces Workspace B's indexed content", async () => {
    let capturedContext = "";
    setLlmProvider(
      makeFakeLlmProvider((req) => {
        capturedContext = req.messages.map((m) => m.content).join("\n");
        return "I could not find an answer in the provided context.";
      }),
    );
    const queue = makeCapturingQueue();
    setQueue(queue);
    const emitter = makeCapturingEmitter();
    setRealtimeEmitter(emitter);

    await aiService.askQuestion(A.owner.id, A.workspace.id, `what is the secret launch codeword?`);

    const job = queue.jobs.find((j) => j.queueName === "ai.process");
    expect(job).toBeDefined();
    await aiProcessHandler(job!.data as AiProcessJob);

    // The strongest assertion: the secret never even reached the LLM
    // provider as context, because retrieval never returned it.
    expect(capturedContext).not.toContain(secret);

    const done = emitter.events.find((e) => e.event === "ai.response.done");
    expect(done).toBeDefined();
    const payload = done!.payload as { text: string; citations: { messageId: string }[] };
    expect(payload.text).not.toContain(secret);
    expect(payload.citations).toEqual([]);
  });

  it("a question asked FROM Workspace B (the owner of the content) can retrieve it", async () => {
    let capturedContext = "";
    setLlmProvider(
      makeFakeLlmProvider((req) => {
        capturedContext = req.messages.map((m) => m.content).join("\n");
        return "The codeword was mentioned in the channel.";
      }),
    );
    const queue = makeCapturingQueue();
    setQueue(queue);
    setRealtimeEmitter(makeCapturingEmitter());

    await aiService.askQuestion(B.owner.id, B.workspace.id, `what is the secret launch codeword?`);
    const job = queue.jobs.find((j) => j.queueName === "ai.process");
    await aiProcessHandler(job!.data as AiProcessJob);

    // Sanity check that the fake embedder/retrieval pipeline actually
    // works end-to-end — otherwise the isolation test above would pass
    // vacuously (nothing is ever retrieved for anyone).
    expect(capturedContext).toContain(secret);
  });
});
