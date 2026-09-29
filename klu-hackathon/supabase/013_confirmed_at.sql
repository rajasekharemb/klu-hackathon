-- ============================================================================
-- Migration 013 - show when a registration was confirmed
--
-- Run in the Supabase SQL editor after 012. Safe to re-run.
--
-- Adds confirmed_at to what admin_registrations() returns. A return type cannot
-- be changed in place, so the function is dropped and recreated - which is also
-- why this is a new file rather than an edit to 012: re-running an older copy of
-- 012 afterwards would quietly put the narrower version back.
-- ============================================================================

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
         order by r.confirmed desc, coalesce(r.confirmed_at, r.last_clicked_at) desc
         limit greatest(1, least(coalesce(p_limit, 200), 500));
end;
$$;

revoke all on function public.admin_registrations(text, boolean, int) from anon;
grant execute on function public.admin_registrations(text, boolean, int) to authenticated;

-- Check it returns your confirmed rows:
--   select roll_no, event_title, confirmed, confirmed_at
--     from public.admin_registrations(null, true, 50);
