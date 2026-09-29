-- ============================================================================
-- Migration 006 - an owner role above admin
--
-- Run in the Supabase SQL editor. Safe to re-run.
--
-- Until now every admin could promote other admins and delete accounts, which
-- means handing someone the admin badge handed them the ability to remove you.
-- Three levels now:
--
--   student  the portal
--   admin    registrations, the nightly refresh log, events by source
--   owner    all of that, plus the accounts table and the role/delete buttons
--
-- Account management is enforced in the database, not just hidden in the page.
-- ============================================================================

-- 1. allow the new value
alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles add constraint profiles_role_check
    check (role in ('student', 'admin', 'owner'));


-- 2. an owner is also an admin everywhere admin access is checked
create or replace function public.is_admin()
returns boolean language sql security definer stable set search_path = public as $$
    select exists (
        select 1 from public.profiles
         where id = auth.uid() and role in ('admin', 'owner')
    );
$$;

create or replace function public.is_owner()
returns boolean language sql security definer stable set search_path = public as $$
    select exists (
        select 1 from public.profiles where id = auth.uid() and role = 'owner'
    );
$$;

create or replace function public.admin_count()
returns int language sql security definer stable set search_path = public as $$
    select count(*)::int from public.profiles where role in ('admin', 'owner');
$$;


-- 3. make the founding account the owner
update public.profiles set role = 'owner'
 where lower(email) = 'rajasekharemb@kluniversity.in' and role <> 'owner';


-- 4. only the owner reads the whole accounts list
drop policy if exists "admins read profiles" on public.profiles;
drop policy if exists "owner reads profiles" on public.profiles;
create policy "owner reads profiles" on public.profiles
    for select to authenticated using (public.is_owner());


-- 5. the registration report still needs student names, and a plain admin can no
--    longer read profiles. This runs as its owner so the join works, and checks
--    is_admin() itself rather than relying on the caller's row permissions.
create or replace function public.admin_registrations()
returns table (
    id bigint, student_name text, roll_no text, student_email text,
    branch text, year int, event_title text, source text, kind text,
    event_url text, last_clicked_at timestamptz, times_clicked int, confirmed boolean
)
language plpgsql security definer stable set search_path = public as $$
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
         order by r.last_clicked_at desc;
end;
$$;


-- 6. role changes and deletions become owner-only, and the owner is untouchable
create or replace function public.set_admin(p_email text, p_is_admin boolean default true)
returns text language plpgsql security definer set search_path = public as $$
declare
    v_id uuid; v_role text;
    v_new text := case when p_is_admin then 'admin' else 'student' end;
begin
    if auth.uid() is not null and not public.is_owner() then
        raise exception 'Only the owner can change roles';
    end if;

    select id, role into v_id, v_role
      from public.profiles where lower(email) = lower(trim(p_email));

    if v_id is null then
        return format('No profile found for %s - they must create an account first.', p_email);
    end if;
    if v_role = 'owner' then
        raise exception 'The owner account cannot be changed here.';
    end if;
    if v_role = v_new then
        return format('%s is already %s.', p_email, v_new);
    end if;

    perform set_config('app.role_change_allowed', 'on', true);
    update public.profiles set role = v_new where id = v_id;
    return format('%s is now %s', lower(trim(p_email)), v_new);
end;
$$;


create or replace function public.admin_delete_student(p_email text)
returns text language plpgsql security definer set search_path = public, auth as $$
declare v_id uuid; v_role text;
begin
    if auth.uid() is not null and not public.is_owner() then
        raise exception 'Only the owner can delete accounts';
    end if;

    select id, role into v_id, v_role
      from public.profiles where lower(email) = lower(trim(p_email));

    if v_id is null then
        return format('No account found for %s', p_email);
    end if;
    if v_role = 'owner' then
        raise exception 'The owner account cannot be deleted here.';
    end if;

    begin
        delete from auth.users where id = v_id;
        return format('Deleted %s, their login and their registrations.', p_email);
    exception
        when insufficient_privilege or undefined_table then
            delete from public.profiles where id = v_id;
            return format('Removed %s from the portal, but their login still exists. '
                          'Delete it under Authentication > Users.', p_email);
    end;
end;
$$;


revoke all on function public.is_owner()              from anon;
revoke all on function public.admin_registrations()   from anon;
grant execute on function public.is_owner()           to authenticated;
grant execute on function public.admin_registrations() to authenticated;

-- Check the result:
--   select email, role from public.profiles order by role, email;
