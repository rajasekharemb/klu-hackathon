-- ============================================================================
-- Migration 002 - record which student went to register for which event
--
-- Run this in the Supabase SQL editor after schema.sql. Safe to re-run.
--
-- What this can and cannot know: the "Register Now" button opens the event's own
-- site (Unstop, Devfolio, HackIndia). We see the click; we cannot see whether the
-- student finished the form there. So `clicked` is recorded automatically and
-- `confirmed` is set only when the student says they actually registered.
-- ============================================================================

-- saved_events was created for a bookmark feature that was never built, and has
-- always been empty. This replaces it.
drop table if exists public.saved_events;

create table if not exists public.event_registrations (
    id               bigserial primary key,
    student_id       uuid   not null references public.profiles (id) on delete cascade,
    event_id         bigint not null references public.events (id)   on delete cascade,
    event_title      text   not null,        -- copied so the record survives the event being re-keyed
    first_clicked_at timestamptz not null default now(),
    last_clicked_at  timestamptz not null default now(),
    times_clicked    int         not null default 1,
    confirmed        boolean     not null default false,
    confirmed_at     timestamptz,
    unique (student_id, event_id)
);

create index if not exists reg_student_idx on public.event_registrations (student_id);
create index if not exists reg_event_idx   on public.event_registrations (event_id);
create index if not exists reg_clicked_idx on public.event_registrations (last_clicked_at desc);

alter table public.event_registrations enable row level security;

-- A student sees and edits only their own rows.
drop policy if exists "own registrations"    on public.event_registrations;
drop policy if exists "admins read all regs" on public.event_registrations;

create policy "own registrations" on public.event_registrations
    for all to authenticated
    using (auth.uid() = student_id)
    with check (auth.uid() = student_id);

create policy "admins read all regs" on public.event_registrations
    for select to authenticated
    using (public.is_admin());

-- Records the click. Called from the browser, so it runs as the signed-in student
-- and can only ever write that student's own row.
create or replace function public.record_registration_click(p_event_id bigint)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
    v_title text;
begin
    if auth.uid() is null then
        raise exception 'Not signed in';
    end if;

    select title into v_title from public.events where id = p_event_id;
    if v_title is null then
        raise exception 'No such event: %', p_event_id;
    end if;

    insert into public.event_registrations (student_id, event_id, event_title)
    values (auth.uid(), p_event_id, v_title)
    on conflict (student_id, event_id) do update
        set last_clicked_at = now(),
            times_clicked   = public.event_registrations.times_clicked + 1,
            event_title     = excluded.event_title;
end;
$$;

grant execute on function public.record_registration_click(bigint) to authenticated;

-- Readable report for the admin screen and for CSV export from the dashboard.
create or replace view public.registration_report
with (security_invoker = true) as
    select r.id,
           p.full_name    as student_name,
           p.roll_no,
           p.email        as student_email,
           p.branch,
           p.year,
           e.title        as event_title,
           e.source,
           e.kind,
           e.start_date,
           e.deadline,
           e.url          as event_url,
           r.first_clicked_at,
           r.last_clicked_at,
           r.times_clicked,
           r.confirmed,
           r.confirmed_at
      from public.event_registrations r
      join public.profiles p on p.id = r.student_id
      join public.events   e on e.id = r.event_id
     order by r.last_clicked_at desc;
