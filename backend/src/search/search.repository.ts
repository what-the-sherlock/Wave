import { sql } from "drizzle-orm";
import type { Tx } from "../db/rlsScope.js";

/** Raw row shape from the query below — snake_case, same reason
 * message.repository.ts's RawMessageRow exists: Drizzle's schema.ts has no
 * `search_vector` column builder, so this whole query bypasses the query
 * builder entirely (docs/database-design.md §10). */
type RawSearchRow = {
  id: string;
  channel_id: string;
  seq: number;
  created_at: Date;
  snippet: string;
  rank: number;
};

export type SearchHit = {
  id: string;
  channelId: string;
  seq: number;
  createdAt: Date;
  snippet: string;
  rank: number;
};

function rowToHit(row: RawSearchRow): SearchHit {
  return {
    id: row.id,
    channelId: row.channel_id,
    seq: row.seq,
    createdAt: row.created_at,
    snippet: row.snippet,
    rank: row.rank,
  };
}

/**
 * No channel filter in the query itself — RLS's existing `msg_select`
 * policy (`is_channel_member(channel_id)`) already restricts visible rows,
 * so a query that tried to enumerate the caller's channels here would be
 * redundant with what Postgres already enforces
 * (docs/database-design.md §10).
 */
export async function searchMessages(tx: Tx, workspaceId: string, query: string): Promise<SearchHit[]> {
  const result = await tx.execute<RawSearchRow>(sql`
    select m.id, m.channel_id, m.seq, m.created_at,
           ts_headline('english', m.body, q, 'MaxFragments=2') as snippet,
           ts_rank_cd(m.search_vector, q) as rank
      from messages m, websearch_to_tsquery('english', ${query}) q
     where m.search_vector @@ q
       and m.workspace_id = ${workspaceId}
       and m.deleted_at is null
     order by rank desc, m.created_at desc
     limit 25
  `);
  return result.rows.map(rowToHit);
}
