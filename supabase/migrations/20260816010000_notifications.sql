-- Phase 5: notifications. See docs/database-design.md §4 and
-- docs/implementation-roadmap.md "Phase 5".

create type public.notification_type as enum
  ('MENTION', 'DM', 'THREAD_REPLY', 'CHANNEL_INVITE', 'WORKSPACE_INVITE', 'SYSTEM');

create table public.notifications (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id      uuid not null references public.profiles(id)   on delete cascade,
  type         public.notification_type not null,
  actor_id     uuid references public.profiles(id) on delete set null,
  channel_id   uuid references public.channels(id) on delete cascade,
  message_id   uuid references public.messages(id) on delete cascade,
  preview      text check (length(preview) <= 200),
  read_at      timestamptz,
  emailed_at   timestamptz,
  created_at   timestamptz not null default now(),

  -- Idempotency backstop for notification.fanout's retries (a pg-boss job
  -- whose worker crashed mid-execution is retried — docs/free-tier-plan.md
  -- §5): re-running the same fan-out for the same message can never create
  -- a second row for the same (user, message, type) triple. See
  -- notification.repository.ts's insertManyIfAbsent.
  unique (user_id, message_id, type)
);

-- Partial: keeps the unread-badge query small regardless of history.
create index notif_unread_idx on public.notifications (user_id, created_at desc) where read_at is null;
create index notif_list_idx   on public.notifications (user_id, workspace_id, created_at desc);

alter table public.notifications enable row level security;

-- Strictly personal — no SECURITY DEFINER helper needed, this is a direct
-- user_id comparison (same shape as reaction_delete in the Phase 3
-- migration). Rows are written by the notification.fanout worker under
-- service_role, which bypasses RLS entirely, so this policy only ever
-- governs the owning user's own reads/writes via the HTTP API.
create policy notif_rw on public.notifications for all
  using      ( user_id = (select auth.uid()) )
  with check ( user_id = (select auth.uid()) );

grant select, insert, update on public.notifications to authenticated;
