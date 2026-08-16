import { and, eq, gt } from "drizzle-orm";
import type { Tx } from "../db/rlsScope.js";
import { aiSummaryCache } from "../db/schema.js";
import type { AiSummaryCacheRow, AiSummaryPayload } from "../db/schema.js";

export type { AiSummaryCacheRow, AiSummaryPayload } from "../db/schema.js";

/**
 * Content-hash caching (docs/ai-architecture.md §3.1, §3.3, §5): two users
 * hitting the same cache key share one generation, which on a free tier
 * protects a daily request quota rather than a bill — more important, not
 * less, than it would be on a paid plan.
 *
 * `freshAfter` backs the catch-up summary's 1h TTL (docs/ai-architecture.md
 * §3.1); thread summaries pass nothing — the cache key already includes
 * `reply_count`, so a growing thread naturally misses on its own without a
 * time limit (§3.3).
 */
export async function find(tx: Tx, cacheKey: string, freshAfter?: Date): Promise<AiSummaryCacheRow | undefined> {
  const [row] = await tx
    .select()
    .from(aiSummaryCache)
    .where(
      freshAfter
        ? and(eq(aiSummaryCache.cacheKey, cacheKey), gt(aiSummaryCache.createdAt, freshAfter))
        : eq(aiSummaryCache.cacheKey, cacheKey),
    )
    .limit(1);
  return row;
}

export async function upsert(
  tx: Tx,
  row: { cacheKey: string; kind: AiSummaryCacheRow["kind"]; channelId: string; threadRootId: string | null; summary: AiSummaryPayload },
): Promise<void> {
  await tx
    .insert(aiSummaryCache)
    .values(row)
    .onConflictDoNothing({ target: aiSummaryCache.cacheKey });
}
