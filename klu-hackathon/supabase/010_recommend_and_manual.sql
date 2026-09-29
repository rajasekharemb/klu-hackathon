-- ============================================================================
-- Migration 010 - recommendations, and events added by hand
--
-- Run in the Supabase SQL editor. Safe to re-run.
--
--   * admins and the owner can recommend an event; recommended ones sort to the
--     very top of the portal and are highlighted
--   * the owner can paste a link and have it added as a hackathon or a hiring
--     challenge, alongside the ones the nightly job finds
-- ============================================================================

alter table public.events add column if not exists recommended     boolean not null default false;
alter table public.events add column if not exists recommended_by  uuid references public.profiles (id) on delete set null;
alter table public.events add column if not exists recommended_at  timestamptz;
alter table public.events add column if not exists recommend_note  text;
alter table public.events add column if not exists added_by        uuid references public.profiles (id) on delete set null;

create index if not exists events_recommended_idx on public.events (recommended) where recommended;


-- ---------------------------------------------------------------- recommending
-- Admins may recommend, and nothing else. The blanket "admins manage events"
-- policy let any admin rewrite any column of any event, which is wider than the
-- view-only role they were given in 006/007.
drop policy if exists "admins manage events" on public.events;
drop policy if exists "owner manages events" on public.events;
create policy "owner manages events" on public.events
    for all to authenticated using (public.is_owner()) with check (public.is_owner());

create or replace function public.set_recommended(
    p_event_id bigint,
    p_on       boolean default true,
    p_note     text default null
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare v_title text;
begin
    if not public.is_admin() then
        raise exception 'Admin access required';
    end if;

    select title into v_title from public.events where id = p_event_id;
    if v_title is null then
        raise exception 'No such event';
    end if;

    update public.events
       set recommended    = p_on,
           recommended_by = case when p_on then auth.uid() else null end,
           recommended_at = case when p_on then now() else null end,
           recommend_note = case when p_on then nullif(btrim(coalesce(p_note, '')), '') else null end
     where id = p_event_id;

    return case when p_on then format('Recommended: %s', v_title)
                else format('Removed recommendation: %s', v_title) end;
end;
$$;


-- ------------------------------------------------------- adding one by hand
-- The page is fetched and read by the website, which then calls this to store the
-- result. Owner only: adding an event puts it in front of every student.
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
    if p_deadline is null then
        raise exception 'A registration deadline is required, or the event cannot be shown';
    end if;
    if p_kind not in ('open', 'hiring') then
        raise exception 'Kind must be open or hiring';
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


-- ------------------------------------------------------------------- the view
-- Recommended events first, then the score from 009.
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
     where e.deadline is not null
       and e.deadline >= current_date
     order by e.recommended desc, score desc, e.deadline, e.title;


revoke all on function public.set_recommended(bigint, boolean, text) from anon;
revoke all on function public.add_manual_event(text, text, text, date, date, date, text, text, text, text, text, text) from anon;
grant execute on function public.set_recommended(bigint, boolean, text) to authenticated;
grant execute on function public.add_manual_event(text, text, text, date, date, date, text, text, text, text, text, text) to authenticated;

-- What is currently recommended:
--   select title, recommended_at, recommend_note from public.events where recommended;
