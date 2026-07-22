-- Harbor activity tracking + avatar cleanup on account removal
-- Run in Supabase SQL Editor (safe to re-run).

alter table public.harbor_profiles
  add column if not exists last_active_at timestamptz,
  add column if not exists password_changed_at timestamptz;

alter table public.harbor_profiles
  alter column last_active_at set default now();

update public.harbor_profiles
set last_active_at = coalesce(last_active_at, created_at, now())
where last_active_at is null;

-- Touch activity (throttled in app; safe to call often)
create or replace function public.harbor_touch_activity()
returns timestamptz
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  stamp timestamptz := now();
begin
  if uid is null then
    raise exception 'Not signed in';
  end if;
  update public.harbor_profiles
  set last_active_at = stamp,
      updated_at = stamp
  where id = uid;
  return stamp;
end;
$$;

grant execute on function public.harbor_touch_activity() to authenticated;

-- Mark password rotated (call after successful client password update)
create or replace function public.harbor_mark_password_changed()
returns timestamptz
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  stamp timestamptz := now();
begin
  if uid is null then
    raise exception 'Not signed in';
  end if;
  update public.harbor_profiles
  set password_changed_at = stamp,
      last_active_at = stamp,
      updated_at = stamp
  where id = uid;
  return stamp;
end;
$$;

grant execute on function public.harbor_mark_password_changed() to authenticated;

-- Delete avatar files when a profile row is removed (account deletion)
create or replace function public.harbor_cleanup_profile_storage()
returns trigger
language plpgsql
security definer
set search_path = public, storage
as $$
begin
  delete from storage.objects
  where bucket_id = 'harbor-avatars'
    and (
      name = old.id::text || '/avatar.jpg'
      or name like old.id::text || '/%'
    );
  return old;
end;
$$;

drop trigger if exists harbor_profiles_cleanup_storage on public.harbor_profiles;
create trigger harbor_profiles_cleanup_storage
  before delete on public.harbor_profiles
  for each row execute function public.harbor_cleanup_profile_storage();
