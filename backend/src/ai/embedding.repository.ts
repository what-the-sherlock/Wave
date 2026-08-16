import { sql } from "drizzle-orm";
import type { Tx } from "../db/rlsScope.js";
import { TRIVIAL_MIN_LENGTH, type ChunkableMessage } from "./chunking.js";

/**
 * Raw SQL throughout: `message_embeddings.embedding` is a `halfvec`, which
 * Drizzle's schema builder has no column type for — same reason
 * `search.repository.ts` bypasses the query builder for `search_vector`
 * (docs/database-design.md §10, §11).
 */
// A raw `tx.execute()` result does not reliably go through pg's driver-
// level timestamptz parser the way a drizzle query-builder read does —
// this column can arrive as a Postgres-formatted string rather than a
// Date. Every row mapper below wraps it in `new Date(...)` defensively
// (harmless if it's already a Date) rather than trusting the type.
type RawUnembeddedRow = {
  id: string;
  seq: number;
  body: string | null;
  thread_root_id: string | null;
  created_at: string | Date;
};

export type PendingMessage = ChunkableMessage & { threadRootId: string | null };

/**
 * Messages in this channel with no embedding row yet, excluding trivial
 * content (< 15 chars) at the SQL level rather than filtering in
 * application code afterward — a trivial message would otherwise never gain
 * an embedding row and would be refetched by every future debounce cycle
 * forever. Deleted messages are excluded; they can never have been
 * embedded in the first place under this same filter.
 */
export async function findUnembeddedMessages(
  tx: Tx,
  channelId: string,
  limit: number,
): Promise<PendingMessage[]> {
  const result = await tx.execute<RawUnembeddedRow>(sql`
    select m.id, m.seq, m.body, m.thread_root_id, m.created_at
      from messages m
      left join message_embeddings e on e.message_id = m.id
     where m.channel_id = ${channelId}
       and e.id is null
       and m.deleted_at is null
       and length(trim(coalesce(m.body, ''))) >= ${TRIVIAL_MIN_LENGTH}
     order by m.seq asc
     limit ${limit}
  `);
  return result.rows.map((r) => ({
    id: r.id,
    seq: r.seq,
    body: r.body,
    createdAt: new Date(r.created_at),
    threadRootId: r.thread_root_id,
  }));
}

type RawContextRow = { id: string; seq: number; body: string | null; created_at: string | Date };

/** Every message in `[minSeq, maxSeq]` for this channel — used to build
 * neighbour context for `buildChunkText` in one query per batch rather than
 * one per message. */
export async function listSeqRange(
  tx: Tx,
  channelId: string,
  minSeq: number,
  maxSeq: number,
): Promise<ChunkableMessage[]> {
  const result = await tx.execute<RawContextRow>(sql`
    select id, seq, body, created_at from messages
     where channel_id = ${channelId} and seq between ${minSeq} and ${maxSeq} and deleted_at is null
     order by seq asc
  `);
  return result.rows.map((r) => ({ id: r.id, seq: r.seq, body: r.body, createdAt: new Date(r.created_at) }));
}

/**
 * Postgres array literal, passed as a plain string and cast explicitly
 * rather than interpolating the JS array directly — see
 * retrieval.repository.ts's `toUuidArrayLiteral` for why.
 */
function toUuidArrayLiteral(ids: string[]): string {
  return `{${ids.join(",")}}`;
}

export async function findByIds(tx: Tx, ids: string[]): Promise<ChunkableMessage[]> {
  if (ids.length === 0) return [];
  const result = await tx.execute<RawContextRow>(sql`
    select id, seq, body, created_at from messages where id = any(${toUuidArrayLiteral(ids)}::uuid[])
  `);
  return result.rows.map((r) => ({ id: r.id, seq: r.seq, body: r.body, createdAt: new Date(r.created_at) }));
}

export type EmbeddingRow = {
  workspaceId: string;
  channelId: string;
  messageId: string;
  chunkText: string;
  embedding: number[];
  model: string;
};

function toHalfvecLiteral(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}

/** `on conflict do nothing` on the `message_id` unique constraint makes a
 * re-run of a partially-completed batch (a worker crash mid-batch, retried
 * by pg-boss) idempotent — every job handler must be, per
 * docs/free-tier-plan.md §5.2. */
export async function insertOne(tx: Tx, row: EmbeddingRow): Promise<void> {
  await tx.execute(sql`
    insert into message_embeddings (workspace_id, channel_id, message_id, chunk_text, embedding, model)
    values (
      ${row.workspaceId}, ${row.channelId}, ${row.messageId}, ${row.chunkText},
      ${toHalfvecLiteral(row.embedding)}::halfvec(384), ${row.model}
    )
    on conflict (message_id) do nothing
  `);
}

/** docs/ai-architecture.md §4 Rule 6: turning AI off for a workspace deletes
 * its existing embeddings, not just stops indexing new ones. */
export async function deleteByWorkspace(tx: Tx, workspaceId: string): Promise<void> {
  await tx.execute(sql`delete from message_embeddings where workspace_id = ${workspaceId}`);
}

/** Same reasoning as `deleteByWorkspace`, applied when a specific channel
 * (e.g. #hr, #legal) is flagged `ai_excluded` after already having indexed
 * content — the exclusion should retroactively stop that content from
 * being retrievable, not just stop future indexing. */
export async function deleteByChannel(tx: Tx, channelId: string): Promise<void> {
  await tx.execute(sql`delete from message_embeddings where channel_id = ${channelId}`);
}
