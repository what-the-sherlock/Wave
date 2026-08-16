-- Phase 3: channels, messages, threads, reactions, mentions. The core
-- product. See docs/database-design.md §4-9 and docs/implementation-
-- roadmap.md "Phase 3".

create type public.channel_type as enum ('PUBLIC', 'PRIVATE', 'DM');
create type public.channel_role as enum ('ADMIN', 'MEMBER');
create type public.mention_kind as enum ('USER', 'CHANNEL');

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table public.channels (
  id               uuid primary key default gen_random_uuid(),
  workspace_id     uuid not null references public.workspaces(id) on delete cascade,
  -- `-` last in the bracket expression, not between `9` and `_` — Postgres
  -- (and most regex engines) parses a `-` immediately after a range like
  -- `0-9` as the start of *another* range rather than a literal hyphen,
  -- which made the pattern as originally written throw "invalid character
  -- range" the first time a channel was actually created.
  name             text check (name ~ '^[a-z0-9_-]{1,80}$'),
  type             public.channel_type not null,
  topic            text check (length(topic) <= 250),
  description      text check (length(description) <= 1000),
  created_by       uuid references public.profiles(id),
  last_message_seq bigint not null default 0,
  last_message_at  timestamptz,
  member_count     int not null default 0,
  dm_key           text,
  ai_excluded      boolean not null default false,
  archived_at      timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create trigger channels_set_updated_at
  before update on public.channels
  for each row execute function public.set_updated_at();

-- named channels are unique per workspace; DMs are unique per participant set
create unique index channels_ws_name_uidx on public.channels (workspace_id, name)
  where type in ('PUBLIC', 'PRIVATE');
create unique index channels_dm_key_uidx on public.channels (workspace_id, dm_key)
  where dm_key is not null;

create table public.channel_members (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references public.workspaces(id) on delete cascade,
  channel_id    uuid not null references public.channels(id)   on delete cascade,
  user_id       uuid not null references public.profiles(id)   on delete cascade,
  role          public.channel_role not null default 'MEMBER',
  last_read_seq bigint not null default 0,
  last_read_at  timestamptz,
  muted_until   timestamptz,
  joined_at     timestamptz not null default now(),
  unique (channel_id, user_id)
);

create table public.messages (
  id             uuid primary key default gen_random_uuid(),
  workspace_id   uuid not null references public.workspaces(id) on delete cascade,
  channel_id     uuid not null references public.channels(id)   on delete cascade,
  seq            bigint not null,
  sender_id      uuid not null references public.profiles(id),
  body           text check (length(body) <= 8000),
  client_msg_id  uuid not null,
  thread_root_id uuid references public.messages(id) on delete cascade,
  reply_count    int not null default 0,
  last_reply_at  timestamptz,
  edited_at      timestamptz,
  deleted_at     timestamptz,
  deleted_by     uuid references public.profiles(id),
  created_at     timestamptz not null default now(),

  search_vector  tsvector generated always as
                   (to_tsvector('english', coalesce(body, ''))) stored,

  unique (channel_id, seq),
  unique (channel_id, client_msg_id)
);

create table public.message_reactions (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  channel_id   uuid not null references public.channels(id)   on delete cascade,
  message_id   uuid not null references public.messages(id)   on delete cascade,
  user_id      uuid not null references public.profiles(id)   on delete cascade,
  emoji        text not null check (length(emoji) <= 64),
  created_at   timestamptz not null default now(),
  unique (message_id, user_id, emoji)
);

create table public.message_mentions (
  id                uuid primary key default gen_random_uuid(),
  workspace_id      uuid not null references public.workspaces(id) on delete cascade,
  channel_id        uuid not null references public.channels(id)   on delete cascade,
  message_id        uuid not null references public.messages(id)   on delete cascade,
  mentioned_user_id uuid references public.profiles(id) on delete cascade,
  kind              public.mention_kind not null
);

-- ---------------------------------------------------------------------------
-- Indexes — every policy predicate and hot query path (docs/database-design.md §6)
-- ---------------------------------------------------------------------------

create index cm_user_ws_idx on public.channel_members (user_id, workspace_id);
create index cm_channel_idx on public.channel_members (channel_id);

-- ★ THE index: every scrollback read
create index msg_channel_seq_idx on public.messages (channel_id, seq desc)
  where deleted_at is null;
create index msg_thread_idx on public.messages (thread_root_id, seq)
  where thread_root_id is not null;
create index msg_sender_idx on public.messages (workspace_id, sender_id, created_at desc);

-- full-text search — ready for Phase 6 at zero extra migration cost
create extension if not exists "pg_trgm";
create index msg_search_idx on public.messages using gin (search_vector);
create index msg_trgm_idx on public.messages using gin (body gin_trgm_ops);

create index mention_user_idx on public.message_mentions (mentioned_user_id, workspace_id);
create index reaction_msg_idx on public.message_reactions (message_id);

create index ch_ws_type_idx on public.channels (workspace_id, type) where archived_at is null;

-- ---------------------------------------------------------------------------
-- SECURITY DEFINER helpers
-- ---------------------------------------------------------------------------

create function public.is_channel_member(_channel_id uuid)
returns boolean
language sql
security definer
set search_path = ''
stable
as $$
  select exists (
    select 1 from public.channel_members c
    where c.channel_id = _channel_id and c.user_id = (select auth.uid())
  );
$$;

-- public channels are visible to the whole workspace even before joining
create function public.can_read_channel(_channel_id uuid)
returns boolean
language sql
security definer
set search_path = ''
stable
as $$
  select exists (
    select 1 from public.channels ch
    where ch.id = _channel_id
      and ( public.is_channel_member(ch.id)
            or (ch.type = 'PUBLIC' and public.is_workspace_member(ch.workspace_id)) )
  );
$$;

create function public.channel_role_of(_channel_id uuid)
returns public.channel_role
language sql
security definer
set search_path = ''
stable
as $$
  select c.role from public.channel_members c
  where c.channel_id = _channel_id and c.user_id = (select auth.uid());
$$;

revoke execute on function public.is_channel_member(uuid) from public;
grant  execute on function public.is_channel_member(uuid) to authenticated;
revoke execute on function public.can_read_channel(uuid) from public;
grant  execute on function public.can_read_channel(uuid) to authenticated;
revoke execute on function public.channel_role_of(uuid) from public;
grant  execute on function public.channel_role_of(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Row-Level Security
-- ---------------------------------------------------------------------------

alter table public.channels          enable row level security;
alter table public.channel_members   enable row level security;
alter table public.messages          enable row level security;
alter table public.message_reactions enable row level security;
alter table public.message_mentions  enable row level security;

-- channels: public channels are discoverable, private ones are invisible.
--
-- The `created_by`/`dm_key` clauses are not redundant with
-- can_read_channel(): Postgres RLS re-checks the SELECT policy for an
-- INSERT ... RETURNING row (docs/implementation-roadmap.md Phase 2 plan,
-- "the RETURNING re-check"), and at the moment of a PRIVATE or DM channel's
-- own creation — before its first channel_members row exists in the same
-- transaction — is_channel_member() has nothing to find and there is no
-- workspace-wide PUBLIC fallback for can_read_channel() to use instead.
create policy ch_select on public.channels for select
  using (
    public.can_read_channel(id)
    or created_by = (select auth.uid())
    or (
      type = 'DM'
      and (select auth.uid())::text in (split_part(dm_key, ':', 1), split_part(dm_key, ':', 2))
    )
  );

create policy ch_insert on public.channels for insert
  with check ( public.is_workspace_member(workspace_id) );

create policy ch_update on public.channels for update
  using (
    public.is_channel_member(id)
    or public.workspace_role_of(workspace_id) in ('OWNER', 'ADMIN')
  );

-- channel_members
create policy cm_select on public.channel_members for select
  using ( public.can_read_channel(channel_id) );

-- Three cases, the last two being bootstrap allowances of the same class as
-- workspace_members' wm_insert_bootstrap (docs/implementation-roadmap.md
-- Phase 2 plan): can_read_channel() alone cannot cover a PRIVATE channel's
-- or a DM's very first membership row, because with zero members yet,
-- is_channel_member() is false and (for non-PUBLIC channels) there is no
-- workspace-wide fallback.
create policy cm_insert on public.channel_members for insert
  with check (
    -- normal case: public channels (workspace-wide), or already a member
    public.can_read_channel(channel_id)
    -- bootstrap: a PRIVATE (or PUBLIC) channel's own creator, once, before
    -- any member row exists
    or exists (
      select 1 from public.channels c
      where c.id = channel_id
        and c.created_by = (select auth.uid())
        and not exists (
          select 1 from public.channel_members m2 where m2.channel_id = c.id
        )
    )
    -- bootstrap: either DM participant may insert either of the two
    -- membership rows (both happen in one transaction, from one connection,
    -- under the initiating user's auth.uid() — see channel.service.ts's
    -- getOrCreateDm) while the channel has fewer than its 2 members
    or exists (
      select 1 from public.channels c
      where c.id = channel_id
        and c.type = 'DM'
        and (select auth.uid())::text in (split_part(c.dm_key, ':', 1), split_part(c.dm_key, ':', 2))
        and (select count(*) from public.channel_members m2 where m2.channel_id = c.id) < 2
    )
  );

-- own read watermark / mute preference, or a channel admin / workspace admin managing others
create policy cm_update on public.channel_members for update
  using (
    user_id = (select auth.uid())
    or public.channel_role_of(channel_id) = 'ADMIN'
    or public.workspace_role_of(workspace_id) in ('OWNER', 'ADMIN')
  )
  with check (
    user_id = (select auth.uid())
    or public.channel_role_of(channel_id) = 'ADMIN'
    or public.workspace_role_of(workspace_id) in ('OWNER', 'ADMIN')
  );

create policy cm_delete on public.channel_members for delete
  using (
    user_id = (select auth.uid())
    or public.channel_role_of(channel_id) = 'ADMIN'
    or public.workspace_role_of(workspace_id) in ('OWNER', 'ADMIN')
  );

-- messages ★ the policy that carries the most weight. Note msg_select uses
-- is_channel_member, not can_read_channel: a public channel is discoverable
-- without joining, but its messages require membership — browsing a public
-- channel joins you to it (docs/database-design.md §5.2).
create policy msg_select on public.messages for select
  using ( public.is_channel_member(channel_id) );

create policy msg_insert on public.messages for insert
  with check (
    public.is_channel_member(channel_id)
    and sender_id = (select auth.uid())
  );

create policy msg_update on public.messages for update
  using (
    sender_id = (select auth.uid())
    or public.workspace_role_of(workspace_id) in ('OWNER', 'ADMIN')
  );

-- reactions: any channel member may react; only the reactor may un-react
create policy reaction_select on public.message_reactions for select
  using ( public.is_channel_member(channel_id) );

create policy reaction_insert on public.message_reactions for insert
  with check (
    public.is_channel_member(channel_id)
    and user_id = (select auth.uid())
  );

create policy reaction_delete on public.message_reactions for delete
  using ( user_id = (select auth.uid()) );

-- mentions: readable by anyone who can read the message. Written by
-- message.service.ts in a follow-up insert after send_message() succeeds
-- (mention targets come from the client's autocomplete selection, not
-- server-side text parsing — see message.service.ts), scoped by the same
-- RLS transaction, so this policy applies to that insert too.
create policy mention_select on public.message_mentions for select
  using ( public.is_channel_member(channel_id) );

create policy mention_insert on public.message_mentions for insert
  with check ( public.is_channel_member(channel_id) );

-- ---------------------------------------------------------------------------
-- send_message(): the single-statement atomic, idempotent insert with
-- sequence assignment (docs/database-design.md §7). `security invoker` —
-- unlike the Phase 2 SECURITY DEFINER functions — so RLS still applies to
-- the insert itself; the function's only privileged behaviour is the
-- channel's own row lock via UPDATE, which every channel member may do
-- (msg_insert's WITH CHECK still gates who may actually get a row in).
-- ---------------------------------------------------------------------------

create function public.send_message(
  _channel_id uuid,
  _body text,
  _client_msg_id uuid,
  _thread_root_id uuid default null
)
returns public.messages
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_row public.messages%rowtype;
  v_seq bigint;
  v_ws  uuid;
begin
  -- Fast path: this retry already succeeded. A retry never burns a
  -- sequence number, because the whole check happens before the counter
  -- bump below.
  select * into v_row from public.messages
   where channel_id = _channel_id and client_msg_id = _client_msg_id;
  if found then
    return v_row;
  end if;

  select workspace_id into v_ws from public.channels where id = _channel_id;
  if v_ws is null then
    raise exception 'channel_not_found' using errcode = 'P0002';
  end if;

  update public.channels
     set last_message_seq = last_message_seq + 1, last_message_at = now()
   where id = _channel_id
  returning last_message_seq into v_seq;

  insert into public.messages
    (workspace_id, channel_id, seq, sender_id, body, client_msg_id, thread_root_id)
  values
    (v_ws, _channel_id, v_seq, (select auth.uid()), _body, _client_msg_id, _thread_root_id)
  returning * into v_row;

  if _thread_root_id is not null then
    update public.messages
       set reply_count = reply_count + 1, last_reply_at = now()
     where id = _thread_root_id;
  end if;

  return v_row;
exception when unique_violation then
  -- A concurrent retry of the same client_msg_id won the race. The
  -- preceding counter bump and insert attempt roll back to this block's
  -- implicit savepoint, so no sequence number is burned.
  select * into v_row from public.messages
   where channel_id = _channel_id and client_msg_id = _client_msg_id;
  return v_row;
end;
$$;

revoke execute on function public.send_message(uuid, text, uuid, uuid) from public;
grant  execute on function public.send_message(uuid, text, uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

grant select, insert, update on public.channels to authenticated;
grant select, insert, update, delete on public.channel_members to authenticated;
-- send_message() is `security invoker` (RLS must still apply to the
-- insert), which means it does NOT run with elevated privileges the way a
-- SECURITY DEFINER function would — the calling `authenticated` role still
-- needs its own base grant, same as any other insert.
grant select, insert, update on public.messages to authenticated;
grant select, insert, delete on public.message_reactions to authenticated;
grant select, insert on public.message_mentions to authenticated;
