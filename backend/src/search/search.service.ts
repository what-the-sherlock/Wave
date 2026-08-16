import { withRlsScope } from "../db/rlsScope.js";
import * as searchRepo from "./search.repository.js";
import type { SearchHit } from "./search.repository.js";

export type { SearchHit } from "./search.repository.js";

export async function search(userId: string, workspaceId: string, query: string): Promise<SearchHit[]> {
  return withRlsScope({ userId }, (tx) => searchRepo.searchMessages(tx, workspaceId, query));
}
