-- ============================================================================
-- Migration 017 - confirmed registrations, split by kind
--
-- Run this in the Supabase SQL editor. Safe to re-run.
--
-- The admin page keeps one list per kind now: hackathons and hiring challenges
-- in one, competitive exams in another. Which exam a student is sitting is a
-- different question from which hackathon they entered, and one table mixing
-- the two answers neither well.
--
-- p_kind takes 'exam' for the exam list, 'event' for everything that is not an
-- exam, or null for all of them. 'event' rather than listing 'open' and
-- 'hiring' separately, so a kind added later lands in the general list instead
-- of silently disappearing from both.
-- ============================================================================

-- The old three-argument version has to go, or a three-argument call is
-- ambiguous between it and the new one with its defaulted fourth.
drop function if exists public.admin_registrations(text, boolean, int);
drop function if exists public.admin_registrations(text, boolean, int, text);

create or replace function public.admin_registrations(
    p_search         text    default null,
    p_confirmed_only boolean default true,
    p_limit          int     default 200,
    p_kind           text    default null
)
returns table (
    id bigint, student_name text, roll_no text, student_email text,
    branch text, year int, event_title text, source text, kind text,
    event_url text, first_clicked_at timestamptz, last_clicked_at timestamptz,
    times_clicked int, confirmed boolean, confirmed_at timestamptz
)
language plpgsql
security definer
stable
set search_path = public
as $$
declare
    v_search text := nullif(btrim(coalesce(p_search, '')), '');
    v_kind   text := nullif(btrim(coalesce(p_kind, '')), '');
begin
    if not public.is_admin() then
        raise exception 'Admin access required';
    end if;

    return query
        select r.id, p.full_name, p.roll_no, p.email, p.branch, p.year,
               e.title, e.source, e.kind, e.url,
               r.first_clicked_at, r.last_clicked_at, r.times_clicked,
               r.confirmed, r.confirmed_at
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
                 or p.roll_no   ilike '%' || v_search || '%'
                 or p.full_name ilike '%' || v_search || '%'
                 or p.email     ilike '%' || v_search || '%'
                 or e.title     ilike '%' || v_search || '%'
               )
           and (
                 v_kind is null
                 or (v_kind = 'exam'  and e.kind =  'exam')
                 or (v_kind = 'event' and e.kind <> 'exam')
               )
         order by r.confirmed desc, coalesce(r.confirmed_at, r.last_clicked_at) desc
         limit greatest(1, least(coalesce(p_limit, 200), 500));
end;
$$;

revoke all on function public.admin_registrations(text, boolean, int, text) from anon;
grant execute on function public.admin_registrations(text, boolean, int, text) to authenticated;

-- Confirmed entries per kind:
--   select e.kind, count(*) from public.event_registrations r
--     join public.events e on e.id = r.event_id
--    where r.confirmed group by e.kind order by e.kind;
