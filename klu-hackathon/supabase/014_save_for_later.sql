-- ============================================================================
-- Migration 014 - save for later, expiring after 30 days
--
-- Run in the Supabase SQL editor. Safe to re-run.
--
-- A student can keep an event aside to come back to. The entry expires 30 days
-- after it was saved, so the list stays a short-term shortlist rather than
-- something nobody ever prunes.
--
-- Expiry is enforced twice over: queries only ever return entries that are still
-- live, so an expired one disappears the moment it lapses, and purge_expired_saves()
-- actually removes the rows. The first is what students see; the second keeps the
-- table from growing without bound. Relying on the delete alone would leave stale
-- entries visible until whenever the purge next ran.
-- ============================================================================

create table if not exists public.saved_events (
    student_id uuid   not null references public.profiles (id) on delete cascade,
    event_id   bigint not null references public.events (id)   on delete cascade,
    saved_at   timestamptz not null default now(),
    expires_at timestamptz not null default now() + interval '30 days',
    primary key (student_id, event_id)
);

create index if not exists saved_student_idx on public.saved_events (student_id);
create index if not exists saved_expiry_idx  on public.saved_events (expires_at);

alter table public.saved_events enable row level security;

-- A student's shortlist is their own. Not even an admin lists it: it says what
-- someone is considering, which is not the college's business.
drop policy if exists "own saved events" on public.saved_events;
create policy "own saved events" on public.saved_events
    for all to authenticated
    using (auth.uid() = student_id)
    with check (auth.uid() = student_id);


-- Called by the nightly job after it publishes. Runs as its owner so it can clear
-- every student's lapsed entries, and touches nothing else.
create or replace function public.purge_expired_saves()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare v_count integer;
begin
    delete from public.saved_events where expires_at <= now();
    get diagnostics v_count = row_count;
    return v_count;
end;
$$;

revoke all on function public.purge_expired_saves() from anon, authenticated;

-- What each student is holding on to, and for how much longer:
--   select student_id, count(*), min(expires_at)
--     from public.saved_events where expires_at > now() group by 1;
