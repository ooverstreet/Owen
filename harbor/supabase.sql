-- Harbor schema — run once in Supabase SQL Editor

create table if not exists harbor_posts (
  id text primary key,
  featured boolean not null default false,
  author_mode text not null check (author_mode in ('anonymous', 'named')),
  author_name text not null,
  body text not null,
  tags text[] not null default '{}',
  angel_line text,
  angel_note text,
  felt_count integer not null default 0,
  is_private boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists harbor_replies (
  id text primary key,
  post_id text not null references harbor_posts(id) on delete cascade,
  author_mode text not null check (author_mode in ('anonymous', 'named')),
  author_name text not null,
  body text not null,
  created_at timestamptz not null default now()
);

create index if not exists harbor_posts_created_at_idx on harbor_posts (featured desc, created_at desc);
create index if not exists harbor_replies_post_id_idx on harbor_replies (post_id, created_at);

alter table harbor_posts enable row level security;
alter table harbor_replies enable row level security;

-- Public can read non-private posts
drop policy if exists "harbor_posts_public_read" on harbor_posts;
create policy "harbor_posts_public_read" on harbor_posts
  for select using (is_private = false);

drop policy if exists "harbor_posts_public_insert" on harbor_posts;
create policy "harbor_posts_public_insert" on harbor_posts
  for insert with check (is_private = false);

drop policy if exists "harbor_posts_public_felt" on harbor_posts;
create policy "harbor_posts_public_felt" on harbor_posts
  for update using (is_private = false)
  with check (is_private = false);

drop policy if exists "harbor_replies_public_read" on harbor_replies;
create policy "harbor_replies_public_read" on harbor_replies
  for select using (
    exists (
      select 1 from harbor_posts p
      where p.id = post_id and p.is_private = false
    )
  );

drop policy if exists "harbor_replies_public_insert" on harbor_replies;
create policy "harbor_replies_public_insert" on harbor_replies
  for insert with check (
    exists (
      select 1 from harbor_posts p
      where p.id = post_id and p.is_private = false
    )
  );

-- Seed First light (safe to re-run)
insert into harbor_posts (
  id, featured, author_mode, author_name, body, tags, angel_line, angel_note, felt_count, is_private, created_at
) values (
  'harbor-first-light',
  true,
  'named',
  'Harbor',
  'Today I start a new and exciting chapter. Harbor. A place people can come and be themselves with no judgment. Say how you feel or what makes you excited, happy, disappointed etc. While respecting others and their opinions.',
  array['welcome'],
  'You don’t have to tidy the feeling before it’s welcome here.',
  'Share only what feels safe. Be kind to yourself and others here.',
  1,
  false,
  '2026-07-17T12:00:00Z'
)
on conflict (id) do update set
  featured = excluded.featured,
  body = excluded.body,
  tags = excluded.tags,
  angel_line = excluded.angel_line,
  angel_note = excluded.angel_note;
