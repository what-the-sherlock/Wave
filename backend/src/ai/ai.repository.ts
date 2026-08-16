import { and, count, eq, gt } from "drizzle-orm";
import type { Tx } from "../db/rlsScope.js";
import { aiRequests } from "../db/schema.js";
import type { AiRequest, NewAiRequest } from "../db/schema.js";

export type { AiRequest, NewAiRequest } from "../db/schema.js";

export async function insert(tx: Tx, data: NewAiRequest): Promise<AiRequest> {
  const [row] = await tx.insert(aiRequests).values(data).returning();
  if (!row) {
    throw new Error("ai_requests insert returned no row");
  }
  return row;
}

export async function findById(tx: Tx, id: string): Promise<AiRequest | undefined> {
  const [row] = await tx.select().from(aiRequests).where(eq(aiRequests.id, id)).limit(1);
  return row;
}

export async function markDone(tx: Tx, id: string, retrievedMessageIds: string[]): Promise<void> {
  await tx
    .update(aiRequests)
    .set({ status: "DONE", retrievedMessageIds, completedAt: new Date() })
    .where(eq(aiRequests.id, id));
}

export async function markFailed(tx: Tx, id: string, error: string): Promise<void> {
  await tx
    .update(aiRequests)
    .set({ status: "FAILED", error: error.slice(0, 500), completedAt: new Date() })
    .where(eq(aiRequests.id, id));
}

/** Per-user hourly cap (docs/ai-architecture.md §5: 20/hour). */
export async function countByUserSince(tx: Tx, userId: string, since: Date): Promise<number> {
  const [row] = await tx
    .select({ n: count() })
    .from(aiRequests)
    .where(and(eq(aiRequests.userId, userId), gt(aiRequests.createdAt, since)));
  return row?.n ?? 0;
}

/** Per-workspace daily cap (docs/ai-architecture.md §5: 500/day). Relies on
 * `ai_requests_select`'s workspace-wide RLS policy — a per-user-scoped
 * policy would undercount every other member's requests. */
export async function countByWorkspaceSince(tx: Tx, workspaceId: string, since: Date): Promise<number> {
  const [row] = await tx
    .select({ n: count() })
    .from(aiRequests)
    .where(and(eq(aiRequests.workspaceId, workspaceId), gt(aiRequests.createdAt, since)));
  return row?.n ?? 0;
}
