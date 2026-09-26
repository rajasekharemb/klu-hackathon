-- ============================================================================
-- KLU Hackathon Portal - database schema
-- Run this once in the Supabase SQL editor:
--   Dashboard -> SQL Editor -> New query -> paste -> Run
-- It is safe to re-run; every statement is idempotent.
-- ============================================================================

-- ---------------------------------------------------------------- extensions
create extension if not exists "uuid-ossp";


-- ---------------------------------------------------------------- 1. profiles
-- One row per student, created automatically when they sign up.
create table if not exists public.profiles (
    id                   uuid primary key references auth.users on delete cascade,
    email                text unique not null,
    roll_no              text unique,
    full_name            text,
    branch               text,
    year                 int check (year between 1 and 5),
    must_change_password boolean not null default false,
    created_at           timestamptz not null default now(),
    updated_at           timestamptz not null default now()
);

comment on column public.profiles.must_change_password is
    'True for accounts created by the bulk script with the shared default password. '
    'The app forces a change before letting the student in.';


-- --------------------------------------------------------- 2. college domain
-- Only college addresses may register. Change the domain here and nowhere else.
create or replace function public.allowed_email_domain(address text)
returns boolean
language sql
immutable
as $$
    select lower(address) like '%@kluniversity.in'
        or lower(address) like '%@klu.ac.in';
$$;


-- ------------------------------------------------- 3. profile on signup hook
-- Supabase inserts into auth.users; this mirrors the row into public.profiles
-- and rejects anyone outside the college domain.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
    if not public.allowed_email_domain(new.email) then
        raise exception 'Only college email addresses may register (got %)', new.email;
    end if;

    insert into public.profiles (id, email, roll_no, full_name, must_change_password)
    values (
        new.id,
        new.email,
        coalesce(new.raw_user_meta_data ->> 'roll_no', split_part(new.email, '@', 1)),
        new.raw_user_meta_data ->> 'full_name',
        coalesce((new.raw_user_meta_data ->> 'must_change_password')::boolean, false)
    )
    on conflict (id) do nothing;

    return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
    after insert on auth.users
    for each row execute function public.handle_new_user();


-- --------------------------------------------------------------- 4. events
-- Written only by the nightly job (service_role). Students read it.
create table if not exists public.events (
    id                bigserial primary key,
    key               text unique not null,   -- tracker's stable identity
    title             text not null,
    source            text,
    kind              text not null default 'open',   -- open | hiring
    scope             text,                            -- global|national|regional|campus|unknown
    url               text,
    registration_url  text,
    start_date        date,
    end_date          date,
    deadline          date,
    mode              text,
    location          text,
    organizer         text,
    prize             text,
    fee               text,
    team_size         text,
    eligibility       text,
    participants      text,
    description       text,
    domains           text[] not null default '{}',
    categories        text[] not null default '{}',
    poster_url        text,
    poster_status     text,
    poster_width      int,
    poster_height     int,
    tracker_status    text,                   -- NEW / OLD as the tracker saw it
    first_seen        date,
    last_seen         date,
    times_seen        int default 1,
    updated_at        timestamptz not null default now()
);

create index if not exists events_deadline_idx   on public.events (deadline);
create index if not exists events_start_idx      on public.events (start_date);
create index if not exists events_kind_idx       on public.events (kind);
create index if not exists events_last_seen_idx  on public.events (last_seen desc);


-- ------------------------------------------------------ 5. saved / bookmarks
create table if not exists public.saved_events (
    student_id uuid not null references public.profiles (id) on delete cascade,
    event_id   bigint not null references public.events (id) on delete cascade,
    created_at timestamptz not null default now(),
    primary key (student_id, event_id)
);


-- ------------------------------------------------------------- 6. run log
-- One row per nightly refresh, so a silent failure is visible.
create table if not exists public.refresh_runs (
    id            bigserial primary key,
    ran_at        timestamptz not null default now(),
    events_total  int,
    events_new    int,
    events_hiring int,
    errors        int,
    ok            boolean not null default true,
    note          text
);


-- ---------------------------------------------------------------- 7. RLS
alter table public.profiles      enable row level security;
alter table public.events        enable row level security;
alter table public.saved_events  enable row level security;
alter table public.refresh_runs  enable row level security;

-- profiles: a student sees and edits only their own row.
drop policy if exists "read own profile"   on public.profiles;
drop policy if exists "update own profile" on public.profiles;
create policy "read own profile"   on public.profiles for select using (auth.uid() = id);
create policy "update own profile" on public.profiles for update using (auth.uid() = id)
                                                              with check (auth.uid() = id);

-- events: every signed-in student may read. Nobody may write through the API;
-- the nightly job uses the service_role key, which bypasses RLS by design.
drop policy if exists "signed-in students read events" on public.events;
create policy "signed-in students read events" on public.events
    for select to authenticated using (true);

-- saved events: only your own.
drop policy if exists "own saved events" on public.saved_events;
create policy "own saved events" on public.saved_events
    for all to authenticated using (auth.uid() = student_id)
                              with check (auth.uid() = student_id);

-- refresh log: readable so the dashboard can show "last updated".
drop policy if exists "read refresh log" on public.refresh_runs;
create policy "read refresh log" on public.refresh_runs
    for select to authenticated using (true);


-- ------------------------------------------------------- 8. updated_at touch
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
    new.updated_at = now();
    return new;
end;
$$;

drop trigger if exists profiles_touch on public.profiles;
create trigger profiles_touch before update on public.profiles
    for each row execute function public.touch_updated_at();

drop trigger if exists events_touch on public.events;
create trigger events_touch before update on public.events
    for each row execute function public.touch_updated_at();


-- ------------------------------------------------------- 9. handy view
-- Upcoming events first, past ones dropped. The app can just select * from this.
create or replace view public.upcoming_events as
    select *,
           coalesce(deadline, start_date, end_date) as next_date
      from public.events
     where coalesce(deadline, end_date, start_date) >= current_date - 1
     order by coalesce(deadline, start_date, end_date) nulls last, title;
