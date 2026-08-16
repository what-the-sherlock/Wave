import { sql } from "drizzle-orm";
import type { Tx } from "../db/rlsScope.js";

/** Raw SQL: `message_embeddings.embedding` is a `halfvec`, same reason as
 * embedding.repository.ts. Every function here runs inside the caller's
 * `withRlsScope` transaction — there is no channel/workspace filter beyond
 * `workspace_id` (RLS supplies the rest), per docs/ai-architecture.md §4
 * Rule 1. */

export type VectorHit = { messageId: string; channelId: string; score: number };

function toHalfvecLiteral(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}

/**
 * Postgres array literal, passed as a plain string and cast explicitly
 * (`::uuid[]`) rather than interpolating the JS array directly — this
 * drizzle-orm version's `sql` tag does not reliably bind a JS array as a
 * single array parameter for `= any(...)` (observed: a one-element array
 * arrived at Postgres as a bare scalar, producing "malformed array
 * literal"). Every caller here already early-returns on an empty array, so
 * the `{}` case never reaches this function.
 */
function toUuidArrayLiteral(ids: string[]): string {
  return `{${ids.join(",")}}`;
}

/**
 * `hnsw.ef_search` raised for this transaction only (`set local`) — HNSW is
 * approximate, and when RLS excludes a large fraction of a workspace's rows
 * the index can return its top-k candidates and have most filtered away,
 * under-returning (docs/database-design.md §11's flagged caveat). This is a
 * recall mitigation, not a security one: over-fetching candidates never
 * returns a row RLS wouldn't otherwise allow.
 */
export async function vectorSearch(
  tx: Tx,
  workspaceId: string,
  queryEmbedding: number[],
  limit: number,
): Promise<VectorHit[]> {
  await tx.execute(sql`set local hnsw.ef_search = 200`);
  const vec = toHalfvecLiteral(queryEmbedding);
  const result = await tx.execute<{ message_id: string; channel_id: string; score: number }>(sql`
    select e.message_id, e.channel_id, 1 - (e.embedding <=> ${vec}::halfvec(384)) as score
      from message_embeddings e
     where e.workspace_id = ${workspaceId}
     order by e.embedding <=> ${vec}::halfvec(384)
     limit ${limit}
  `);
  return result.rows.map((r) => ({ messageId: r.message_id, channelId: r.channel_id, score: r.score }));
}

export type HydratedMessage = {
  id: string;
  channelId: string;
  seq: number;
  senderId: string;
  body: string | null;
  createdAt: Date;
};

type RawHydratedRow = {
  id: string;
  channel_id: string;
  seq: number;
  sender_id: string;
  body: string | null;
  // A raw `tx.execute()` result does not go through pg's driver-level
  // timestamptz parser the way a drizzle query-builder read does — this
  // column actually arrives as a Postgres-formatted string
  // ("2026-08-16 20:14:12.271944+00"), not a Date, despite what a naive
  // type declaration would suggest. Mapped to a real `Date` below.
  created_at: string;
};

function rowToHydratedMessage(r: RawHydratedRow): HydratedMessage {
  return {
    id: r.id,
    channelId: r.channel_id,
    seq: r.seq,
    senderId: r.sender_id,
    body: r.body,
    createdAt: new Date(r.created_at),
  };
}

/** ±`radius` messages by `seq`, in the same channel, for each hit — RLS
 * (`msg_select`) filters exactly as it would for any other read of
 * `messages`; nothing here bypasses it. */
export async function hydrateNeighbours(
  tx: Tx,
  hits: { messageId: string; channelId: string }[],
  radius: number,
): Promise<HydratedMessage[]> {
  if (hits.length === 0) return [];
  const messageIds = hits.map((h) => h.messageId);
  const result = await tx.execute<RawHydratedRow>(sql`
    with anchors as (
      select id, channel_id, seq from messages where id = any(${toUuidArrayLiteral(messageIds)}::uuid[])
    )
    select m.id, m.channel_id, m.seq, m.sender_id, m.body, m.created_at
      from messages m
      join anchors a on a.channel_id = m.channel_id and m.seq between a.seq - ${radius} and a.seq + ${radius}
     where m.deleted_at is null
     order by m.channel_id, m.seq
  `);
  return result.rows.map(rowToHydratedMessage);
}

/**
 * Independent re-authorization of cited message ids (docs/ai-
 * architecture.md §4 Rule 4): re-selects through the SAME RLS-scoped
 * transaction the rest of the request ran in, so anything the user cannot
 * read is simply absent from the result — this check does not trust
 * whatever retrieval already assembled.
 */
export async function reauthorizeMessages(tx: Tx, messageIds: string[]): Promise<HydratedMessage[]> {
  if (messageIds.length === 0) return [];
  const result = await tx.execute<RawHydratedRow>(sql`
    select id, channel_id, seq, sender_id, body, created_at
      from messages
     where id = any(${toUuidArrayLiteral(messageIds)}::uuid[]) and deleted_at is null
  `);
  return result.rows.map(rowToHydratedMessage);
}
