-- Phase 6: message attachments + storage bucket/policies. Full-text search
-- needs no migration work at all — search_vector, its GIN index, and
-- pg_trgm all shipped in 20260815030000_channels_messages.sql.

create table public.message_attachments (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  channel_id   uuid not null references public.channels(id)   on delete cascade,
  message_id   uuid references public.messages(id) on delete cascade, -- null until attached
  uploaded_by  uuid not null references public.profiles(id),
  storage_path text not null unique,
  name         text not null check (length(name) <= 255),
  mime_type    text not null,
  size_bytes   bigint not null check (size_bytes > 0),
  width        int,
  height       int,
  thumb_path   text,
  created_at   timestamptz not null default now()
);

create index attach_message_idx on public.message_attachments (message_id) where message_id is not null;
create index attach_orphan_idx  on public.message_attachments (created_at) where message_id is null;

alter table public.message_attachments enable row level security;

create policy attach_select on public.message_attachments for select
  using ( public.is_channel_member(channel_id) );

create policy attach_insert on public.message_attachments for insert
  with check ( uploaded_by = (select auth.uid()) and public.is_channel_member(channel_id) );

-- update is needed only to set message_id at send-time (upload.repository.ts's
-- attachToMessage) — attachments are otherwise immutable.
create policy attach_update on public.message_attachments for update
  using      ( uploaded_by = (select auth.uid()) and public.is_channel_member(channel_id) )
  with check ( uploaded_by = (select auth.uid()) and public.is_channel_member(channel_id) );

-- lets a user cancel/remove their own not-yet-sent upload; message-attached
-- rows are removed transitively via messages' own on delete cascade.
create policy attach_delete on public.message_attachments for delete
  using ( uploaded_by = (select auth.uid()) );

grant select, insert, update, delete on public.message_attachments to authenticated;

-- ---------------------------------------------------------------------------
-- Storage bucket + policies. Path scheme:
--   attachments/{workspace_id}/{channel_id}/{uuid}/{filename}
-- docs/database-design.md §12, docs/security-model.md §9.
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit)
values ('attachments', 'attachments', false, 5242880) -- 5MiB, matches supabase/config.toml
on conflict (id) do nothing;

create policy "attachments readable by channel members" on storage.objects for select
  using (
    bucket_id = 'attachments'
    and public.is_channel_member( ((storage.foldername(name))[2])::uuid )
  );

create policy "attachments writable by channel members" on storage.objects for insert
  with check (
    bucket_id = 'attachments'
    and public.is_channel_member( ((storage.foldername(name))[2])::uuid )
  );

create policy "attachments deletable by uploader" on storage.objects for delete
  using (
    bucket_id = 'attachments'
    and owner = (select auth.uid())
  );
