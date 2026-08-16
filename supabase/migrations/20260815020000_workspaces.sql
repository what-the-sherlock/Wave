-- Phase 2: workspaces, workspace_members, invites — tenancy and the RLS
-- mechanism that makes it safe. See docs/database-design.md §4-§5 and
-- docs/implementation-roadmap.md "Phase 2".

create extension if not exists "citext";

create type public.workspace_role as enum ('OWNER', 'ADMIN', 'MEMBER');

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table public.workspaces (
  id           uuid primary key default gen_random_uuid(),
  name         text not null check (length(name) between 1 and 80),
  slug         text not null unique check (slug ~ '^[a-z0-9-]{3,32}$'),
  icon_url     text,
  owner_id     uuid not null references public.profiles(id),
  settings     jsonb not null default '{"allowPublicInvites":false,"aiEnabled":true}'::jsonb,
  member_count int not null default 0,
  archived_at  timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create trigger workspaces_set_updated_at
  before update on public.workspaces
  for each row execute function public.set_updated_at();

create table public.workspace_members (
  id             uuid primary key default gen_random_uuid(),
  workspace_id   uuid not null references public.workspaces(id) on delete cascade,
  user_id        uuid not null references public.profiles(id)   on delete cascade,
  role           public.workspace_role not null default 'MEMBER',
  display_name   text,
  invited_by     uuid references public.profiles(id),
  joined_at      timestamptz not null default now(),
  deactivated_at timestamptz,
  unique (workspace_id, user_id)
);

create table public.invites (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  email        citext,
  token_hash   text not null unique,
  role         public.workspace_role not null default 'MEMBER',
  -- Unused until channels exist in Phase 3 — kept now for schema fidelity
  -- with docs/database-design.md §4 rather than added as a later migration.
  channel_ids  uuid[] not null default '{}',
  invited_by   uuid not null references public.profiles(id),
  max_uses     int not null default 1 check (max_uses > 0),
  use_count    int not null default 0 check (use_count >= 0),
  expires_at   timestamptz not null,
  revoked_at   timestamptz,
  created_at   timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Indexes — every policy predicate and hot query path (docs/database-design.md §6)
-- ---------------------------------------------------------------------------

create index wm_user_ws_idx on public.workspace_members (user_id, workspace_id)
  where deactivated_at is null;
create index wm_ws_role_idx on public.workspace_members (workspace_id, role);
create index inv_expiry_idx on public.invites (expires_at) where revoked_at is null;

-- ---------------------------------------------------------------------------
-- SECURITY DEFINER helpers — break the RLS recursion trap (docs/database-design.md §5.1)
-- ---------------------------------------------------------------------------

create function public.is_workspace_member(_workspace_id uuid)
returns boolean
language sql
security definer
set search_path = ''
stable
as $$
  select exists (
    select 1 from public.workspace_members m
    where m.workspace_id = _workspace_id
      and m.user_id = (select auth.uid())
      and m.deactivated_at is null
  );
$$;

create function public.workspace_role_of(_workspace_id uuid)
returns public.workspace_role
language sql
security definer
set search_path = ''
stable
as $$
  select m.role from public.workspace_members m
  where m.workspace_id = _workspace_id
    and m.user_id = (select auth.uid())
    and m.deactivated_at is null;
$$;

revoke execute on function public.is_workspace_member(uuid) from public;
grant  execute on function public.is_workspace_member(uuid) to authenticated;

revoke execute on function public.workspace_role_of(uuid) from public;
grant  execute on function public.workspace_role_of(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Row-Level Security
-- ---------------------------------------------------------------------------

alter table public.workspaces        enable row level security;
alter table public.workspace_members enable row level security;
alter table public.invites           enable row level security;

-- workspaces
--
-- The `owner_id = ...` clause is not redundant with is_workspace_member():
-- Postgres RLS re-checks the SELECT policy for the row an INSERT/UPDATE
-- ... RETURNING clause hands back, and at the moment of the owner's own
-- INSERT ... RETURNING (workspace.service.ts's createWorkspace, before the
-- OWNER membership row exists in the same transaction) there is no
-- membership row yet for is_workspace_member() to find — the same
-- bootstrap chicken-and-egg wm_insert_bootstrap solves below, one level up.
create policy ws_select on public.workspaces for select
  using ( public.is_workspace_member(id) or owner_id = (select auth.uid()) );

create policy ws_update on public.workspaces for update
  using      ( public.workspace_role_of(id) in ('OWNER', 'ADMIN') )
  with check ( public.workspace_role_of(id) in ('OWNER', 'ADMIN') );

create policy ws_insert on public.workspaces for insert
  with check ( owner_id = (select auth.uid()) );

-- workspace_members (helper functions break the recursion trap)
create policy wm_select on public.workspace_members for select
  using ( public.is_workspace_member(workspace_id) );

-- Bootstrap case: the very first membership row of a brand-new workspace.
-- workspace_role_of() returns null here (no member exists yet), so the
-- normal "OWNER/ADMIN may insert" check can never pass for a workspace's own
-- creator inserting themselves as OWNER. This is a narrow, one-time
-- allowance: it only fires while zero members exist for that workspace, only
-- for the row matching the workspace's own owner_id, and only as OWNER.
create policy wm_insert_bootstrap on public.workspace_members for insert
  with check (
    role = 'OWNER'
    and user_id = (select auth.uid())
    and exists (
      select 1 from public.workspaces w
      where w.id = workspace_id and w.owner_id = (select auth.uid())
    )
    and not exists (
      select 1 from public.workspace_members m2
      where m2.workspace_id = workspace_members.workspace_id
    )
  );

-- Normal case: an existing OWNER/ADMIN adding someone else.
create policy wm_insert_admin on public.workspace_members for insert
  with check ( public.workspace_role_of(workspace_id) in ('OWNER', 'ADMIN') );

create policy wm_update on public.workspace_members for update
  using      ( public.workspace_role_of(workspace_id) in ('OWNER', 'ADMIN') )
  with check ( public.workspace_role_of(workspace_id) in ('OWNER', 'ADMIN') );

-- Deletion: an OWNER/ADMIN removing someone, or a member removing themself (leave).
create policy wm_delete on public.workspace_members for delete
  using (
    public.workspace_role_of(workspace_id) in ('OWNER', 'ADMIN')
    or user_id = (select auth.uid())
  );

-- invites: only OWNER/ADMIN may read or manage them directly. Acceptance
-- goes through the accept_invite() SECURITY DEFINER function below, because
-- the invitee is not yet a member and this policy would otherwise refuse
-- their own insert.
create policy inv_admin on public.invites for all
  using      ( public.workspace_role_of(workspace_id) in ('OWNER', 'ADMIN') )
  with check ( public.workspace_role_of(workspace_id) in ('OWNER', 'ADMIN') );

-- ---------------------------------------------------------------------------
-- profiles: extend Phase 1's self-only policy to cover shared-workspace
-- visibility, per the comment left in 20260815010000_profiles.sql and
-- docs/database-design.md §5.2 (prof_select).
-- ---------------------------------------------------------------------------

drop policy "individuals can view own profile" on public.profiles;

create policy prof_select on public.profiles for select
  using (
    id = (select auth.uid())
    or exists (
      select 1 from public.workspace_members a
      join public.workspace_members b using (workspace_id)
      where a.user_id = (select auth.uid())
        and a.deactivated_at is null
        and b.user_id = profiles.id
        and b.deactivated_at is null
    )
  );

-- ---------------------------------------------------------------------------
-- accept_invite(): the only way a non-member can create their own membership
-- row. SECURITY DEFINER bypasses RLS deliberately and bounded to exactly
-- this operation (docs/security-model.md §5, §6).
-- ---------------------------------------------------------------------------

create function public.accept_invite(_token_hash text)
returns table (workspace_id uuid, role public.workspace_role)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_invite   public.invites%rowtype;
  v_uid      uuid := (select auth.uid());
  v_email    public.citext;
  v_existing public.workspace_members%rowtype;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  select * into v_invite from public.invites
   where token_hash = _token_hash
   for update;

  if not found then
    raise exception 'invite_not_found' using errcode = 'P0002';
  end if;

  -- Idempotent double-accept: if already a member, succeed without touching
  -- use_count or re-validating an invite that may since have expired.
  -- Table-qualified: the function's own `workspace_id` OUT parameter
  -- (from the `returns table (workspace_id uuid, ...)` signature) is in
  -- scope for the whole function body and is otherwise ambiguous with the
  -- column of the same name.
  select * into v_existing from public.workspace_members
   where public.workspace_members.workspace_id = v_invite.workspace_id
     and public.workspace_members.user_id = v_uid;

  if found then
    return query select v_invite.workspace_id, v_existing.role;
    return;
  end if;

  if v_invite.revoked_at is not null then
    raise exception 'invite_revoked' using errcode = 'P0001';
  end if;

  if v_invite.expires_at < now() then
    raise exception 'invite_expired' using errcode = 'P0001';
  end if;

  if v_invite.use_count >= v_invite.max_uses then
    raise exception 'invite_exhausted' using errcode = 'P0001';
  end if;

  if v_invite.email is not null then
    select email into v_email from auth.users where id = v_uid;
    if v_email is null or v_invite.email <> v_email then
      raise exception 'invite_email_mismatch' using errcode = 'P0001';
    end if;
  end if;

  insert into public.workspace_members (workspace_id, user_id, role, invited_by)
  values (v_invite.workspace_id, v_uid, v_invite.role, v_invite.invited_by);

  update public.invites set use_count = use_count + 1 where id = v_invite.id;

  update public.workspaces set member_count = member_count + 1
   where id = v_invite.workspace_id;

  return query select v_invite.workspace_id, v_invite.role;
end;
$$;

revoke execute on function public.accept_invite(text) from public;
grant  execute on function public.accept_invite(text) to authenticated;

-- ---------------------------------------------------------------------------
-- invite_preview(): read-only, pre-membership. Powers the "you've been
-- invited to X" screen without exposing the invite row (token hash, email,
-- use counts) to someone who merely holds the raw token.
-- ---------------------------------------------------------------------------

create function public.invite_preview(_token_hash text)
returns table (
  workspace_name text,
  workspace_icon_url text,
  inviter_name text,
  is_valid boolean
)
language sql
security definer
set search_path = ''
stable
as $$
  select
    w.name,
    w.icon_url,
    p.full_name,
    ( i.revoked_at is null
      and i.expires_at > now()
      and i.use_count < i.max_uses ) as is_valid
  from public.invites i
  join public.workspaces w on w.id = i.workspace_id
  join public.profiles p   on p.id = i.invited_by
  where i.token_hash = _token_hash;
$$;

revoke execute on function public.invite_preview(text) from public;
grant  execute on function public.invite_preview(text) to authenticated;

-- ---------------------------------------------------------------------------
-- Grants — exactly what the policies above allow, no more.
-- ---------------------------------------------------------------------------

grant select, insert, update on public.workspaces to authenticated;
grant select, insert, update, delete on public.workspace_members to authenticated;
grant select, insert, update, delete on public.invites to authenticated;
