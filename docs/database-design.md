# wave — Database Design (Supabase / Postgres)

> Decision and trade-offs: [target-architecture.md](./target-architecture.md) §3.
> **Supabase Postgres as primary — with RLS, `tsvector` FTS, `pgvector`, and Storage.
> Redis for ephemeral coordination from Phase 4.**
> Greenfield: there is no data to migrate.

---

## 1. Principles

1. **RLS is the isolation mechanism, not a convention.** Every tenant-scoped table has policies.
   A query that forgets its filter returns zero rows, not another workspace's data.
2. **Every tenant-scoped table carries `workspace_id`, even when derivable.** `messages` has both
   `channel_id` and `workspace_id`. The redundancy makes every policy and index workspace-first
   and keeps a missing scope visible in review.
3. **Normalize.** Reactions, mentions, and attachments are tables, not JSON columns — they need
   indexes and referential integrity. `settings` is JSONB because it genuinely is unstructured.
4. **Soft-delete user-visible content, cascade-delete derived data.** Messages are tombstoned;
   embeddings and attachments cascade.
5. **Denormalize counters, never truth.** `last_message_seq` and `reply_count` are maintained;
   membership never is.
6. **Policy predicates are indexed.** An RLS policy runs per row — an unindexed predicate turns
   every query into a scan.

---

## 2. Entity relationships

```text
auth.users (Supabase)
     │ 1:1 (trigger on insert)
     ▼
  profiles ──────< workspace_members >────── workspaces
     │              role, deactivated_at         │
     │                                           ├──< invites
     │                                           │
     │                                           └──< channels
     │                                                  │
     ├──< channel_members >─────────────────────────────┤
     │      last_read_seq (unread watermark)             │
     │                                                   │
     ├──< messages >─────────────────────────────────────┘
     │      ├──< message_reactions
     │      ├──< message_mentions
     │      ├──< message_attachments
     │      ├──< message_embeddings   (pgvector)
     │      └──  thread_root_id → messages.id  (self-ref)
     │
     └──< notifications
```

---

## 3. Extensions, enums, and identity

```sql
create extension if not exists "pgcrypto";   -- gen_random_uuid()
create extension if not exists "pg_trgm";    -- fuzzy search
create extension if not exists "vector";     -- pgvector (Phase 7)

create type workspace_role     as enum ('OWNER','ADMIN','MEMBER');
create type channel_role       as enum ('ADMIN','MEMBER');
create type channel_type       as enum ('PUBLIC','PRIVATE','DM');
create type notification_type  as enum ('MENTION','DM','THREAD_REPLY','CHANNEL_INVITE',
                                        'WORKSPACE_INVITE','SYSTEM');
create type mention_kind       as enum ('USER','CHANNEL');
```

**Scope note.** `GUEST`, `GROUP_DM`, `EVERYONE` mentions, `notification_pref`, and `scan_status`
were cut for v1 ([implementation-roadmap.md](./implementation-roadmap.md), "Scope discipline").
Each is one `alter type ... add value` away — Postgres enums extend without a table rewrite,
which is exactly why these were safe to cut rather than build defensively.

A group DM is a private channel. A guest is a member of the one channel they were invited to.

### `profiles`

Supabase owns identity in `auth.users`. Application-level user data lives in a `profiles` table
keyed by the same UUID, populated by a trigger so a profile always exists.

```sql
create table profiles (
  id                 uuid primary key references auth.users(id) on delete cascade,
  full_name          text not null check (length(full_name) between 1 and 80),
  avatar_url         text,
  timezone           text not null default 'UTC',
  status_emoji       text,
  status_text        text check (length(status_text) <= 100),
  status_expires_at  timestamptz,
  last_seen_at       timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create function handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, full_name)
  values (new.id, coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email,'@',1)));
  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users for each row execute function handle_new_user();
```

**Email, password hashing, verification, and reset all live in `auth.users`** — we never store
or handle a password. This is the concrete payoff of the Supabase Auth decision, and it removes
the entire class of bugs the original code had around it (D10, weak `minlength`, dead schema
validators).

`set search_path = ''` on a `SECURITY DEFINER` function is mandatory, not stylistic: without it
a caller can shadow `public` and hijack execution as the function owner.

---

## 4. Core tables

```sql
create table workspaces (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (length(name) between 1 and 80),
  slug        text not null unique check (slug ~ '^[a-z0-9-]{3,32}$'),
  icon_url    text,
  owner_id    uuid not null references profiles(id),
  settings    jsonb not null default '{
                "allowPublicInvites": false,
                "aiEnabled": true
              }'::jsonb,
  member_count int not null default 0,          -- denormalized, eventually consistent
  archived_at timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table workspace_members (
  id             uuid primary key default gen_random_uuid(),
  workspace_id   uuid not null references workspaces(id) on delete cascade,
  user_id        uuid not null references profiles(id)   on delete cascade,
  role           workspace_role not null default 'MEMBER',
  display_name   text,
  invited_by     uuid references profiles(id),
  joined_at      timestamptz not null default now(),
  deactivated_at timestamptz,                   -- soft removal preserves authorship
  unique (workspace_id, user_id)
);

create table channels (
  id                uuid primary key default gen_random_uuid(),
  workspace_id      uuid not null references workspaces(id) on delete cascade,
  name              text check (name ~ '^[a-z0-9-_]{1,80}$'),
  type              channel_type not null,
  topic             text check (length(topic) <= 250),
  description       text check (length(description) <= 1000),
  created_by        uuid references profiles(id),
  last_message_seq  bigint not null default 0,   -- monotonic counter, §7
  last_message_at   timestamptz,
  member_count      int not null default 0,
  dm_key            text,                        -- DM only: sorted user ids joined by ':'
  ai_excluded       boolean not null default false,
  archived_at       timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- named channels are unique per workspace; DMs are unique per participant set
create unique index channels_ws_name_uidx on channels (workspace_id, name)
  where type in ('PUBLIC','PRIVATE');
create unique index channels_dm_key_uidx  on channels (workspace_id, dm_key)
  where dm_key is not null;

create table channel_members (
  id                uuid primary key default gen_random_uuid(),
  workspace_id      uuid not null references workspaces(id) on delete cascade,
  channel_id        uuid not null references channels(id)   on delete cascade,
  user_id           uuid not null references profiles(id)   on delete cascade,
  role              channel_role not null default 'MEMBER',
  last_read_seq     bigint not null default 0,   -- unread watermark, §8
  last_read_at      timestamptz,
  muted_until       timestamptz,                 -- mute is the only pref in v1
  joined_at         timestamptz not null default now(),
  unique (channel_id, user_id)
);

create table messages (
  id             uuid primary key default gen_random_uuid(),
  workspace_id   uuid not null references workspaces(id) on delete cascade,
  channel_id     uuid not null references channels(id)   on delete cascade,
  seq            bigint not null,
  sender_id      uuid not null references profiles(id),
  body           text check (length(body) <= 8000),
  client_msg_id  uuid not null,                 -- idempotency key, §9
  thread_root_id uuid references messages(id) on delete cascade,
  reply_count    int not null default 0,
  last_reply_at  timestamptz,
  edited_at      timestamptz,
  deleted_at     timestamptz,
  deleted_by     uuid references profiles(id),
  created_at     timestamptz not null default now(),

  search_vector  tsvector generated always as
                   (to_tsvector('english', coalesce(body,''))) stored,

  unique (channel_id, seq),
  unique (channel_id, client_msg_id)
);
```

A **generated** `search_vector` column is always consistent with `body` — no trigger to write,
no drift, no reindex job. Editing a message updates the index in the same statement.

```sql
create table message_reactions (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  channel_id   uuid not null references channels(id)   on delete cascade,
  message_id   uuid not null references messages(id)   on delete cascade,
  user_id      uuid not null references profiles(id)   on delete cascade,
  emoji        text not null check (length(emoji) <= 64),
  created_at   timestamptz not null default now(),
  unique (message_id, user_id, emoji)   -- toggling is naturally idempotent
);

create table message_mentions (
  id                uuid primary key default gen_random_uuid(),
  workspace_id      uuid not null references workspaces(id) on delete cascade,
  channel_id        uuid not null references channels(id)   on delete cascade,
  message_id        uuid not null references messages(id)   on delete cascade,
  mentioned_user_id uuid references profiles(id) on delete cascade,
  kind              mention_kind not null
);

create table message_attachments (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  channel_id   uuid not null references channels(id)   on delete cascade,
  message_id   uuid references messages(id) on delete cascade,   -- null until attached
  uploaded_by  uuid not null references profiles(id),
  storage_path text not null unique,
  name         text not null,
  mime_type    text not null,
  size_bytes   bigint not null,
  width        int,
  height       int,
  thumb_path   text,
  created_at   timestamptz not null default now()
);

create table notifications (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  user_id      uuid not null references profiles(id)   on delete cascade,
  type         notification_type not null,
  actor_id     uuid references profiles(id) on delete set null,
  channel_id   uuid references channels(id) on delete cascade,
  message_id   uuid references messages(id) on delete cascade,
  preview      text check (length(preview) <= 200),
  read_at      timestamptz,
  emailed_at   timestamptz,
  created_at   timestamptz not null default now()
);

create table invites (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  email        citext,                             -- null for shareable links
  token_hash   text not null unique,               -- sha256. never store the raw token
  role         workspace_role not null default 'MEMBER',
  channel_ids  uuid[] not null default '{}',
  invited_by   uuid not null references profiles(id),
  max_uses     int not null default 1,
  use_count    int not null default 0,
  expires_at   timestamptz not null,
  revoked_at   timestamptz,
  created_at   timestamptz not null default now()
);
```

---

## 5. Row-Level Security

The centre of the design. **This is what the MongoDB plan could not provide**, and the reason
for the stack change.

### 5.1 The recursion trap, and the fix

The obvious policy on `workspace_members` — *"you can see members of workspaces you belong to"* —
queries `workspace_members` from inside a `workspace_members` policy. Postgres recurses until it
errors. This is the single most common Supabase RLS mistake and it appears the moment Phase 2
starts.

The fix is `SECURITY DEFINER` helper functions. They run as the owner, which bypasses RLS, so
the policy's own lookup does not re-enter the policy:

```sql
create function public.is_workspace_member(_workspace_id uuid)
returns boolean language sql security definer set search_path = '' stable as $$
  select exists (
    select 1 from public.workspace_members m
    where m.workspace_id = _workspace_id
      and m.user_id = (select auth.uid())
      and m.deactivated_at is null
  );
$$;

create function public.workspace_role_of(_workspace_id uuid)
returns public.workspace_role language sql security definer set search_path = '' stable as $$
  select m.role from public.workspace_members m
  where m.workspace_id = _workspace_id
    and m.user_id = (select auth.uid())
    and m.deactivated_at is null;
$$;

create function public.is_channel_member(_channel_id uuid)
returns boolean language sql security definer set search_path = '' stable as $$
  select exists (
    select 1 from public.channel_members c
    where c.channel_id = _channel_id
      and c.user_id = (select auth.uid())
  );
$$;

-- public channels are visible to the whole workspace even before joining
create function public.can_read_channel(_channel_id uuid)
returns boolean language sql security definer set search_path = '' stable as $$
  select exists (
    select 1 from public.channels ch
    where ch.id = _channel_id
      and ( public.is_channel_member(ch.id)
            or (ch.type = 'PUBLIC' and public.is_workspace_member(ch.workspace_id)) )
  );
$$;

revoke execute on function public.is_workspace_member(uuid) from public;
grant   execute on function public.is_workspace_member(uuid) to authenticated;
-- (same revoke/grant for each helper)
```

Two details that are not optional:

- **`(select auth.uid())`, not bare `auth.uid()`.** Wrapping it in a subquery makes Postgres
  evaluate it once as an InitPlan instead of once per row. On a 10,000-row scan this is the
  difference between a fast query and a visibly slow one. It is the highest-value single
  optimization in the whole schema.
- **`stable`** lets the planner cache the result within a statement.

### 5.2 Policies

```sql
alter table workspaces        enable row level security;
alter table workspace_members enable row level security;
alter table channels          enable row level security;
alter table channel_members   enable row level security;
alter table messages          enable row level security;
alter table message_reactions enable row level security;
alter table message_mentions  enable row level security;
alter table message_attachments enable row level security;
alter table notifications     enable row level security;
alter table invites           enable row level security;
alter table profiles          enable row level security;

-- workspaces
create policy ws_select on workspaces for select
  using ( public.is_workspace_member(id) );
create policy ws_update on workspaces for update
  using ( public.workspace_role_of(id) in ('OWNER','ADMIN') );
create policy ws_insert on workspaces for insert
  with check ( owner_id = (select auth.uid()) );

-- workspace_members  (helper breaks the recursion)
create policy wm_select on workspace_members for select
  using ( public.is_workspace_member(workspace_id) );
create policy wm_write  on workspace_members for all
  using      ( public.workspace_role_of(workspace_id) in ('OWNER','ADMIN') )
  with check ( public.workspace_role_of(workspace_id) in ('OWNER','ADMIN') );

-- channels: public channels are discoverable, private ones are invisible
create policy ch_select on channels for select
  using ( public.can_read_channel(id) );
create policy ch_insert on channels for insert
  with check ( public.is_workspace_member(workspace_id) );
create policy ch_update on channels for update
  using ( public.is_channel_member(id)
          or public.workspace_role_of(workspace_id) in ('OWNER','ADMIN') );

-- channel_members
create policy cm_select on channel_members for select
  using ( public.can_read_channel(channel_id) );
create policy cm_insert on channel_members for insert
  with check ( public.can_read_channel(channel_id) );
create policy cm_update on channel_members for update      -- own read watermark, prefs
  using ( user_id = (select auth.uid()) );

-- messages  ★ the policy that carries the most weight
create policy msg_select on messages for select
  using ( public.is_channel_member(channel_id) );
create policy msg_insert on messages for insert
  with check ( public.is_channel_member(channel_id)
               and sender_id = (select auth.uid()) );
create policy msg_update on messages for update
  using ( sender_id = (select auth.uid())
          or public.workspace_role_of(workspace_id) in ('OWNER','ADMIN') );

-- notifications are strictly personal
create policy notif_rw on notifications for all
  using ( user_id = (select auth.uid()) );

-- invites: only admins may read them; acceptance goes through a SECURITY DEFINER function
create policy inv_admin on invites for all
  using ( public.workspace_role_of(workspace_id) in ('OWNER','ADMIN') );

-- profiles: visible to people you share a workspace with
create policy prof_select on profiles for select
  using ( id = (select auth.uid()) or exists (
    select 1 from public.workspace_members a
    join public.workspace_members b using (workspace_id)
    where a.user_id = (select auth.uid()) and b.user_id = profiles.id
  ));
create policy prof_update on profiles for update
  using ( id = (select auth.uid()) );
```

Note `msg_select` uses `is_channel_member`, not `can_read_channel`: a public channel is
*discoverable* without joining, but its **messages** require membership. Browsing a public
channel joins you to it — an explicit product decision, encoded in the policy.

### 5.3 What RLS does and does not cover

- **Covers:** every `select`/`insert`/`update`/`delete` issued by the API under the
  `authenticated` role, including FTS queries, vector searches, and joins. Isolation is
  transitive and automatic.
- **Does not cover:** the `service_role` key, which bypasses RLS entirely. Used only by the
  worker and migrations, never on an HTTP request path
  ([target-architecture.md](./target-architecture.md) §7).
- **Does not replace** permission checks for *actions* (who may archive a channel, change a
  role, invite). RLS answers "which rows exist for you"; the permission table answers "what may
  you do" ([security-model.md](./security-model.md) §4).

RLS is not client-facing protection here — no browser holds a database connection. **It is
protection for our own backend against its own bugs.**

---

## 6. Indexes

Every policy predicate and every hot query path.

```sql
-- membership: drives every RLS helper. the most-executed lookups in the system
create index wm_user_ws_idx   on workspace_members (user_id, workspace_id)
  where deactivated_at is null;
create index wm_ws_role_idx   on workspace_members (workspace_id, role);
create index cm_user_ws_idx   on channel_members  (user_id, workspace_id);
create index cm_channel_idx   on channel_members  (channel_id);

-- ★ THE index: every scrollback read
create index msg_channel_seq_idx on messages (channel_id, seq desc)
  where deleted_at is null;
create index msg_thread_idx      on messages (thread_root_id, seq)
  where thread_root_id is not null;
create index msg_sender_idx      on messages (workspace_id, sender_id, created_at desc);

-- full-text search
create index msg_search_idx  on messages using gin (search_vector);
create index msg_trgm_idx    on messages using gin (body gin_trgm_ops);   -- fuzzy/typo

-- mentions and reactions
create index mention_user_idx   on message_mentions  (mentioned_user_id, workspace_id);
create index reaction_msg_idx   on message_reactions (message_id);

-- notifications: partial index keeps the badge query tiny regardless of history
create index notif_unread_idx on notifications (user_id, created_at desc)
  where read_at is null;
create index notif_list_idx   on notifications (user_id, workspace_id, created_at desc);

-- channels
create index ch_ws_type_idx on channels (workspace_id, type) where archived_at is null;

-- invites
create index inv_expiry_idx on invites (expires_at) where revoked_at is null;
```

**Composite index order matters for RLS.** `wm_user_ws_idx` leads with `user_id` because the
helper functions always filter by the current user first. Leading with `workspace_id` would
make every policy check a scan of that workspace's membership.

### Query → index map

| Query | Index |
|---|---|
| Channel scrollback (`seq < cursor`, desc, 50) | `msg_channel_seq_idx` ★ |
| Jump to message (`seq >= n`) | `msg_channel_seq_idx` ★ |
| Thread replies | `msg_thread_idx` |
| My workspaces | `wm_user_ws_idx` |
| My channels | `cm_user_ws_idx` |
| Channel roster | `cm_channel_idx` |
| Unread count | arithmetic — no index needed (§8) |
| My mentions | `mention_user_idx` |
| Unread notification badge | `notif_unread_idx` (partial) |
| Message search | `msg_search_idx` (GIN) |
| Fuzzy name search | `msg_trgm_idx` / trigram on names |
| Semantic search | `emb_hnsw_idx` (§11) |

---

## 7. Message ordering — the `seq` counter

**The problem.** Two users send in the same millisecond. Timestamps tie. Worse, after a
disconnect a client cannot ask *"what did I miss?"* precisely — a timestamp cursor can skip a
message written with an earlier timestamp but committed later.

**The solution.** A per-channel monotonic `bigint`, assigned by the database. In Postgres this
is atomic, idempotent, and a single round trip — materially better than the two-step version the
MongoDB design required:

```sql
create function public.send_message(
  _channel_id uuid, _body text, _client_msg_id uuid, _thread_root_id uuid default null
) returns public.messages
language plpgsql security invoker set search_path = '' as $$   -- invoker ⇒ RLS applies
declare v_row public.messages; v_seq bigint; v_ws uuid;
begin
  -- fast path: this retry already succeeded
  select * into v_row from public.messages
   where channel_id = _channel_id and client_msg_id = _client_msg_id;
  if found then return v_row; end if;

  select workspace_id into v_ws from public.channels where id = _channel_id;

  update public.channels
     set last_message_seq = last_message_seq + 1, last_message_at = now()
   where id = _channel_id
  returning last_message_seq into v_seq;

  insert into public.messages
    (workspace_id, channel_id, seq, sender_id, body, client_msg_id, thread_root_id)
  values
    (v_ws, _channel_id, v_seq, (select auth.uid()), _body, _client_msg_id, _thread_root_id)
  returning * into v_row;

  return v_row;
exception when unique_violation then
  -- concurrent retry won the race. the counter bump rolls back with this block.
  select * into v_row from public.messages
   where channel_id = _channel_id and client_msg_id = _client_msg_id;
  return v_row;
end $$;
```

**Four properties from one integer:**

| Property | Mechanism |
|---|---|
| **Total order** | Integers per channel. No ties. Identical order on every client |
| **Gap detection** | A client at 41 receiving 43 *knows* it missed 42 |
| **Exact replay** | `GET /messages?after=41` — no overlap, no gaps |
| **O(1) unread** | `channels.last_message_seq − channel_members.last_read_seq` (§8) |

**Two improvements over the MongoDB design worth naming:**

1. **A retry no longer burns a sequence number.** The PL/pgSQL exception block creates an
   implicit savepoint, so a `unique_violation` rolls back the counter increment along with the
   failed insert. In MongoDB the two operations could not be made atomic and every duplicate
   retry left a permanent gap.
2. **A crash mid-operation rolls back cleanly**, because it is one transaction.

Gaps remain *possible* (an unrelated transaction rollback), so clients still treat a gap as
*"fetch the range"* rather than blocking. But they are now rare rather than routine.

**The cost, stated plainly:** all writes to a channel serialize on one row's update. Postgres
handles thousands of updates/sec on a single row — orders of magnitude above what a chat channel
produces — but it is the schema's one hot spot and is monitored explicitly
([scalability.md](./scalability.md) §7).

---

## 8. Read state — watermarks, not receipts

**Rejected:** a `message_reads` row per (user, message). For 50 users × 100k messages that is up
to 5 million rows, written on every scroll, to render one badge.

**Chosen:** one integer per channel membership.

```sql
-- unread counts for the whole sidebar, in one query
select ch.id,
       ch.last_message_seq - cm.last_read_seq as unread,
       count(mm.id) filter (where m.seq > cm.last_read_seq) as mentions
  from channel_members cm
  join channels ch on ch.id = cm.channel_id
  left join message_mentions mm on mm.channel_id = ch.id and mm.mentioned_user_id = cm.user_id
  left join messages m on m.id = mm.message_id
 where cm.user_id = (select auth.uid()) and cm.workspace_id = $1
 group by ch.id, cm.last_read_seq;

-- marking read: idempotent, safe out of order from multiple devices
update channel_members
   set last_read_seq = greatest(last_read_seq, $2), last_read_at = now()
 where channel_id = $1 and user_id = (select auth.uid());
```

`greatest()` makes a late-arriving update from a slow device harmless — it can never move the
watermark backwards.

**What this gives up:** per-message "seen by" avatars. Slack does not have this either, and it
costs 3–4 orders of magnitude more storage and write volume. If it is ever wanted, add it
narrowly to `type = 'DM'` channels where membership is 2. Do not build it generally.

---

## 9. Idempotency

Client generates a `client_msg_id` UUID **before** the first attempt and reuses it on every
retry. `unique (channel_id, client_msg_id)` is the guarantee; `send_message` (§7) handles both
the fast path and the race.

A Redis key `idem:{channel_id}:{client_msg_id}` (24h TTL) is added at Phase 4 as an
optimization only. **Correctness never depends on the cache** — Redis can be flushed or down,
the unique constraint cannot.

The same `client_msg_id` reconciles the optimistic UI: the client renders a placeholder keyed
by it, and replaces it when the real row arrives via HTTP response or socket event, whichever
wins. This is the fix for D23.

---

## 10. Full-text search

```sql
select m.id, m.channel_id, m.seq, m.created_at,
       ts_headline('english', m.body, q, 'MaxFragments=2') as snippet,
       ts_rank_cd(m.search_vector, q) as rank
  from messages m, websearch_to_tsquery('english', $1) q
 where m.search_vector @@ q
   and m.workspace_id = $2
   and m.deleted_at is null
 order by rank desc, m.created_at desc
 limit 25;
```

**RLS makes this safe for free.** There is no `channel_id in (...)` clause because
`msg_select` already restricts the rows. A search cannot return a message from a private
channel the user is not in — not because the query remembered to filter, but because those
rows do not exist for this session.

`websearch_to_tsquery` accepts quoted phrases and `-exclusions`, so the search box behaves the
way users expect without parsing.

**Honest limitations:** `ts_rank_cd` is weaker than Lucene BM25, and there is no built-in typo
tolerance — `pg_trgm` covers fuzzy name matching, but not fuzzy full-text. For a workspace with
millions of messages this is entirely adequate; at tens of millions with demanding relevance
requirements, revisit. That is a nice problem to have and not one to pre-solve.

---

## 11. Vector search (Phase 7)

```sql
create table message_embeddings (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  channel_id   uuid not null references channels(id)   on delete cascade,
  message_id   uuid not null unique references messages(id) on delete cascade,
  chunk_text   text not null,
  embedding    halfvec(384) not null,          -- bge-small-en-v1.5, half precision
  model        text not null,                  -- for re-embedding migrations
  created_at   timestamptz not null default now()
);

alter table message_embeddings enable row level security;
create policy emb_select on message_embeddings for select
  using ( public.is_channel_member(channel_id) );   -- ★ same policy as messages

create index emb_hnsw_idx on message_embeddings
  using hnsw (embedding halfvec_cosine_ops);
create index emb_channel_idx on message_embeddings (channel_id);
```

**Why 384 dimensions and half precision.** Storage is the binding free-tier constraint — 500MB
total. A 1024-dim `vector` column plus its HNSW index would consume roughly the entire budget on
its own; `halfvec(384)` uses about a fifth of that (2 bytes per dimension instead of 4, and 384
dimensions instead of 1024). Full arithmetic in [free-tier-plan.md](./free-tier-plan.md) §2.

The trade is a modest retrieval-quality reduction, which the golden-set evaluation measures
rather than assumes ([ai-architecture.md](./ai-architecture.md) §6). `model` is stored per row so
a future re-embedding at higher precision is a backfill, not a schema migration.

**The security property this buys is the strongest part of the whole stack change.** In the
MongoDB design, permission filtering in vector search depended on the application passing the
right `channelId` list into the `$vectorSearch` filter — correct, but application-enforced. Here
the same RLS policy that protects `messages` protects the embeddings. A retrieval query that
forgets to filter returns nothing rather than everything.

**A real caveat, flagged rather than glossed:** HNSW is an approximate index. When RLS restricts
a large fraction of rows, the index can return its top-*k* candidates and then have most of them
filtered away, under-returning results. Mitigations, in order:

1. Raise `hnsw.ef_search` (e.g. `set local hnsw.ef_search = 200`) and over-fetch, then trim.
2. Add `emb_channel_idx` so the planner can choose an indexed filter path when the user's
   channel set is small.
3. At large scale, partition `message_embeddings` by `workspace_id` so each index is
   workspace-local.

Measured at Phase 7 against the golden evaluation set
([ai-architecture.md](./ai-architecture.md) §6) rather than guessed at.

---

## 12. Storage

Supabase Storage with RLS on `storage.objects`. Path convention encodes the tenant:

```text
attachments/{workspace_id}/{channel_id}/{uuid}/{filename}
```

```sql
create policy "attachments readable by channel members"
on storage.objects for select using (
  bucket_id = 'attachments'
  and public.is_channel_member( ((storage.foldername(name))[2])::uuid )
);

create policy "attachments writable by channel members"
on storage.objects for insert with check (
  bucket_id = 'attachments'
  and public.is_channel_member( ((storage.foldername(name))[2])::uuid )
);
```

The bucket is **private**; access is through signed URLs with short expiry, issued after a
permission check ([security-model.md](./security-model.md) §6). The path-embedded
`channel_id` is also what lets the API verify at attach time that an uploaded object belongs to
the channel the message is being posted to.

---

## 13. Bootstrap and seeding

No migration — there is no data. What replaces it:

**Migrations** are versioned SQL under `supabase/migrations/`, applied by the Supabase CLI in
CI and on deploy. Tables, policies, functions, indexes, and buckets all live there, so a fresh
environment is one `supabase db push` away — which is precisely the problem that lost
credentials created the first time.

**Seed script** (`supabase/seed.sql` + a TS script for auth users) creates a demo workspace with
a handful of users, channels, and messages, so a new developer has something to look at within
10 minutes of cloning.

**Workspace creation is a transaction** — workspace + OWNER membership + `#general` channel +
membership, all or nothing. In Postgres this is `begin/commit`, not a distributed-transaction
design problem.

---

## 14. Retention and cleanup

| Data | Policy | Mechanism |
|---|---|---|
| Notifications | 90 days | `cleanup.orphans` nightly job |
| Soft-deleted messages | purge after 30 days | nightly job (cascades to embeddings/attachments) |
| **Database size guard** | warn at 400MB of 500MB | same job, `pg_database_size()` |
| Expired invites | delete after expiry | nightly job |
| Orphaned storage objects | delete if `message_id is null` after 6h | nightly job |
| Typing / presence | seconds | Redis TTL |
| Typing state | seconds | in-process TTL map |

Postgres has no TTL indexes, so these run as **pg-boss repeatable jobs** — the worker already
exists, the logic is testable in TypeScript, and failures surface in the same queue metrics as
everything else.

On free tier these matter more than they would otherwise: retention is what keeps the database
inside its 500MB ceiling, so a `pg_database_size()` gauge and a warning at 400MB ship with them
([free-tier-plan.md](./free-tier-plan.md) §2).

The orphaned-object job matters more than it looks: signed uploads mean a file can land in
Storage and the message send can then fail. Without cleanup, storage grows monotonically with
abandoned uploads.
