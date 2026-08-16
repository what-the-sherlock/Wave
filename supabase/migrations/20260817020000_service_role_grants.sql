-- Fixes a latent gap discovered while building Phase 7: on a freshly
-- provisioned local `supabase start` stack, `service_role` held only
-- TRUNCATE/REFERENCES/TRIGGER on every table in `public` — never
-- SELECT/INSERT/UPDATE/DELETE — because every prior migration only ever
-- wrote `grant ... to authenticated`, on the assumption that Supabase
-- provisions `service_role` with full table access automatically. That
-- assumption held for `service_role`'s RLS bypass (`rolbypassrls = true`,
-- confirmed) but not for base table grants, which are a separate
-- permission axis in Postgres — bypassing RLS does not imply an implicit
-- table grant.
--
-- Concretely, this made every `withServiceRoleScope` job handler that
-- reads a table it doesn't own fail with "permission denied": Phase 5's
-- notification.fanout (reads `messages`, writes `notifications`) and
-- Phase 6's attachment.process (reads/writes `message_attachments`) were
-- already exposed to this on any environment provisioned the same way as
-- the stack this was found on. Phase 7's embedding.generate worker (reads
-- `channels`/`workspaces`/`messages`) would have inherited the identical
-- failure mode.
--
-- These grants are purely additive — they widen `service_role` only,
-- never `authenticated`/`anon`, and change no RLS policy — so they are a
-- safe no-op on any environment where the platform already provisions
-- `service_role` with full access.

grant select, insert, update, delete on
  public.profiles,
  public.workspaces,
  public.workspace_members,
  public.channels,
  public.channel_members,
  public.messages,
  public.message_reactions,
  public.message_mentions,
  public.notifications,
  public.message_attachments
to service_role;
