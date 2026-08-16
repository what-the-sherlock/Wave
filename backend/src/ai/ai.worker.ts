import { z } from "zod";
import Groq from "groq-sdk";
import { withRlsScope } from "../db/rlsScope.js";
import { logger } from "../logging/logger.js";
import { getRealtimeEmitter } from "../realtime/emitter.js";
import { getLlmProvider } from "./llmProvider.js";
import * as retrievalService from "./retrieval.service.js";
import * as retrievalRepo from "./retrieval.repository.js";
import * as catchupRepo from "./catchup.repository.js";
import * as messageRepo from "../channels/message.repository.js";
import * as aiRepo from "./ai.repository.js";
import * as summaryCacheRepo from "./summaryCache.repository.js";
import {
  QA_SYSTEM_PROMPT,
  CATCHUP_SYSTEM_PROMPT,
  THREAD_SUMMARY_SYSTEM_PROMPT,
  buildContextBlock,
  extractCitedMessageIds,
  stripCitationMarkers,
  type ContextMessage,
} from "./aiPrompts.js";
import type { AiProcessJob } from "./aiJob.js";
import type { AiSummaryPayload } from "./summaryCache.repository.js";

const CATCHUP_WINDOW_LIMIT = 200;
const QA_MAX_TOKENS = 768;
const SUMMARY_MAX_TOKENS = 768;

export type Citation = { messageId: string; channelId: string; seq: number };

const summaryModelOutputSchema = z.object({
  bullets: z.array(z.string()).max(20).default([]),
  decisions: z.array(z.string()).max(20).default([]),
  needsYourInput: z.array(z.string()).max(20).default([]),
  citedMessageIds: z.array(z.string()).max(50).default([]),
});

/**
 * `ai.process` job handler — the only place that ever calls the LLM
 * provider. Every DB access runs under `withRlsScope({ userId })`, **not**
 * service_role, so retrieval and citation re-authorization both go through
 * the real RLS policies (docs/ai-architecture.md §4 Rules 1-4). Configured
 * in `pgBossQueue.ts` with `retryBackoff: true`.
 *
 * **Deliberately three separate short-lived transactions, not one spanning
 * the whole request**: fetch context → (no transaction) call the LLM →
 * re-authorize citations and persist. A Postgres transaction held open for
 * the full duration of an external HTTP call to Groq — which can run many
 * seconds for a long streamed answer — starves the connection pool and
 * risks Postgres's own idle-in-transaction timeout killing it mid-stream
 * (confirmed by actually running this end-to-end with a real Groq key: the
 * first version of this handler held one transaction across the entire
 * stream and the connection died partway through, silently dropping the
 * citation re-authorization and `ai_requests` update after tokens had
 * already streamed to the client). This is exactly the failure mode
 * Supavisor transaction-mode pooling is documented elsewhere in this
 * codebase to guard against — a long-lived transaction defeats it.
 *
 * Error handling distinguishes two cases deliberately:
 *  - A Groq rate limit (429) is re-thrown so pg-boss retries with backoff —
 *    the request never reaches the user as an error at all (the hard DoD
 *    requirement: "a provider 429 never reaches the user").
 *  - Anything else is terminal: the `ai_requests` row is marked FAILED, an
 *    `ai.response.error` is emitted once, and the error is swallowed (not
 *    re-thrown) so pg-boss does not retry a request the user was already
 *    told failed.
 */
export async function aiProcessHandler(job: AiProcessJob): Promise<void> {
  try {
    const existing = await withRlsScope({ userId: job.userId }, (tx) => aiRepo.findById(tx, job.requestId));
    if (existing?.status === "DONE" || existing?.status === "FAILED") {
      // Already handled by a previous attempt of this same job — nothing
      // left to do, and never call Groq twice for one request.
      return;
    }

    if (job.kind === "WORKSPACE_QA") {
      await handleWorkspaceQa(job);
    } else if (job.kind === "CHANNEL_SUMMARY") {
      await handleChannelSummary(job);
    } else {
      await handleThreadSummary(job);
    }
  } catch (err) {
    if (err instanceof Groq.RateLimitError) {
      throw err; // let pg-boss's retryBackoff handle it — never surfaced to the user
    }
    logger.error({ err, requestId: job.requestId, kind: job.kind }, "ai.process failed");
    await withRlsScope({ userId: job.userId }, (tx) =>
      aiRepo.markFailed(tx, job.requestId, err instanceof Error ? err.message : "Unknown error"),
    ).catch((markErr: unknown) => logger.error({ err: markErr }, "ai.process: failed to mark request FAILED"));
    getRealtimeEmitter().toUser(job.userId, "ai.response.error", {
      requestId: job.requestId,
      kind: job.kind,
      message: "This AI request could not be completed. Please try again.",
    });
  }
}

async function handleWorkspaceQa(job: Extract<AiProcessJob, { kind: "WORKSPACE_QA" }>): Promise<void> {
  const context = await withRlsScope({ userId: job.userId }, (tx) =>
    retrievalService.retrieveForQuestion(tx, job.workspaceId, job.question),
  );
  const contextBlock = buildContextBlock(context);
  const llm = getLlmProvider();

  let full = "";
  for await (const delta of llm.stream({
    system: QA_SYSTEM_PROMPT,
    maxTokens: QA_MAX_TOKENS,
    messages: [{ role: "user", content: `${contextBlock}\n\nQuestion: ${job.question}` }],
  })) {
    full += delta;
    getRealtimeEmitter().toUser(job.userId, "ai.response.chunk", { requestId: job.requestId, delta });
  }

  const citedIds = extractCitedMessageIds(full);
  const citations = await withRlsScope({ userId: job.userId }, async (tx) => {
    const reauthorized = await retrievalRepo.reauthorizeMessages(tx, citedIds);
    const result: Citation[] = reauthorized.map((m) => ({ messageId: m.id, channelId: m.channelId, seq: m.seq }));
    await aiRepo.markDone(tx, job.requestId, result.map((c) => c.messageId));
    return result;
  });

  getRealtimeEmitter().toUser(job.userId, "ai.response.done", {
    requestId: job.requestId,
    kind: job.kind,
    text: stripCitationMarkers(full),
    citations,
  });
}

async function generateSummaryPayload(
  system: string,
  contextBlock: string,
): Promise<AiSummaryPayload & { rawCitedIds: string[] }> {
  const llm = getLlmProvider();
  const request = {
    system,
    maxTokens: SUMMARY_MAX_TOKENS,
    jsonMode: true,
    messages: [{ role: "user" as const, content: contextBlock }],
  };

  // Structured output is the weak spot for open models
  // (docs/free-tier-plan.md §4) — Groq's own JSON mode can fail generation
  // outright for some prompts ("Failed to generate JSON. Please adjust
  // your prompt"), not just return malformed JSON. Retried once, per that
  // doc's explicit guidance, before this is treated as terminal.
  let raw: string;
  try {
    raw = await llm.complete(request);
  } catch (err) {
    logger.warn({ err }, "ai.process: summary generation failed, retrying once");
    raw = await llm.complete(request);
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    parsedJson = undefined;
  }
  const parsed = parsedJson !== undefined ? summaryModelOutputSchema.safeParse(parsedJson) : undefined;
  if (!parsed?.success) {
    // The model returned *something* but not valid/matching JSON — degrade
    // gracefully rather than retry again; this is a summary, not a
    // schema-critical action-item extraction (docs/ai-architecture.md §3.4
    // explains why *that* feature is cut instead of degraded).
    logger.warn({ raw: raw.slice(0, 200) }, "ai.process: summary JSON did not match schema, degrading");
    return {
      bullets: [raw.slice(0, 500) || "No summary could be generated."],
      decisions: [],
      needsYourInput: [],
      citedMessageIds: [],
      truncated: false,
      rawCitedIds: [],
    };
  }
  return {
    bullets: parsed.data.bullets,
    decisions: parsed.data.decisions,
    needsYourInput: parsed.data.needsYourInput,
    citedMessageIds: [],
    truncated: false,
    rawCitedIds: parsed.data.citedMessageIds,
  };
}

function toContextMessages(
  messages: { id: string; seq: number; senderId: string; body: string | null; createdAt: Date }[],
): ContextMessage[] {
  return messages.map((m) => ({ id: m.id, seq: m.seq, senderId: m.senderId, body: m.body, createdAt: m.createdAt }));
}

/** Shared by both summary kinds: call the LLM (no open transaction), then
 * re-authorize + cache + mark done in one short final transaction. */
async function finishSummary(
  job: Extract<AiProcessJob, { kind: "CHANNEL_SUMMARY" | "THREAD_SUMMARY" }>,
  system: string,
  contextBlock: string,
  truncated: boolean,
  threadRootId: string | null,
): Promise<void> {
  const generated = await generateSummaryPayload(system, contextBlock);

  const payload = await withRlsScope({ userId: job.userId }, async (tx) => {
    const reauthorized = await retrievalRepo.reauthorizeMessages(tx, generated.rawCitedIds);
    const result: AiSummaryPayload = {
      bullets: generated.bullets,
      decisions: generated.decisions,
      needsYourInput: job.kind === "CHANNEL_SUMMARY" ? generated.needsYourInput : [],
      citedMessageIds: reauthorized.map((m) => m.id),
      truncated,
    };
    await summaryCacheRepo.upsert(tx, {
      cacheKey: job.cacheKey,
      kind: job.kind,
      channelId: job.channelId,
      threadRootId,
      summary: result,
    });
    await aiRepo.markDone(tx, job.requestId, result.citedMessageIds);
    return result;
  });

  getRealtimeEmitter().toUser(job.userId, "ai.response.done", { requestId: job.requestId, kind: job.kind, summary: payload });
}

async function handleChannelSummary(job: Extract<AiProcessJob, { kind: "CHANNEL_SUMMARY" }>): Promise<void> {
  const window = await withRlsScope({ userId: job.userId }, (tx) =>
    catchupRepo.fetchUnreadWindow(tx, job.channelId, job.userId, CATCHUP_WINDOW_LIMIT),
  );
  const contextBlock = buildContextBlock(toContextMessages(window?.messages ?? []));
  await finishSummary(job, CATCHUP_SYSTEM_PROMPT, contextBlock, window?.truncated ?? false, null);
}

async function handleThreadSummary(job: Extract<AiProcessJob, { kind: "THREAD_SUMMARY" }>): Promise<void> {
  const { root, replies } = await withRlsScope({ userId: job.userId }, async (tx) => ({
    root: await messageRepo.findById(tx, job.threadRootId),
    replies: await messageRepo.listThreadReplies(tx, job.threadRootId),
  }));
  const all = root ? [root, ...replies] : replies;
  const contextBlock = buildContextBlock(toContextMessages(all));
  await finishSummary(job, THREAD_SUMMARY_SYSTEM_PROMPT, contextBlock, false, job.threadRootId);
}
