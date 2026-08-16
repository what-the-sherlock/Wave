/**
 * Pure, DB-free chunking/eligibility logic (docs/ai-architecture.md §2, §6)
 * — unit-testable without a database, same reasoning as
 * `notificationFanout.worker.ts`'s `resolveCandidates`.
 */
export const TRIVIAL_MIN_LENGTH = 15;
const NEIGHBOUR_SEQ_WINDOW = 3;
const NEIGHBOUR_TIME_WINDOW_MS = 5 * 60_000;
const MAX_CHUNK_CHARS = 2000;

export type ChunkableMessage = {
  id: string;
  seq: number;
  body: string | null;
  createdAt: Date;
};

export function isTrivial(body: string | null): boolean {
  return !body || body.trim().length < TRIVIAL_MIN_LENGTH;
}

export function isEligibleChannel(channel: { type: string; aiExcluded: boolean }): boolean {
  // DMs are excluded from indexing by default (docs/ai-architecture.md §4
  // Rule 6) — the expectation of privacy in a DM differs in kind from a
  // channel, so there is no per-workspace opt-in for it in v1.
  return channel.type !== "DM" && !channel.aiExcluded;
}

/**
 * Builds the text actually embedded for one message: its own body, enriched
 * with nearby context so a message like "yeah let's go with that" isn't
 * embedded meaninglessly alone (docs/ai-architecture.md §6's "highest-
 * leverage tuning knob").
 *
 * Every message still gets exactly one embedding row keyed to its own id —
 * only the *text used to compute that row's vector* is enriched here. This
 * is a deliberate simplification of "thread root + replies as one chunk":
 * merging several messages into a single retrievable/citable row would mean
 * a later reply requires re-embedding an earlier, already-indexed message,
 * and would make a citation ambiguous about which specific message it
 * points to. Keeping one row per message avoids both, at the cost of some
 * redundant text across a thread's embeddings — an acceptable trade at this
 * scale, and the first thing to revisit if retrieval quality demands it.
 */
export function buildChunkText(
  target: ChunkableMessage,
  context: { threadRoot?: ChunkableMessage; neighbours: ChunkableMessage[] },
): string {
  const parts: string[] = [];
  if (context.threadRoot && context.threadRoot.id !== target.id && !isTrivial(context.threadRoot.body)) {
    parts.push(`Thread: ${context.threadRoot.body}`);
  }

  const nearby = context.neighbours
    .filter((m) => m.id !== target.id)
    .filter((m) => Math.abs(m.seq - target.seq) <= NEIGHBOUR_SEQ_WINDOW)
    .filter((m) => Math.abs(m.createdAt.getTime() - target.createdAt.getTime()) <= NEIGHBOUR_TIME_WINDOW_MS)
    .filter((m) => !isTrivial(m.body))
    .sort((a, b) => a.seq - b.seq);
  for (const n of nearby) {
    parts.push(n.body ?? "");
  }

  parts.push(target.body ?? "");
  return parts.join("\n").slice(0, MAX_CHUNK_CHARS);
}
