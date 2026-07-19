-- Harbor language strikes: warn once, ban next, alert admin
-- Run in Supabase SQL Editor (safe to re-run).
-- Requires harbor_profiles + harbor_bans (auth + moderation SQL).

-- Strike fields on profiles
alter table public.harbor_profiles
  add column if not exists strike_count integer not null default 0,
  add column if not exists warned_at timestamptz,
  add column if not exists last_strike_at timestamptz;

-- Allow bans keyed to auth user id
do $$
begin
  alter table public.harbor_bans drop constraint if exists harbor_bans_ban_type_check;
exception when undefined_object then null;
end $$;

alter table public.harbor_bans
  drop constraint if exists harbor_bans_ban_type_check;

alter table public.harbor_bans
  add constraint harbor_bans_ban_type_check
  check (ban_type in ('device', 'username', 'user'));

-- Admin inbox for warnings / bans
create table if not exists public.harbor_mod_alerts (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('warning', 'ban')),
  user_id uuid references auth.users(id) on delete set null,
  email text,
  display_name text,
  device_id text,
  username text,
  match_text text,
  sample_text text,
  created_at timestamptz not null default now(),
  read_at timestamptz
);

create index if not exists harbor_mod_alerts_created_idx
  on public.harbor_mod_alerts (created_at desc);

create index if not exists harbor_mod_alerts_unread_idx
  on public.harbor_mod_alerts (created_at desc)
  where read_at is null;

alter table public.harbor_mod_alerts enable row level security;

create or replace function public.harbor_caller_is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    auth.uid() is not null
    and (
      exists (
        select 1 from public.harbor_profiles p
        where p.id = auth.uid() and p.role = 'admin'
      )
      or lower(coalesce(auth.jwt() ->> 'email', '')) = 'owenstreet7@gmail.com'
    );
$$;

grant execute on function public.harbor_caller_is_admin() to authenticated;

drop policy if exists "harbor_mod_alerts_admin_read" on public.harbor_mod_alerts;
create policy "harbor_mod_alerts_admin_read" on public.harbor_mod_alerts
  for select using (public.harbor_caller_is_admin());

drop policy if exists "harbor_mod_alerts_admin_update" on public.harbor_mod_alerts;
create policy "harbor_mod_alerts_admin_update" on public.harbor_mod_alerts
  for update using (public.harbor_caller_is_admin())
  with check (public.harbor_caller_is_admin());

create or replace function public.harbor_apply_language_strike(
  p_sample text default null,
  p_match text default null,
  p_device_id text default null,
  p_username text default null,
  p_target_user_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  caller uuid := auth.uid();
  target uuid;
  prof public.harbor_profiles%rowtype;
  next_strikes integer;
  kind text;
  alert_id uuid;
  sample text := left(coalesce(nullif(trim(p_sample), ''), '[blocked language]'), 500);
  match_txt text := left(coalesce(nullif(trim(p_match), ''), 'blocked language'), 120);
  uname text := left(lower(coalesce(nullif(trim(p_username), ''), '')), 64);
  did text := left(coalesce(nullif(trim(p_device_id), ''), ''), 80);
begin
  if caller is null then
    raise exception 'Sign in required';
  end if;

  -- Admins applying a strike to someone else (e.g. after Clean language)
  if p_target_user_id is not null then
    if not public.harbor_caller_is_admin() then
      raise exception 'Admin only';
    end if;
    target := p_target_user_id;
  else
    -- Members can only strike themselves (blocked post/reply attempt)
    target := caller;
  end if;

  -- Never strike the host / admins
  if exists (
    select 1 from public.harbor_profiles p
    where p.id = target and (p.role = 'admin' or lower(coalesce(p.email, '')) = 'owenstreet7@gmail.com')
  ) then
    return jsonb_build_object('status', 'skipped', 'reason', 'admin');
  end if;

  insert into public.harbor_profiles (id, email, display_name, role)
  values (
    target,
    coalesce((select email from auth.users where id = target), null),
    coalesce(
      (select split_part(email, '@', 1) from auth.users where id = target),
      'Harbor friend'
    ),
    'member'
  )
  on conflict (id) do nothing;

  select * into prof from public.harbor_profiles where id = target for update;
  if prof.id is null then
    raise exception 'Profile not found';
  end if;

  next_strikes := coalesce(prof.strike_count, 0) + 1;
  kind := case when next_strikes >= 2 then 'ban' else 'warning' end;

  update public.harbor_profiles
  set strike_count = next_strikes,
      last_strike_at = now(),
      warned_at = case when next_strikes = 1 then now() else warned_at end,
      updated_at = now()
  where id = target;

  insert into public.harbor_mod_alerts (
    kind, user_id, email, display_name, device_id, username, match_text, sample_text
  ) values (
    kind,
    target,
    prof.email,
    coalesce(nullif(trim(prof.display_name), ''), split_part(coalesce(prof.email, ''), '@', 1), 'member'),
    nullif(did, ''),
    nullif(uname, ''),
    match_txt,
    sample
  )
  returning id into alert_id;

  insert into public.harbor_moderation_events (
    id, action, target_type, target_id, actor, reason, meta
  ) values (
    coalesce(gen_random_uuid()::text, replace(alert_id::text, '-', '')),
    case when kind = 'ban' then 'language_ban' else 'language_warning' end,
    'user',
    target::text,
    case when p_target_user_id is not null then 'admin' else 'system' end,
    match_txt,
    jsonb_build_object(
      'strikes', next_strikes,
      'sample', sample,
      'device_id', did,
      'username', uname,
      'alert_id', alert_id
    )
  );

  if kind = 'ban' then
    -- Partial unique index on active bans — ignore duplicates
    if not exists (
      select 1 from public.harbor_bans
      where active and ban_type = 'user' and ban_value = lower(target::text)
    ) then
      insert into public.harbor_bans (id, ban_type, ban_value, reason, active, created_by)
      values (
        'ban-user-' || target::text,
        'user',
        lower(target::text),
        'Second language strike — automatic ban',
        true,
        'system'
      );
    end if;

    if did <> '' and not exists (
      select 1 from public.harbor_bans
      where active and ban_type = 'device' and ban_value = did
    ) then
      insert into public.harbor_bans (id, ban_type, ban_value, reason, active, created_by)
      values (
        'ban-device-' || md5(did),
        'device',
        did,
        'Second language strike — automatic ban',
        true,
        'system'
      );
    end if;

    if uname <> '' and uname <> 'anonymous' and not exists (
      select 1 from public.harbor_bans
      where active and ban_type = 'username' and ban_value = uname
    ) then
      insert into public.harbor_bans (id, ban_type, ban_value, reason, active, created_by)
      values (
        'ban-name-' || md5(uname),
        'username',
        uname,
        'Second language strike — automatic ban',
        true,
        'system'
      );
    end if;
  end if;

  return jsonb_build_object(
    'status', kind,
    'strikes', next_strikes,
    'alertId', alert_id,
    'userId', target,
    'email', prof.email,
    'displayName', prof.display_name,
    'match', match_txt,
    'sample', sample,
    'message', case
      when kind = 'ban' then
        'Your account has been banned from posting for repeated harmful language.'
      else
        'This language isn’t welcome in Harbor. This is your formal warning — another time will ban your account.'
    end
  );
end;
$$;

grant execute on function public.harbor_apply_language_strike(text, text, text, text, uuid) to authenticated;

create or replace function public.harbor_mark_mod_alert_read(p_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.harbor_caller_is_admin() then
    raise exception 'Admin only';
  end if;
  update public.harbor_mod_alerts
  set read_at = coalesce(read_at, now())
  where id = p_id;
  return found;
end;
$$;

grant execute on function public.harbor_mark_mod_alert_read(uuid) to authenticated;
