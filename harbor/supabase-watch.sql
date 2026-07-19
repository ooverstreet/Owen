-- Harbor Watch — AI moderator reviews on language alerts
-- Run after supabase-strikes.sql (safe to re-run).

alter table public.harbor_mod_alerts
  add column if not exists ai_review text,
  add column if not exists ai_recommendation text,
  add column if not exists ai_reviewed_at timestamptz,
  add column if not exists watched_by text default 'Harbor Watch';

comment on column public.harbor_mod_alerts.ai_review is
  'Harbor Watch (AI moderator) note for the host';
comment on column public.harbor_mod_alerts.ai_recommendation is
  'keep_warning | ban_appropriate | review_manually | likely_false_positive';
