-- ============================================================================
-- Migration 008 - show only events you can still register for
--
-- Run in the Supabase SQL editor. Safe to re-run.
--
-- The rule is now strict and easy to state:
--
--     an event appears only if it has a registration deadline,
--     and that deadline has not passed.
--
-- This replaces 005, which kept an event until its LAST date passed and kept
-- undated events indefinitely. The trade-off is deliberate: roughly 44 of 424
-- events publish no deadline (mostly HackIndia and Devfolio, which show event
-- dates but no separate closing date). They are still collected into
-- public.events - nothing is thrown away - they simply do not appear in the
-- portal, because there is no way to tell a student whether they can still enter.
--
-- To see them again, swap the where clause back to the 005 version.
-- ============================================================================

create or replace view public.upcoming_events as
    select *,
           deadline as next_date,
           deadline as expires_on
      from public.events
     where deadline is not null          -- we must know when registration closes
       and deadline >= current_date      -- and it must not have closed yet
     order by deadline, title;

-- What is being held back, and why:
--   select source, count(*)
--     from public.events
--    where deadline is null
--    group by source order by 2 desc;
