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

-- Only admins create invites (DB role OR Owen’s owner email in JWT)
drop policy if exists "harbor_invites_admin_insert" on public.harbor_invites;
create policy "harbor_invites_admin_insert" on public.harbor_invites
  for insert with check (
    exists (
      select 1 from public.harbor_profiles p
      where p.id = auth.uid() and p.role = 'admin'
    )
    or lower(coalesce(auth.jwt() ->> 'email', '')) = 'owenstreet7@gmail.com'
  );

-- Only admins update / deactivate
drop policy if exists "harbor_invites_admin_update" on public.harbor_invites;
create policy "harbor_invites_admin_update" on public.harbor_invites
  for update using (
    exists (
      select 1 from public.harbor_profiles p
      where p.id = auth.uid() and p.role = 'admin'
    )
    or lower(coalesce(auth.jwt() ->> 'email', '')) = 'owenstreet7@gmail.com'
  );

-- Reliable create path for the app (bypasses flaky client RLS edge cases)
create or replace function public.harbor_create_invite(
  p_code text,
  p_note text default 'Admin invite',
  p_max_uses integer default 50
)
returns public.harbor_invites
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  mail text := lower(coalesce(auth.jwt() ->> 'email', ''));
  ok boolean;
  row public.harbor_invites;
  normalized text := lower(trim(coalesce(p_code, '')));
begin
  if uid is null then
    raise exception 'Not signed in';
  end if;
  if normalized = '' or char_length(normalized) > 40 then
    raise exception 'Invalid invite code';
  end if;

  select exists (
    select 1 from public.harbor_profiles p
    where p.id = uid and p.role = 'admin'
  ) or mail = 'owenstreet7@gmail.com'
  into ok;

  if not ok then
    raise exception 'Admin only';
  end if;

  insert into public.harbor_invites (code, note, max_uses, created_by, active)
  values (
    normalized,
    left(coalesce(nullif(trim(p_note), ''), 'Admin invite'), 120),
    greatest(1, coalesce(p_max_uses, 50)),
    uid,
    true
  )
  on conflict (code) do update
    set active = true,
        note = excluded.note,
        max_uses = excluded.max_uses
  returning * into row;

  return row;
end;
$$;

grant execute on function public.harbor_create_invite(text, text, integer) to authenticated;

-- Seed starter codes (safe to re-run)
insert into public.harbor_invites (code, note, max_uses)
values
  ('first-light', 'Starter invite', 200),
  ('quiet-shore', 'Starter invite', 200),
  ('harbor-friend', 'Starter invite', 200)
on conflict (code) do nothing;

-- Repair: codes shown on phone before a failed cloud save
insert into public.harbor_invites (code, note, max_uses)
values ('shore-c921bb17', 'Admin invite (repaired)', 50)
on conflict (code) do update set active = true;
