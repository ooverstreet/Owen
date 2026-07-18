-- Harbor invite codes — run once in Supabase SQL Editor
-- Admin generates codes in the app; friends redeem them to create accounts.

create table if not exists public.harbor_invites (
  code text primary key,
  created_by uuid references auth.users(id) on delete set null,
  note text,
  active boolean not null default true,
  use_count integer not null default 0,
  max_uses integer not null default 100,
  created_at timestamptz not null default now()
);

alter table public.harbor_invites enable row level security;

-- Visitors can look up an active code before signup
drop policy if exists "harbor_invites_select_active" on public.harbor_invites;
create policy "harbor_invites_select_active" on public.harbor_invites
  for select using (active = true);

-- Only admins create invites
drop policy if exists "harbor_invites_admin_insert" on public.harbor_invites;
create policy "harbor_invites_admin_insert" on public.harbor_invites
  for insert with check (
    exists (
      select 1 from public.harbor_profiles p
      where p.id = auth.uid() and p.role = 'admin'
    )
  );

-- Only admins update / deactivate
drop policy if exists "harbor_invites_admin_update" on public.harbor_invites;
create policy "harbor_invites_admin_update" on public.harbor_invites
  for update using (
    exists (
      select 1 from public.harbor_profiles p
      where p.id = auth.uid() and p.role = 'admin'
    )
  );

-- Seed starter codes (safe to re-run)
insert into public.harbor_invites (code, note, max_uses)
values
  ('first-light', 'Starter invite', 200),
  ('quiet-shore', 'Starter invite', 200),
  ('harbor-friend', 'Starter invite', 200)
on conflict (code) do nothing;
