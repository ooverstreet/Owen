-- Harbor moderation schema — run once in Supabase SQL Editor after supabase.sql

alter table harbor_posts add column if not exists device_id text;
alter table harbor_posts add column if not exists is_hidden boolean not null default false;
alter table harbor_posts add column if not exists hidden_reason text;
alter table harbor_replies add column if not exists device_id text;
alter table harbor_replies add column if not exists is_hidden boolean not null default false;

-- Replace public read policies to hide moderated content
drop policy if exists "harbor_posts_public_read" on harbor_posts;
create policy "harbor_posts_public_read" on harbor_posts
  for select using (is_private = false and is_hidden = false);

drop policy if exists "harbor_replies_public_read" on harbor_replies;
create policy "harbor_replies_public_read" on harbor_replies
  for select using (
    is_hidden = false
    and exists (
      select 1 from harbor_posts p
      where p.id = post_id and p.is_private = false and p.is_hidden = false
    )
  );

create table if not exists harbor_reports (
  id text primary key,
  target_type text not null check (target_type in ('post', 'reply')),
  target_id text not null,
  post_id text,
  reason text not null,
  details text,
  reporter_device_id text,
  reporter_name text,
  created_at timestamptz not null default now()
);

create table if not exists harbor_bans (
  id text primary key,
  ban_type text not null check (ban_type in ('device', 'username')),
  ban_value text not null,
  reason text not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  created_by text default 'admin'
);

create unique index if not exists harbor_bans_active_uniq
  on harbor_bans (ban_type, ban_value)
  where active = true;

create table if not exists harbor_content_archive (
  id text primary key,
  original_type text not null check (original_type in ('post', 'reply')),
  original_id text not null,
  post_id text,
  payload jsonb not null,
  reason text not null,
  deleted_by text default 'admin',
  created_at timestamptz not null default now()
);

create table if not exists harbor_moderation_events (
  id text primary key,
  action text not null,
  target_type text,
  target_id text,
  actor text,
  reason text,
  meta jsonb default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table harbor_reports enable row level security;
alter table harbor_bans enable row level security;
alter table harbor_content_archive enable row level security;
alter table harbor_moderation_events enable row level security;

-- Anyone can file a report
drop policy if exists "harbor_reports_public_insert" on harbor_reports;
create policy "harbor_reports_public_insert" on harbor_reports
  for insert with check (true);

-- Public can read active bans (to block posting client-side / edge)
drop policy if exists "harbor_bans_public_read_active" on harbor_bans;
create policy "harbor_bans_public_read_active" on harbor_bans
  for select using (active = true);

-- Note: insert/update for bans, archive, events, and hiding posts
-- should be done via the harbor-moderation Edge Function with ADMIN_SECRET.
-- No public write policies on those admin tables by design.
