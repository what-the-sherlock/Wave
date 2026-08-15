-- Phase 1: profiles table, mirroring auth.users 1:1 via trigger.
-- See docs/database-design.md §3.

create extension if not exists "pgcrypto";

-- Generic updated_at maintenance, reused by every table going forward.
create function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table public.profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  full_name    text not null check (length(full_name) between 1 and 80),
  avatar_url   text,
  timezone     text not null default 'UTC',
  last_seen_at timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

-- Populate a profile automatically whenever a new auth user is created.
-- SECURITY DEFINER + search_path='' per docs/database-design.md §3 — without the
-- empty search_path a caller could shadow `public` and hijack execution as the
-- function owner.
create function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, full_name)
  values (
    new.id,
    coalesce(
      nullif(trim(new.raw_user_meta_data->>'full_name'), ''),
      split_part(new.email, '@', 1)
    )
  );
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Row-Level Security. Phase 1 has no workspace concept yet, so visibility is
-- self-only for now; Phase 2 extends the select policy to cover people you
-- share a workspace with (docs/database-design.md §5.2).
alter table public.profiles enable row level security;

create policy "individuals can view own profile"
  on public.profiles for select
  using ( id = (select auth.uid()) );

create policy "individuals can update own profile"
  on public.profiles for update
  using ( id = (select auth.uid()) )
  with check ( id = (select auth.uid()) );

-- No insert/delete policy: rows are created only by the trigger above (which
-- runs as the function owner and bypasses RLS) and deleted only via the
-- `on delete cascade` from auth.users.

-- Explicit table grants rather than relying on Supabase's implicit platform
-- defaults — matches exactly what the two policies above allow, and keeps
-- the migration portable to any Postgres with the standard Supabase roles.
grant select, update on public.profiles to authenticated;
