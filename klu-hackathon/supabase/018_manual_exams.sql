-- ============================================================================
-- Migration 018 - add a competitive exam by link
--
-- Run this in the Supabase SQL editor. Safe to re-run.
--
-- Two changes to add_manual_event():
--
--   1. 'exam' joins 'open' and 'hiring' as a kind the owner can choose.
--   2. The registration deadline stops being required for exams. It stays
--      required for everything else, because upcoming_events will not list a
--      hackathon without one - but an exam is exempt from that gate (016), and
--      most of these sites have not announced a date. Demanding one would mean
--      inventing it.
-- ============================================================================

create or replace function public.add_manual_event(
    p_url         text,
    p_title       text,
    p_kind        text,
    p_deadline    date,
    p_start       date default null,
    p_end         date default null,
    p_poster_url  text default null,
    p_organizer   text default null,
    p_location    text default null,
    p_description text default null,
    p_prize       text default null,
    p_eligibility text default null
)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare v_id bigint; v_key text;
begin
    if not public.is_owner() then
        raise exception 'Only the owner can add events';
    end if;
    if coalesce(btrim(p_title), '') = '' or coalesce(btrim(p_url), '') = '' then
        raise exception 'A title and a link are both required';
    end if;
    if p_kind not in ('open', 'hiring', 'exam') then
        raise exception 'Kind must be open, hiring or exam';
    end if;
    if p_deadline is null and p_kind <> 'exam' then
        raise exception 'A registration deadline is required, or the event cannot be shown';
    end if;

    -- Keyed on the link so adding the same page twice updates rather than duplicates,
    -- and so the nightly job (which keys differently) never overwrites it.
    v_key := 'manual:' || lower(btrim(p_url));

    insert into public.events (
        key, title, source, kind, scope, url, registration_url,
        start_date, end_date, deadline, mode, location, organizer,
        prize, eligibility, description, poster_url, poster_status,
        tracker_status, first_seen, last_seen, times_seen, added_by
    ) values (
        v_key, btrim(p_title), 'Added by KLU', p_kind, 'national', btrim(p_url), btrim(p_url),
        p_start, p_end, p_deadline, 'unknown', p_location, p_organizer,
        p_prize, p_eligibility, p_description, p_poster_url,
        case when coalesce(p_poster_url, '') = '' then 'none' else 'ok' end,
        'NEW', current_date, current_date, 1, auth.uid()
    )
    -- Unchanged from 010. times_seen is deliberately left alone: re-adding the
    -- same link corrects the entry, it does not mean the tracker saw it again.
    on conflict (key) do update set
        title = excluded.title, kind = excluded.kind, url = excluded.url,
        registration_url = excluded.registration_url, start_date = excluded.start_date,
        end_date = excluded.end_date, deadline = excluded.deadline,
        location = excluded.location, organizer = excluded.organizer,
        prize = excluded.prize, eligibility = excluded.eligibility,
        description = excluded.description, poster_url = excluded.poster_url,
        poster_status = excluded.poster_status, last_seen = current_date
    returning id into v_id;

    return v_id;
end;
$$;

revoke all on function public.add_manual_event(text, text, text, date, date, date, text, text, text, text, text, text) from anon;
grant execute on function public.add_manual_event(text, text, text, date, date, date, text, text, text, text, text, text) to authenticated;

-- What has been added by hand, and to which list:
--   select kind, title, deadline from public.events
--    where source = 'Added by KLU' order by kind, title;
