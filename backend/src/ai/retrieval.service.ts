import type { Tx } from "../db/rlsScope.js";
import { getEmbedder } from "./embedder.js";
import * as retrievalRepo from "./retrieval.repository.js";
import type { HydratedMessage } from "./retrieval.repository.js";
import type { ContextMessage } from "./aiPrompts.js";

export type { ContextMessage } from "./aiPrompts.js";

// docs/free-tier-plan.md §4's free-tier retrieval budget: fewer chunks,
// tighter neighbours than the paid-plan design (20 chunks / ±3 neighbours).
const MAX_CANDIDATES = 40;
const TOP_K = 10;
const NEIGHBOUR_RADIUS = 1;
// ~6k input tokens, estimated at ~4 chars/token — good enough for a budget
// guard; not used for anything that needs exact counts.
const TOKEN_BUDGET_CHARS = 6000 * 4;

/**
 * docs/ai-architecture.md §3.2's `ask()`, vector-only (lexical/FTS fusion is
 * cut per the roadmap — added later only if the golden-set evaluation shows
 * vector-only misses exact identifiers in practice). Entirely inside the
 * caller's RLS-scoped transaction: no channel list is assembled here, and
 * none is needed — `vectorSearch`/`hydrateNeighbours` are scoped by RLS the
 * same way any other read of `messages` is.
 */
export async function retrieveForQuestion(
  tx: Tx,
  workspaceId: string,
  question: string,
): Promise<ContextMessage[]> {
  const queryEmbedding = await getEmbedder().embed(question);
  const hits = await retrievalRepo.vectorSearch(tx, workspaceId, queryEmbedding, MAX_CANDIDATES);
  const top = hits.slice(0, TOP_K);
  if (top.length === 0) return [];

  const hydrated = await retrievalRepo.hydrateNeighbours(tx, top, NEIGHBOUR_RADIUS);
  const byId = new Map(hydrated.map((m) => [m.id, m]));

  const seen = new Set<string>();
  const ordered: HydratedMessage[] = [];
  let budget = TOKEN_BUDGET_CHARS;

  for (const hit of top) {
    const anchor = byId.get(hit.messageId);
    if (!anchor) continue; // re-authorization: RLS already dropped anything the caller can't see
    const group = hydrated
      .filter((m) => m.channelId === anchor.channelId && Math.abs(m.seq - anchor.seq) <= NEIGHBOUR_RADIUS)
      .sort((a, b) => a.seq - b.seq);
    for (const m of group) {
      if (seen.has(m.id) || !m.body) continue;
      if (ordered.length > 0 && budget - m.body.length < 0) continue;
      seen.add(m.id);
      ordered.push(m);
      budget -= m.body.length;
    }
  }

  return ordered.map((m) => ({ id: m.id, seq: m.seq, senderId: m.senderId, body: m.body, createdAt: m.createdAt }));
}
