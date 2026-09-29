-- ============================================================================
-- Migration 007 - deleting registrations is owner-only
--
-- Run in the Supabase SQL editor after 006. Safe to re-run.
--
-- 004 gave the delete policy to is_admin(), so every admin could remove
-- registration records. The intent is: admins VIEW everything, the owner is the
-- only one who CHANGES anything.
-- ============================================================================

drop policy if exists "admins delete regs" on public.event_registrations;
drop policy if exists "owner deletes regs" on public.event_registrations;

create policy "owner deletes regs" on public.event_registrations
    for delete to authenticated using (public.is_owner());

-- Students keep "own registrations" from 002, so a student can still undo their
-- own entry. Only the owner can delete somebody else's.

-- Confirm who can do what:
--   select email, role from public.profiles order by role, email;
