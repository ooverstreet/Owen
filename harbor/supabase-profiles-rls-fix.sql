-- Fix harbor_profiles RLS infinite recursion (photo upload / profile update)
-- Run once in Supabase SQL Editor (safe to re-run).

-- Helper: read role without re-entering RLS policies
create or replace function public.harbor_profile_role(uid uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select role from public.harbor_profiles where id = uid;
$$;

revoke all on function public.harbor_profile_role(uuid) from public;
grant execute on function public.harbor_profile_role(uuid) to authenticated;

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
      public.harbor_profile_role(auth.uid()) = 'admin'
      or lower(coalesce(auth.jwt() ->> 'email', '')) = 'owenstreet7@gmail.com'
    );
$$;

grant execute on function public.harbor_caller_is_admin() to authenticated;

-- Update own row without recursive SELECT on harbor_profiles
drop policy if exists "harbor_profiles_update_own_name" on public.harbor_profiles;
create policy "harbor_profiles_update_own_name" on public.harbor_profiles
  for update
  using (auth.uid() = id)
  with check (
    auth.uid() = id
    and role = public.harbor_profile_role(auth.uid())
  );

-- Admin read without recursive policy lookup
drop policy if exists "harbor_profiles_admin_read" on public.harbor_profiles;
create policy "harbor_profiles_admin_read" on public.harbor_profiles
  for select
  using (public.harbor_caller_is_admin());

-- Keep authenticated avatar/name lookup for the shore feed
drop policy if exists "harbor_profiles_authenticated_read" on public.harbor_profiles;
create policy "harbor_profiles_authenticated_read" on public.harbor_profiles
  for select to authenticated
  using (true);
