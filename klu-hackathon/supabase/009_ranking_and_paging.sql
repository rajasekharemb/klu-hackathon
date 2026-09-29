-- ============================================================================
-- Migration 009 - rank events, and let the portal fetch them a page at a time
--
-- Run in the Supabase SQL editor. Safe to re-run.
--
-- Two changes:
--
--   1. a `score` column, so the best events load first. There is no such thing as
--      a "rating" on these listings, so this is a prominence score built from
--      signals that actually exist - a verified poster, prize money, how many
--      have already registered, how complete the record is, and whether the
--      deadline is close. It is a reading order, not a judgement of quality, and
--      the components are listed below so the ordering can be checked.
--
--   2. security_invoker on the view. Supabase flagged upcoming_events as
--      UNRESTRICTED: a plain view runs as its owner and bypasses the RLS on
--      public.events, so the listings were readable by anyone holding the anon
--      key, signed in or not. With security_invoker the caller's own permissions
--      apply, so the "signed-in students read events" policy is enforced.
-- ============================================================================

-- "₹1,00,000" -> 100000, "₹3 Lakh" -> 300000, "₹2 crore" -> 20000000
create or replace function public.prize_value(p text)
returns numeric
language sql
immutable
as $$
    select case
        when p is null or btrim(p) = '' then 0
        else coalesce(nullif(regexp_replace(p, '[^0-9]', '', 'g'), '')::numeric, 0)
             * case
                 when p ilike '%crore%' then 10000000
                 when p ilike '%lakh%'  then 100000
                 else 1
               end
    end;
$$;

create or replace function public.digits_value(p text)
returns numeric
language sql
immutable
as $$
    select coalesce(nullif(regexp_replace(coalesce(p, ''), '[^0-9]', '', 'g'), '')::numeric, 0);
$$;

create or replace view public.upcoming_events
with (security_invoker = true) as
    select e.*,
           e.deadline as next_date,
           e.deadline as expires_on,
           (
               -- a real poster is the single biggest difference to how a card reads
               case e.poster_status when 'ok' then 30 when 'thumbnail' then 12 else 0 end
               -- popularity, capped so one huge event cannot dominate the page
             + least(public.digits_value(e.participants) / 50.0, 25)
               -- prize money, capped the same way
             + least(public.prize_value(e.prize) / 20000.0, 25)
               -- newly found events deserve a look before ones seen for weeks
             + case when e.tracker_status = 'NEW' then 10 else 0 end
               -- a record that states who may enter is more useful than one that does not
             + case when coalesce(e.eligibility, '') <> ''
                     and e.eligibility not like 'Not stated%' then 5 else 0 end
               -- closing soon: worth seeing before it is too late
             + case when e.deadline - current_date between 0 and 14 then 8 else 0 end
           )::numeric(6,2) as score
      from public.events e
     where e.deadline is not null
       and e.deadline >= current_date
     order by score desc, e.deadline, e.title;

-- Inspect the ranking:
--   select title, score, poster_status, participants, prize, deadline
--     from public.upcoming_events order by score desc limit 20;
