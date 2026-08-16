-- Phase 7: AI. See docs/ai-architecture.md and docs/database-design.md §11.
-- Local embeddings (Transformers.js, never leaves our infrastructure) +
-- Groq for generation. pgvector under the same RLS as `messages` — the
-- retrieval query has no channel filter of its own, because it needs none.

create extension if not exists "vector";

-- ---------------------------------------------------------------------------
-- message_embeddings
-- ---------------------------------------------------------------------------

create table public.message_embeddings (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  channel_id   uuid not null references public.channels(id)   on delete cascade,
  message_id   uuid not null unique references public.messages(id) on delete cascade,
  chunk_text   text not null,
  -- bge-small-en-v1.5, half precision — 384 dims and halfvec (not vector)
  -- are both binding free-tier storage decisions, not defaults
  -- (docs/free-tier-plan.md §2-3).
  embedding    halfvec(384) not null,
  model        text not null,
  created_at   timestamptz not null default now()
);

alter table public.message_embeddings enable row level security;

-- ★ Same policy as messages' msg_select. This is the whole security
-- argument for putting vectors in Postgres rather than a separate vector
-- DB: a retrieval query that forgets to filter by channel returns nothing,
-- not everything (docs/ai-architecture.md §4 Rule 1). No insert/update/
-- delete policy for `authenticated` — only embedding.worker.ts writes,
-- under withServiceRoleScope (mirrors notificationFanout.worker.ts), so
-- RLS never governs that write path. Deletion cascades via the FK above,
-- so a deleted message's embedding disappears with no cleanup job.
create policy emb_select on public.message_embeddings for select
  using ( public.is_channel_member(channel_id) );

create index emb_hnsw_idx on public.message_embeddings
  using hnsw (embedding halfvec_cosine_ops);
create index emb_channel_idx on public.message_embeddings (channel_id);
-- retrieval.repository.ts filters on workspace_id directly (§3.2) in
-- addition to relying on RLS — this backs that filter and the HNSW
-- recall mitigation in docs/database-design.md §11.
create index emb_workspace_idx on public.message_embeddings (workspace_id);

grant select on public.message_embeddings to authenticated;
-- embedding.worker.ts is the only writer, under service_role
-- (withServiceRoleScope) — explicit because service_role's automatic
-- privileges on a freshly-created table are not reliably SELECT/INSERT
-- out of the box on every Supabase provisioning path (observed on a local
-- `supabase start` stack: service_role held only TRUNCATE/REFERENCES/
-- TRIGGER on every existing public table, not SELECT/INSERT/UPDATE/DELETE,
-- which would silently break notification.fanout and attachment.process
-- the same way). Harmless if the platform already grants this by default.
grant select, insert, update, delete on public.message_embeddings to service_role;

-- ---------------------------------------------------------------------------
-- ai_requests — rate-limit accounting, audit, and retrieval-set logging.
-- Deliberately minimal: no raw question/answer text, just enough to meter
-- usage and diagnose a bad answer after the fact (docs/ai-architecture.md
-- §6's "log the retrieval set alongside each answer").
-- ---------------------------------------------------------------------------

create type public.ai_request_kind as enum ('CHANNEL_SUMMARY', 'THREAD_SUMMARY', 'WORKSPACE_QA');
create type public.ai_request_status as enum ('PENDING', 'DONE', 'FAILED');

create table public.ai_requests (
  id                    uuid primary key default gen_random_uuid(),
  workspace_id          uuid not null references public.workspaces(id) on delete cascade,
  channel_id            uuid references public.channels(id) on delete cascade,
  thread_root_id        uuid references public.messages(id) on delete cascade,
  user_id               uuid not null references public.profiles(id) on delete cascade,
  kind                  public.ai_request_kind not null,
  status                public.ai_request_status not null default 'PENDING',
  retrieved_message_ids uuid[] not null default '{}',
  error                 text,
  created_at            timestamptz not null default now(),
  completed_at          timestamptz
);

create index ai_requests_user_hourly_idx on public.ai_requests (user_id, created_at desc);
create index ai_requests_ws_daily_idx    on public.ai_requests (workspace_id, created_at desc);

alter table public.ai_requests enable row level security;

-- select is workspace-wide (not just the caller's own rows) so a per-
-- workspace daily-cap COUNT(*) can see every member's usage through the
-- requesting member's own RLS scope — no service_role needed anywhere in
-- the ask/summarize path (docs/ai-architecture.md §4 Rule 3). This only
-- exposes usage metadata (kind, status, timestamps) between teammates in
-- the same workspace, never question/answer content, which isn't stored
-- here at all.
create policy ai_requests_select on public.ai_requests for select
  using ( public.is_workspace_member(workspace_id) );

create policy ai_requests_insert on public.ai_requests for insert
  with check ( user_id = (select auth.uid()) and public.is_workspace_member(workspace_id) );

-- ai.worker.ts updates its own row to DONE/FAILED, scoped as the
-- requesting user via withRlsScope — not service_role (docs/ai-
-- architecture.md §4 Rule 4's re-authorization runs in the same scope).
create policy ai_requests_update on public.ai_requests for update
  using ( user_id = (select auth.uid()) )
  with check ( user_id = (select auth.uid()) );

grant select, insert, update on public.ai_requests to authenticated;
-- ai.worker.ts runs under the requesting user's own RLS scope, never
-- service_role, for ai_requests/ai_summary_cache — see ai.worker.ts and
-- docs/ai-architecture.md §4 Rule 3. No service_role grant needed here.

-- ---------------------------------------------------------------------------
-- ai_summary_cache — catch-up and thread summaries, keyed by content hash
-- so two users at the same watermark share one generation
-- (docs/ai-architecture.md §3.1, §3.3, §5).
-- ---------------------------------------------------------------------------

create table public.ai_summary_cache (
  cache_key      text primary key,
  kind           public.ai_request_kind not null,
  channel_id     uuid not null references public.channels(id) on delete cascade,
  thread_root_id uuid references public.messages(id) on delete cascade,
  summary        jsonb not null,
  created_at     timestamptz not null default now()
);

create index ai_summary_cache_channel_idx on public.ai_summary_cache (channel_id);

alter table public.ai_summary_cache enable row level security;

-- Populated by whichever user's request misses the cache, entirely under
-- that user's own RLS scope (is_channel_member), same reasoning as
-- ai_requests above.
create policy ai_summary_cache_rw on public.ai_summary_cache for select
  using ( public.is_channel_member(channel_id) );

create policy ai_summary_cache_insert on public.ai_summary_cache for insert
  with check ( public.is_channel_member(channel_id) );

grant select, insert on public.ai_summary_cache to authenticated;
