-- ============================================================================
-- Migration 011 - somewhere to put pasted posters
--
-- Run in the Supabase SQL editor. Safe to re-run.
--
-- "Copy image" puts the picture itself on the clipboard, not its address, so
-- pasting it into a text box does nothing. The add-event form now accepts a
-- pasted image and uploads it here, then stores the resulting public URL on the
-- event like any other poster.
--
-- Deleting and editing events needs nothing new: the "owner manages events"
-- policy from 010 already covers update and delete for the owner.
-- ============================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
    'posters', 'posters', true, 5242880,          -- 5 MB is plenty for a poster
    array['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif']
)
on conflict (id) do update set
    public             = true,
    file_size_limit    = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;


-- Anyone may look at a poster: they are shown on cards to every signed-in
-- student, and the bucket is public so the browser can load them directly.
drop policy if exists "posters are readable" on storage.objects;
create policy "posters are readable" on storage.objects
    for select using (bucket_id = 'posters');

-- Only the owner may put one there, replace it, or remove it. Without this any
-- signed-in student could upload files to your project.
drop policy if exists "owner uploads posters" on storage.objects;
create policy "owner uploads posters" on storage.objects
    for insert to authenticated
    with check (bucket_id = 'posters' and public.is_owner());

drop policy if exists "owner replaces posters" on storage.objects;
create policy "owner replaces posters" on storage.objects
    for update to authenticated
    using (bucket_id = 'posters' and public.is_owner())
    with check (bucket_id = 'posters' and public.is_owner());

drop policy if exists "owner removes posters" on storage.objects;
create policy "owner removes posters" on storage.objects
    for delete to authenticated
    using (bucket_id = 'posters' and public.is_owner());

-- Check it exists:
--   select id, public, file_size_limit from storage.buckets where id = 'posters';
