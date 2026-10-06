-- ============================================================================
-- Migration 016 - competitive exams on the board
--
-- Run this in the Supabase SQL editor. Safe to re-run.
--
-- Exams arrive from the tracker as kind = 'exam'. The events table takes them
-- as they are - kind has no check constraint - but upcoming_events does not:
-- it requires a registration deadline, which is the right rule for a hackathon
-- and the wrong one for CAT or UPSC. Those run every year; a page that has not
-- yet announced its dates is not a closed exam, and dropping it would leave the
-- new section empty for most of the year.
--
-- So exams are exempt from the date window and nothing else changes. A hackathon
-- still has to tell us when registration closes before it is listed.
-- ============================================================================

create or replace view public.upcoming_events
with (security_invoker = true) as
    select e.*,
           e.deadline as next_date,
           e.deadline as expires_on,
           (
               case e.poster_status when 'ok' then 30 when 'thumbnail' then 12 else 0 end
             + least(public.digits_value(e.participants) / 50.0, 25)
             + least(public.prize_value(e.prize) / 20000.0, 25)
             + case when e.tracker_status = 'NEW' then 10 else 0 end
             + case when coalesce(e.eligibility, '') <> ''
                     and e.eligibility not like 'Not stated%' then 5 else 0 end
             + case when e.deadline - current_date between 0 and 14 then 8 else 0 end
           )::numeric(6,2) as score
      from public.events e
     where e.kind = 'exam'
        or (e.deadline is not null and e.deadline >= current_date)
     order by e.recommended desc, score desc, e.deadline, e.title;

-- create or replace keeps the existing grants, but state them anyway so a fresh
-- database ends up in the same place. anon is left out on purpose - only signed-in
-- students should read the listings.
revoke all on public.upcoming_events from anon;
grant select on public.upcoming_events to authenticated;

-- How many of each kind are listed right now:
--   select kind, count(*) from public.upcoming_events group by kind order by kind;
