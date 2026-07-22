-- Harbor profile photos (optional)
-- Run in Supabase SQL Editor (safe to re-run).
-- If photo save shows “infinite recursion … harbor_profiles”, also run:
--   supabase-profiles-rls-fix.sql

alter table public.harbor_profiles
  add column if not exists avatar_url text;

-- Authenticated members can read basic profile fields (for shore avatars).
-- Email remains on the row; only signed-in users can query profiles.
drop policy if exists "harbor_profiles_authenticated_read" on public.harbor_profiles;
create policy "harbor_profiles_authenticated_read" on public.harbor_profiles
  for select to authenticated
  using (true);

-- Public avatar storage bucket
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'harbor-avatars',
  'harbor-avatars',
  true,
  2097152,
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "harbor_avatars_public_read" on storage.objects;
create policy "harbor_avatars_public_read" on storage.objects
  for select using (bucket_id = 'harbor-avatars');

drop policy if exists "harbor_avatars_own_upload" on storage.objects;
create policy "harbor_avatars_own_upload" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'harbor-avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "harbor_avatars_own_update" on storage.objects;
create policy "harbor_avatars_own_update" on storage.objects
  for update to authenticated
  using (
    bucket_id = 'harbor-avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  )
  with check (
    bucket_id = 'harbor-avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "harbor_avatars_own_delete" on storage.objects;
create policy "harbor_avatars_own_delete" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'harbor-avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
