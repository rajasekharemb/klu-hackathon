-- ============================================================================
-- Migration 015 - one confirmation per event, and registrations that clear out
--
-- Run this in the Supabase SQL editor. Safe to re-run.
--
-- Two things:
--
--   1. Pressing "I registered - fill the KLU form" twice is one registration,
--      not two. The unique (student_id, event_id) constraint already kept it to
--      one row, but the page overwrote confirmed_at on every press, so the admin
--      report showed the last time the button was pressed rather than when the
--      student actually entered. It also bumped times_clicked, which is meant to
--      count visits to the event's own page.
--
--   2. A student stops seeing a registration 15 days after the event finishes.
--      Nothing is deleted - the admin and owner keep the whole log for ever.
--      This is a view over the same rows, not a purge.
-- ============================================================================

-- An earlier draft of this migration deleted old registrations. It must not:
-- that log is the college's record of who entered what, and the admin page is
-- the only place it exists. Dropped here in case that draft was run.
drop function if exists public.purge_old_registrations();

-- Sets or clears the confirmation for the signed-in student. Security definer so
-- it can insert the row when a student presses "I registered" without having
-- opened the event page first; it still only ever touches auth.uid()'s own row.
create or replace function public.confirm_registration(
    p_event_id bigint,
    p_on       boolean default true
)
returns timestamptz
language plpgsql
security definer
set search_path = public
as $$
declare
    v_title text;
    v_at    timestamptz;
begin
    if auth.uid() is null then
        raise exception 'Not signed in';
    end if;

    select title into v_title from public.events where id = p_event_id;
    if v_title is null then
        raise exception 'No such event: %', p_event_id;
    end if;

    insert into public.event_registrations
                (student_id, event_id, event_title, confirmed, confirmed_at)
         values (auth.uid(), p_event_id, v_title, p_on,
                 case when p_on then now() end)
    on conflict (student_id, event_id) do update
        set confirmed = p_on,
            -- The first confirmation stands. Pressing the button again just
            -- reopens the form - it is not a second registration, and replacing
            -- this would lose when the student actually entered.
            confirmed_at = case
                               when not p_on then null
                               else coalesce(public.event_registrations.confirmed_at, now())
                           end,
            event_title  = excluded.event_title
      returning confirmed_at into v_at;

    return v_at;
end;
$$;

grant execute on function public.confirm_registration(bigint, boolean) to authenticated;

-- What a student sees under "My registrations": the events they confirmed, kept
-- for 15 days after the event finishes and then simply no longer listed.
--
-- This is also why it is a view rather than a filter on upcoming_events - that
-- one ends at the registration deadline, so a student lost sight of an event the
-- day after entries closed, which is precisely when they want to check what they
-- entered.
--
-- security_invoker, so row level security still decides which rows are readable;
-- the student_id test here is what makes it personal rather than a listing.
create or replace view public.my_registrations
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
           )::numeric(6,2) as score,
           r.confirmed_at
      from public.events e
      join public.event_registrations r on r.event_id = e.id
     where r.student_id = auth.uid()
       and r.confirmed
       and (
             coalesce(e.end_date, e.start_date, e.deadline) is null
          or coalesce(e.end_date, e.start_date, e.deadline) >= current_date - 15
           );

revoke all on public.my_registrations from anon;
grant select on public.my_registrations to authenticated;

-- The admin's Confirmed registrations table reads event_registrations directly
-- through admin_registrations(), which has no date window at all - so the full
-- history stays visible there however old the event is.
