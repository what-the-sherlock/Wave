-- Phase 7 added `aiEnabled` as a new key inside workspaces.settings
-- (jsonb, not null), defaulting brand-new workspaces to `true` via
-- DEFAULT_SETTINGS in workspace.service.ts. That default only applies at
-- INSERT time, so every workspace created before Phase 7 shipped has a
-- `settings` value with no `aiEnabled` key at all, rather than `false`.
--
-- Every Phase 7 UI surface reads `workspace.settings.aiEnabled` directly
-- and renders nothing when it's missing/falsy: the toggle on
-- WorkspaceSettingsPage, the "Catch me up" button in ChatContainer, the
-- Ask tab in SearchModal, and the summarize button in ThreadPanel. So
-- without this backfill, Phase 7 is invisible on every pre-existing
-- workspace even with migrations run and GROQ_API_KEY configured.
update public.workspaces
set settings = settings || jsonb_build_object('aiEnabled', true)
where not (settings ? 'aiEnabled');
