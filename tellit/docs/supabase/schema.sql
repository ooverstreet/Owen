-- Tellit Supabase schema (Jacksonville MVP)
-- Run in Supabase SQL editor.

create extension if not exists pgcrypto;
create extension if not exists postgis;

-- ───────────────────────────────────────────────────────────────────────────────
-- Types
-- ───────────────────────────────────────────────────────────────────────────────
do $$
begin
  if not exists (select 1 from pg_type where typname = 'issue_type') then
    create type public.issue_type as enum (
      'accident',
      'pothole',
      'signal_out',
      'debris',
      'flooding',
      'roadwork',
      'congestion',
      'other'
    );
  end if;
end $$;

do $$
begin
  if not exists (select 1 from pg_type where typname = 'issue_severity') then
    create type public.issue_severity as enum ('low', 'medium', 'high');
  end if;
end $$;

-- ───────────────────────────────────────────────────────────────────────────────
-- Utility functions
-- ───────────────────────────────────────────────────────────────────────────────
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create or replace function public.default_report_expiry(issue public.issue_type)
returns interval
language sql
immutable
as $$
  select case issue
    when 'accident' then interval '6 hours'
    when 'signal_out' then interval '12 hours'
    when 'debris' then interval '8 hours'
    when 'congestion' then interval '2 hours'
    when 'flooding' then interval '24 hours'
    when 'roadwork' then interval '7 days'
    when 'pothole' then interval '21 days'
    else interval '12 hours'
  end;
$$;

create or replace function public.apply_report_defaults()
returns trigger
language plpgsql
as $$
begin
  if new.expires_at is null then
    new.expires_at = now() + public.default_report_expiry(new.issue_type);
  end if;
  return new;
end;
$$;

-- ───────────────────────────────────────────────────────────────────────────────
-- Tables
-- ───────────────────────────────────────────────────────────────────────────────
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null check (char_length(display_name) between 2 and 40),
  avatar_url text,
  home_city text not null default 'Jacksonville, FL',
  is_moderator boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.reports (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  is_anonymous boolean not null default false,
  issue_type public.issue_type not null,
  severity public.issue_severity not null default 'medium',
  description text not null check (char_length(description) between 8 and 500),
  location geography(point, 4326) not null,
  location_text text,
  photo_url text,
  status text not null default 'open' check (status in ('open', 'resolved', 'hidden', 'rejected', 'expired')),
  expires_at timestamptz,
  resolved_at timestamptz,
  resolved_by uuid references auth.users(id),
  resolution_note text,
  reporter_ip_hash text,
  reporter_user_agent text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.report_confirmations (
  id bigint generated always as identity primary key,
  report_id bigint not null references public.reports(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (report_id, user_id)
);

create table if not exists public.report_status_events (
  id bigint generated always as identity primary key,
  report_id bigint not null references public.reports(id) on delete cascade,
  actor_user_id uuid not null references auth.users(id),
  from_status text,
  to_status text not null,
  note text,
  created_at timestamptz not null default now()
);

create index if not exists idx_reports_created_at on public.reports (created_at desc);
create index if not exists idx_reports_status_created on public.reports (status, created_at desc);
create index if not exists idx_reports_expires_at on public.reports (expires_at);
create index if not exists idx_reports_location on public.reports using gist (location);
create index if not exists idx_confirmations_report on public.report_confirmations (report_id);
create index if not exists idx_status_events_report on public.report_status_events (report_id, created_at desc);

drop trigger if exists trg_profiles_updated_at on public.profiles;
create trigger trg_profiles_updated_at
before update on public.profiles
for each row execute function public.set_updated_at();

drop trigger if exists trg_reports_updated_at on public.reports;
create trigger trg_reports_updated_at
before update on public.reports
for each row execute function public.set_updated_at();

drop trigger if exists trg_reports_defaults on public.reports;
create trigger trg_reports_defaults
before insert on public.reports
for each row execute function public.apply_report_defaults();

-- ───────────────────────────────────────────────────────────────────────────────
-- Public feed view (safe columns only)
-- ───────────────────────────────────────────────────────────────────────────────
create or replace view public.report_feed
with (security_invoker = true)
as
select
  r.id,
  r.issue_type,
  r.severity,
  r.description,
  r.photo_url,
  r.status,
  r.created_at,
  r.updated_at,
  r.expires_at,
  r.location_text,
  st_y(r.location::geometry) as latitude,
  st_x(r.location::geometry) as longitude,
  case
    when r.is_anonymous then 'Anonymous'
    else p.display_name
  end as reporter_label,
  coalesce(c.confirm_count, 0)::int as confirm_count
from public.reports r
left join public.profiles p on p.id = r.user_id
left join (
  select report_id, count(*) as confirm_count
  from public.report_confirmations
  group by report_id
) c on c.report_id = r.id
where r.status = 'open'
  and (r.expires_at is null or r.expires_at > now());

-- API grants
-- The backend uses SUPABASE_SERVICE_ROLE_KEY, so it needs explicit privileges.
grant usage on schema public to anon, authenticated, service_role;
grant select on public.report_feed to anon, authenticated, service_role;

-- Because report_feed uses security_invoker=true, service_role must also be able
-- to read the underlying relations referenced by the view.
grant select on public.reports to service_role;
grant select on public.profiles to service_role;
grant select on public.report_confirmations to service_role;

-- Backend endpoints also write to these tables with service_role credentials.
grant insert, update on public.reports to service_role;
grant select, insert, delete on public.report_confirmations to service_role;
grant insert on public.report_status_events to service_role;

-- SECURITY DEFINER helper used by RLS checks.
create or replace function public.is_moderator()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select p.is_moderator from public.profiles p where p.id = auth.uid()),
    false
  );
$$;

-- ───────────────────────────────────────────────────────────────────────────────
-- Row Level Security
-- ───────────────────────────────────────────────────────────────────────────────
alter table public.profiles enable row level security;
alter table public.reports enable row level security;
alter table public.report_confirmations enable row level security;
alter table public.report_status_events enable row level security;

-- Profiles
drop policy if exists "profiles_select_authenticated" on public.profiles;
create policy "profiles_select_authenticated"
on public.profiles
for select
to authenticated
using (true);

drop policy if exists "profiles_insert_self" on public.profiles;
create policy "profiles_insert_self"
on public.profiles
for insert
to authenticated
with check (id = auth.uid());

drop policy if exists "profiles_update_self_or_moderator" on public.profiles;
create policy "profiles_update_self_or_moderator"
on public.profiles
for update
to authenticated
using (id = auth.uid() or public.is_moderator())
with check (id = auth.uid() or public.is_moderator());

-- Reports
drop policy if exists "reports_insert_own" on public.reports;
create policy "reports_insert_own"
on public.reports
for insert
to authenticated
with check (user_id = auth.uid());

drop policy if exists "reports_select_own_or_moderator" on public.reports;
create policy "reports_select_own_or_moderator"
on public.reports
for select
to authenticated
using (user_id = auth.uid() or public.is_moderator());

drop policy if exists "reports_update_own_open_or_moderator" on public.reports;
create policy "reports_update_own_open_or_moderator"
on public.reports
for update
to authenticated
using ((user_id = auth.uid() and status = 'open') or public.is_moderator())
with check ((user_id = auth.uid() and status = 'open') or public.is_moderator());

drop policy if exists "reports_delete_moderator" on public.reports;
create policy "reports_delete_moderator"
on public.reports
for delete
to authenticated
using (public.is_moderator());

-- Confirmations
drop policy if exists "confirmations_select_authenticated" on public.report_confirmations;
create policy "confirmations_select_authenticated"
on public.report_confirmations
for select
to authenticated
using (true);

drop policy if exists "confirmations_insert_own" on public.report_confirmations;
create policy "confirmations_insert_own"
on public.report_confirmations
for insert
to authenticated
with check (user_id = auth.uid());

drop policy if exists "confirmations_delete_own_or_moderator" on public.report_confirmations;
create policy "confirmations_delete_own_or_moderator"
on public.report_confirmations
for delete
to authenticated
using (user_id = auth.uid() or public.is_moderator());

-- Status events (moderation audit)
drop policy if exists "status_events_select_own_or_moderator" on public.report_status_events;
create policy "status_events_select_own_or_moderator"
on public.report_status_events
for select
to authenticated
using (
  public.is_moderator()
  or exists (
    select 1 from public.reports r
    where r.id = report_id and r.user_id = auth.uid()
  )
);

drop policy if exists "status_events_insert_moderator" on public.report_status_events;
create policy "status_events_insert_moderator"
on public.report_status_events
for insert
to authenticated
with check (public.is_moderator() and actor_user_id = auth.uid());
