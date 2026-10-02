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
--   2. Registrations are cleared 15 days after the event finishes. Events are
--      upserted and never deleted, so without this the table grows for ever.
-- ============================================================================

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

-- Called by the nightly job. Fifteen days after an event finishes, nobody needs
-- the record that a student clicked through to it.
--
-- end_date first, then start_date, then deadline - a one-day event has no
-- end_date, and an event with only a deadline never advertised a run date. Rows
-- whose event has no date at all are left alone rather than guessed at.
create or replace function public.purge_old_registrations()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare v_count integer;
begin
    delete from public.event_registrations r
     using public.events e
     where e.id = r.event_id
       and coalesce(e.end_date, e.start_date, e.deadline) is not null
       and coalesce(e.end_date, e.start_date, e.deadline) < current_date - 15;
    get diagnostics v_count = row_count;
    return v_count;
end;
$$;

revoke all on function public.purge_old_registrations() from anon, authenticated;

-- What is due to go at the next refresh:
--   select count(*) from public.event_registrations r join public.events e on e.id = r.event_id
--    where coalesce(e.end_date, e.start_date, e.deadline) < current_date - 15;
