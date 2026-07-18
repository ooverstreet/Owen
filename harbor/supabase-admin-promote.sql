-- Promote Owen to Harbor admin — run once in Supabase SQL Editor

update public.harbor_profiles
set role = 'admin', updated_at = now()
where lower(email) = 'owenstreet7@gmail.com';

-- If profile row is missing, create it from auth.users
insert into public.harbor_profiles (id, email, display_name, role)
select
  u.id,
  u.email,
  coalesce(split_part(u.email, '@', 1), 'Harbor friend'),
  'admin'
from auth.users u
where lower(u.email) = 'owenstreet7@gmail.com'
on conflict (id) do update
  set role = 'admin',
      email = excluded.email,
      updated_at = now();
