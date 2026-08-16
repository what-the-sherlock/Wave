import { withServiceRoleScope } from "../db/rlsScope.js";
import { config } from "../config/env.js";
import { logger } from "../logging/logger.js";
import { getQueue } from "../queue/index.js";
import { getEmbedder } from "./embedder.js";
import { buildChunkText, isEligibleChannel } from "./chunking.js";
import * as channelRepo from "../channels/channel.repository.js";
import * as workspaceRepo from "../workspaces/workspace.repository.js";
import * as embeddingRepo from "./embedding.repository.js";

const BATCH_SIZE = 100;
const NEIGHBOUR_FETCH_MARGIN = 3;

/**
 * `embedding.generate` job handler — enqueued (debounced 30s via
 * `singletonKey`+`startAfterSeconds`) from `message.service.ts`'s
 * `sendMessage`. Runs under `withServiceRoleScope`: there is no requesting
 * user at index time, so RLS has nothing to scope against — the same
 * bounded, deliberate bypass `notificationFanout.worker.ts` uses
 * (docs/security-model.md §5). The *read* half of the AI pipeline never
 * uses service_role — only this write path does.
 */
export async function embeddingGenerateHandler(data: { channelId: string }): Promise<void> {
  await withServiceRoleScope(async (tx) => {
    const channel = await channelRepo.findById(tx, data.channelId);
    if (!channel) return;

    const workspace = await workspaceRepo.findById(tx, channel.workspaceId);
    if (!workspace || !workspace.settings.aiEnabled) return;
    if (!isEligibleChannel(channel)) return;

    const pending = await embeddingRepo.findUnembeddedMessages(tx, channel.id, BATCH_SIZE);
    if (pending.length === 0) return;

    const minSeq = Math.min(...pending.map((m) => m.seq)) - NEIGHBOUR_FETCH_MARGIN;
    const maxSeq = Math.max(...pending.map((m) => m.seq)) + NEIGHBOUR_FETCH_MARGIN;
    const neighbours = await embeddingRepo.listSeqRange(tx, channel.id, minSeq, maxSeq);

    const rootIds = [...new Set(pending.map((m) => m.threadRootId).filter((id): id is string => id !== null))];
    const roots = rootIds.length > 0 ? await embeddingRepo.findByIds(tx, rootIds) : [];
    const rootById = new Map(roots.map((r) => [r.id, r]));

    const texts = pending.map((m) =>
      buildChunkText(m, { threadRoot: m.threadRootId ? rootById.get(m.threadRootId) : undefined, neighbours }),
    );

    const embedder = getEmbedder();
    const vectors = await embedder.embedBatch(texts);

    for (let i = 0; i < pending.length; i++) {
      const message = pending[i]!;
      await embeddingRepo.insertOne(tx, {
        workspaceId: channel.workspaceId,
        channelId: channel.id,
        messageId: message.id,
        chunkText: texts[i]!,
        embedding: vectors[i]!,
        model: config.EMBEDDING_MODEL,
      });
    }

    logger.info({ channelId: channel.id, count: pending.length }, "embedding.generate: batch indexed");

    // The batch was full — there may be more backlog. Re-enqueue with no
    // debounce delay to drain it, rather than waiting for the next message
    // to arrive in this channel.
    if (pending.length === BATCH_SIZE) {
      await getQueue().send("embedding.generate", { channelId: channel.id }, { singletonKey: channel.id });
    }
  });
}
