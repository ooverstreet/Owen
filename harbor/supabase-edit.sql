-- Harbor message editing — run once in Supabase SQL Editor
-- Lets signed-in authors edit their own posts/replies.

alter table public.harbor_posts
  add column if not exists user_id uuid references auth.users(id) on delete set null,
  add column if not exists edited_at timestamptz;

alter table public.harbor_replies
  add column if not exists user_id uuid references auth.users(id) on delete set null,
  add column if not exists edited_at timestamptz;

create index if not exists harbor_posts_user_id_idx on public.harbor_posts (user_id);
create index if not exists harbor_replies_user_id_idx on public.harbor_replies (user_id);

-- Stamp author on insert when a session is present
create or replace function public.harbor_stamp_message_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is not null then
    new.user_id := auth.uid();
  end if;
  return new;
end;
$$;

drop trigger if exists harbor_posts_stamp_user on public.harbor_posts;
create trigger harbor_posts_stamp_user
  before insert on public.harbor_posts
  for each row execute function public.harbor_stamp_message_user();

drop trigger if exists harbor_replies_stamp_user on public.harbor_replies;
create trigger harbor_replies_stamp_user
  before insert on public.harbor_replies
  for each row execute function public.harbor_stamp_message_user();

create or replace function public.harbor_edit_post(
  p_id text,
  p_body text,
  p_device_id text default null
)
returns public.harbor_posts
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  cleaned text := trim(coalesce(p_body, ''));
  row public.harbor_posts;
begin
  if uid is null then
    raise exception 'Not signed in';
  end if;
  if cleaned = '' or char_length(cleaned) > 4000 then
    raise exception 'Invalid message';
  end if;
  if p_id = 'harbor-first-light' then
    raise exception 'That post can’t be edited';
  end if;

  update public.harbor_posts
  set body = cleaned,
      edited_at = now()
  where id = p_id
    and (
      user_id = uid
      or (
        user_id is null
        and p_device_id is not null
        and device_id is not null
        and device_id = p_device_id
      )
      or (
        user_id is null
        and author_mode = 'named'
        and lower(author_name) = lower(coalesce(
          (select p.display_name from public.harbor_profiles p where p.id = uid),
          split_part(coalesce(auth.jwt() ->> 'email', ''), '@', 1)
        ))
      )
    )
  returning * into row;

  if row.id is null then
    raise exception 'Not allowed to edit';
  end if;
  return row;
end;
$$;

create or replace function public.harbor_edit_reply(
  p_id text,
  p_body text,
  p_device_id text default null
)
returns public.harbor_replies
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  cleaned text := trim(coalesce(p_body, ''));
  row public.harbor_replies;
begin
  if uid is null then
    raise exception 'Not signed in';
  end if;
  if cleaned = '' or char_length(cleaned) > 2000 then
    raise exception 'Invalid message';
  end if;

  update public.harbor_replies
  set body = cleaned,
      edited_at = now()
  where id = p_id
    and (
      user_id = uid
      or (
        user_id is null
        and p_device_id is not null
        and device_id is not null
        and device_id = p_device_id
      )
      or (
        user_id is null
        and author_mode = 'named'
        and lower(author_name) = lower(coalesce(
          (select p.display_name from public.harbor_profiles p where p.id = uid),
          split_part(coalesce(auth.jwt() ->> 'email', ''), '@', 1)
        ))
      )
    )
  returning * into row;

  if row.id is null then
    raise exception 'Not allowed to edit';
  end if;
  return row;
end;
$$;

grant execute on function public.harbor_edit_post(text, text, text) to authenticated;
grant execute on function public.harbor_edit_reply(text, text, text) to authenticated;

-- Backfill ownership for early posts (Owen’s account + matching display names)
update public.harbor_posts p
set user_id = u.id
from auth.users u
where lower(u.email) = 'owenstreet7@gmail.com'
  and p.user_id is null
  and p.id <> 'harbor-first-light'
  and lower(p.author_name) in (
    'owen1',
    'owen',
    lower(coalesce((select display_name from public.harbor_profiles where id = u.id), '')),
    lower(split_part(u.email, '@', 1))
  );

update public.harbor_replies r
set user_id = u.id
from auth.users u
where lower(u.email) = 'owenstreet7@gmail.com'
  and r.user_id is null
  and lower(r.author_name) in (
    'owen1',
    'owen',
    lower(coalesce((select display_name from public.harbor_profiles where id = u.id), '')),
    lower(split_part(u.email, '@', 1))
  );
