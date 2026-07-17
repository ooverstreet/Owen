-- Harbor Auth + roles — run once in Supabase SQL Editor
-- Makes owenstreet7@gmail.com an admin automatically on signup/login profile create.

create table if not exists harbor_profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  display_name text,
  role text not null default 'member' check (role in ('member', 'admin')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists harbor_profiles_email_idx on harbor_profiles (lower(email));

alter table harbor_profiles enable row level security;

drop policy if exists "harbor_profiles_read_own" on harbor_profiles;
create policy "harbor_profiles_read_own" on harbor_profiles
  for select using (auth.uid() = id);

drop policy if exists "harbor_profiles_update_own_name" on harbor_profiles;
create policy "harbor_profiles_update_own_name" on harbor_profiles
  for update using (auth.uid() = id)
  with check (auth.uid() = id and role = (select role from harbor_profiles where id = auth.uid()));

-- Admins can read all profiles
drop policy if exists "harbor_profiles_admin_read" on harbor_profiles;
create policy "harbor_profiles_admin_read" on harbor_profiles
  for select using (
    exists (
      select 1 from harbor_profiles p
      where p.id = auth.uid() and p.role = 'admin'
    )
  );

create or replace function public.harbor_handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  assigned_role text := 'member';
begin
  if lower(coalesce(new.email, '')) = 'owenstreet7@gmail.com' then
    assigned_role := 'admin';
  end if;

  insert into public.harbor_profiles (id, email, display_name, role)
  values (
    new.id,
    new.email,
    coalesce(split_part(new.email, '@', 1), 'Harbor friend'),
    assigned_role
  )
  on conflict (id) do update
    set email = excluded.email,
        role = case
          when lower(coalesce(excluded.email, '')) = 'owenstreet7@gmail.com' then 'admin'
          else harbor_profiles.role
        end,
        updated_at = now();

  return new;
end;
$$;

drop trigger if exists harbor_on_auth_user_created on auth.users;
create trigger harbor_on_auth_user_created
  after insert on auth.users
  for each row execute function public.harbor_handle_new_user();

-- If Owen already has an auth user, create/promote profile now
insert into public.harbor_profiles (id, email, display_name, role)
select
  u.id,
  u.email,
  coalesce(split_part(u.email, '@', 1), 'Harbor friend'),
  'admin'
from auth.users u
where lower(u.email) = 'owenstreet7@gmail.com'
on conflict (id) do update
  set email = excluded.email,
      role = 'admin',
      updated_at = now();

update public.harbor_profiles
set role = 'admin', updated_at = now()
where lower(email) = 'owenstreet7@gmail.com';

-- Helper for edge functions / clients
create or replace function public.harbor_is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.harbor_profiles
    where id = auth.uid() and role = 'admin'
  );
$$;

grant execute on function public.harbor_is_admin() to authenticated, anon;
