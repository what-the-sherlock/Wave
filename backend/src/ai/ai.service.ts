import { withRlsScope, type Tx } from "../db/rlsScope.js";
import { config } from "../config/env.js";
import { ForbiddenError, NotFoundError, ServiceUnavailableError, ValidationError } from "../errors/AppError.js";
import { getQueue } from "../queue/index.js";
import { getLlmProvider } from "./llmProvider.js";
import { isEligibleChannel } from "./chunking.js";
import * as aiRepo from "./ai.repository.js";
import * as summaryCacheRepo from "./summaryCache.repository.js";
import * as channelRepo from "../channels/channel.repository.js";
import * as channelMemberRepo from "../channels/channelMember.repository.js";
import * as workspaceRepo from "../workspaces/workspace.repository.js";
import * as messageRepo from "../channels/message.repository.js";
import type { AiSummaryPayload } from "./summaryCache.repository.js";
import type { AiProcessJob } from "./aiJob.js";

export type { AiSummaryPayload } from "./summaryCache.repository.js";

// docs/ai-architecture.md §5 — every guard here protects availability
// (a 429 in the user's face), not a bill.
const USER_HOURLY_CAP = 20;
const CATCHUP_CACHE_TTL_MS = 60 * 60_000;
const MIN_UNREAD_FOR_CATCHUP = 10;
export const THREAD_SUMMARY_MIN_REPLIES = 15;

function ensureProviderAvailable(): void {
  if (!getLlmProvider().available) {
    throw new ServiceUnavailableError("AI is not configured on this deployment");
  }
}

/** Shared by all three request kinds — service_role is never used here;
 * every check runs through the caller's own RLS scope
 * (docs/ai-architecture.md §4 Rule 3). */
async function enforceRateCaps(tx: Tx, userId: string, workspaceId: string): Promise<void> {
  const now = Date.now();
  const [userCount, workspaceCount] = await Promise.all([
    aiRepo.countByUserSince(tx, userId, new Date(now - 60 * 60_000)),
    aiRepo.countByWorkspaceSince(tx, workspaceId, new Date(now - 24 * 60 * 60_000)),
  ]);
  if (userCount >= USER_HOURLY_CAP) {
    throw new ForbiddenError(`AI request limit reached (${USER_HOURLY_CAP}/hour per user) — try again later`);
  }
  if (workspaceCount >= config.AI_DAILY_REQUEST_CAP) {
    throw new ForbiddenError(
      `This workspace's daily AI request limit (${config.AI_DAILY_REQUEST_CAP}) has been reached`,
    );
  }
}

export type QueuedResult = { requestId: string };
export type CachedOrQueuedResult = { requestId: string; cached: AiSummaryPayload | null };

export async function askQuestion(userId: string, workspaceId: string, question: string): Promise<QueuedResult> {
  ensureProviderAvailable();
  return withRlsScope({ userId }, async (tx) => {
    const workspace = await workspaceRepo.findById(tx, workspaceId);
    if (!workspace) {
      throw new NotFoundError("Workspace not found");
    }
    if (!workspace.settings.aiEnabled) {
      throw new ForbiddenError("AI is disabled for this workspace");
    }
    await enforceRateCaps(tx, userId, workspaceId);

    const row = await aiRepo.insert(tx, { workspaceId, userId, kind: "WORKSPACE_QA" });
    const job: AiProcessJob = { kind: "WORKSPACE_QA", requestId: row.id, userId, workspaceId, question };
    await getQueue().sendTx(tx, "ai.process", job);
    return { requestId: row.id };
  });
}

async function requireAiEligibleChannel(tx: Tx, channelId: string) {
  const channel = await channelRepo.findById(tx, channelId);
  if (!channel) {
    throw new NotFoundError("Channel not found");
  }
  if (!isEligibleChannel(channel)) {
    throw new ForbiddenError("AI is not available in this channel");
  }
  const workspace = await workspaceRepo.findById(tx, channel.workspaceId);
  if (!workspace || !workspace.settings.aiEnabled) {
    throw new ForbiddenError("AI is disabled for this workspace");
  }
  return channel;
}

export async function requestCatchupSummary(userId: string, channelId: string): Promise<CachedOrQueuedResult> {
  ensureProviderAvailable();
  return withRlsScope({ userId }, async (tx) => {
    const channel = await requireAiEligibleChannel(tx, channelId);
    const membership = await channelMemberRepo.findMembership(tx, channelId, userId);
    if (!membership) {
      throw new NotFoundError("Channel not found");
    }
    const unread = channel.lastMessageSeq - membership.lastReadSeq;
    if (unread < MIN_UNREAD_FOR_CATCHUP) {
      throw new ValidationError(
        `Not enough unread messages to summarize (need at least ${MIN_UNREAD_FOR_CATCHUP})`,
      );
    }

    const cacheKey = `catchup:${channelId}:${membership.lastReadSeq}:${channel.lastMessageSeq}`;
    const cached = await summaryCacheRepo.find(tx, cacheKey, new Date(Date.now() - CATCHUP_CACHE_TTL_MS));
    if (cached) {
      return { requestId: "", cached: cached.summary };
    }

    await enforceRateCaps(tx, userId, channel.workspaceId);
    const row = await aiRepo.insert(tx, { workspaceId: channel.workspaceId, channelId, userId, kind: "CHANNEL_SUMMARY" });
    const job: AiProcessJob = {
      kind: "CHANNEL_SUMMARY",
      requestId: row.id,
      userId,
      workspaceId: channel.workspaceId,
      channelId,
      cacheKey,
    };
    await getQueue().sendTx(tx, "ai.process", job);
    return { requestId: row.id, cached: null };
  });
}

export async function requestThreadSummary(
  userId: string,
  channelId: string,
  threadRootId: string,
): Promise<CachedOrQueuedResult> {
  ensureProviderAvailable();
  return withRlsScope({ userId }, async (tx) => {
    const channel = await requireAiEligibleChannel(tx, channelId);
    const root = await messageRepo.findById(tx, threadRootId);
    if (!root || root.channelId !== channelId) {
      throw new NotFoundError("Thread not found");
    }
    if (root.replyCount < THREAD_SUMMARY_MIN_REPLIES) {
      throw new ValidationError(`Thread needs at least ${THREAD_SUMMARY_MIN_REPLIES} replies to summarize`);
    }

    const cacheKey = `thread:${threadRootId}:${root.replyCount}`;
    const cached = await summaryCacheRepo.find(tx, cacheKey);
    if (cached) {
      return { requestId: "", cached: cached.summary };
    }

    await enforceRateCaps(tx, userId, channel.workspaceId);
    const row = await aiRepo.insert(tx, {
      workspaceId: channel.workspaceId,
      channelId,
      threadRootId,
      userId,
      kind: "THREAD_SUMMARY",
    });
    const job: AiProcessJob = {
      kind: "THREAD_SUMMARY",
      requestId: row.id,
      userId,
      workspaceId: channel.workspaceId,
      channelId,
      threadRootId,
      cacheKey,
    };
    await getQueue().sendTx(tx, "ai.process", job);
    return { requestId: row.id, cached: null };
  });
}
