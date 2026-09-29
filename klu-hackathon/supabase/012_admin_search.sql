-- ============================================================================
-- Migration 012 - the admin page searches instead of listing everything
--
-- Run in the Supabase SQL editor. Safe to re-run.
--
-- The page was fetching 435 events, 271 accounts and every registration on each
-- visit, then showing the lot. Now nothing is listed until it is asked for:
-- registrations default to the confirmed ones only, and events and accounts
-- appear when searched.
-- ============================================================================

-- Filters move into the function, so an unconfirmed registration is not sent to
-- the browser and then hidden there.
drop function if exists public.admin_registrations();
drop function if exists public.admin_registrations(text, boolean, int);

create or replace function public.admin_registrations(
    p_search         text    default null,
    p_confirmed_only boolean default true,
    p_limit          int     default 200
)
returns table (
    id bigint, student_name text, roll_no text, student_email text,
    branch text, year int, event_title text, source text, kind text,
    event_url text, last_clicked_at timestamptz, times_clicked int, confirmed boolean
)
language plpgsql
security definer
stable
set search_path = public
as $$
declare
    v_search text := nullif(btrim(coalesce(p_search, '')), '');
begin
    if not public.is_admin() then
        raise exception 'Admin access required';
    end if;

    return query
        select r.id, p.full_name, p.roll_no, p.email, p.branch, p.year,
               e.title, e.source, e.kind, e.url,
               r.last_clicked_at, r.times_clicked, r.confirmed
          from public.event_registrations r
          join public.profiles p on p.id = r.student_id
          join public.events   e on e.id = r.event_id
         where (
                 -- a search looks at everything; without one, only confirmed
                 v_search is not null
                 or not p_confirmed_only
                 or r.confirmed
               )
           and (
                 v_search is null
                 or p.roll_no      ilike '%' || v_search || '%'
                 or p.full_name    ilike '%' || v_search || '%'
                 or p.email        ilike '%' || v_search || '%'
                 or e.title        ilike '%' || v_search || '%'
               )
         order by r.confirmed desc, r.last_clicked_at desc
         limit greatest(1, least(coalesce(p_limit, 200), 500));
end;
$$;


-- Counts for the header tiles, so the page does not pull every row to add them up.
create or replace function public.admin_event_stats()
returns table (source text, total bigint, hiring bigint)
language plpgsql
security definer
stable
set search_path = public
as $$
begin
    if not public.is_admin() then
        raise exception 'Admin access required';
    end if;
    return query
        select coalesce(e.source, 'unknown')::text,
               count(*)::bigint,
               count(*) filter (where e.kind = 'hiring')::bigint
          from public.events e
         group by 1
         order by 2 desc;
end;
$$;


revoke all on function public.admin_registrations(text, boolean, int) from anon;
revoke all on function public.admin_event_stats() from anon;
grant execute on function public.admin_registrations(text, boolean, int) to authenticated;
grant execute on function public.admin_event_stats() to authenticated;
