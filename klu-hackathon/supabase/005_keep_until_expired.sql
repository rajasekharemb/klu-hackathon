-- ============================================================================
-- Migration 005 - stop events disappearing before they have actually expired
--
-- Run in the Supabase SQL editor. Safe to re-run.
--
-- The old filter was:
--     where coalesce(deadline, end_date, start_date) >= current_date - 1
--
-- Two things were wrong with it:
--
--   1. coalesce() returns the FIRST non-null value, which is the deadline. A
--      hackathon with a 1 Oct deadline that actually runs 10-12 Oct was hidden
--      from 2 Oct - while it was still to come. greatest() takes the LAST date
--      instead, so an event stays listed until everything about it is past.
--
--   2. When all three dates were null the comparison evaluated to NULL, which is
--      not true, so the row was filtered out. Events with no announced dates -
--      Smart India Hackathon, for one - vanished entirely. They are now kept and
--      sort last.
--
-- greatest() ignores nulls in Postgres, so a row with only a start_date is judged
-- on that date alone.
-- ============================================================================

create or replace view public.upcoming_events as
    select *,
           coalesce(deadline, start_date, end_date)      as next_date,
           greatest(deadline, end_date, start_date)      as expires_on
      from public.events
     where greatest(deadline, end_date, start_date) is null              -- dates not announced yet
        or greatest(deadline, end_date, start_date) >= current_date - 1  -- still to come
     order by coalesce(deadline, start_date, end_date) nulls last, title;

-- Check what this now keeps that it used to drop:
--   select title, start_date, end_date, deadline
--     from public.events
--    where greatest(deadline, end_date, start_date) is null
--       or greatest(deadline, end_date, start_date) >= current_date - 1;
