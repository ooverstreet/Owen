-- Harbor guidelines acceptance on profiles — run once in Supabase SQL Editor
-- Lets agreement follow the signed-in account across refresh/devices.

alter table public.harbor_profiles
  add column if not exists guidelines_accepted_at timestamptz;

-- Optional: if Owen already agreed in spirit, leave null until they tap Agree once more
-- (localStorage still covers that device until this sync runs).
