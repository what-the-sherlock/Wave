/** The `ai.process` job payload — a discriminated union on `kind` so
 * `ai.worker.ts` can dispatch to the right handler with full type safety.
 * Everything the worker needs travels in the payload rather than being
 * re-derived from `ai_requests` at job time, since the payload is already
 * server-generated (never client-supplied) at enqueue time in
 * ai.service.ts. */
export type AiProcessJob =
  | { kind: "WORKSPACE_QA"; requestId: string; userId: string; workspaceId: string; question: string }
  | {
      kind: "CHANNEL_SUMMARY";
      requestId: string;
      userId: string;
      workspaceId: string;
      channelId: string;
      cacheKey: string;
    }
  | {
      kind: "THREAD_SUMMARY";
      requestId: string;
      userId: string;
      workspaceId: string;
      channelId: string;
      threadRootId: string;
      cacheKey: string;
    };
