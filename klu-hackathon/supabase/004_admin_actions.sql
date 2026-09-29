-- ============================================================================
-- Migration 004 - let the admin screen do its work with buttons
--
-- Run in the Supabase SQL editor after 003. Safe to re-run.
--
-- Until now admins could only READ registrations and roles could only be changed
-- by typing SQL. This adds the permissions and the guarded functions the /admin
-- buttons call, so nothing routine needs the SQL editor again.
-- ============================================================================

-- Admins may remove registration rows. Students keep the "own registrations"
-- policy from 002, so they can still undo their own.
drop policy if exists "admins delete regs" on public.event_registrations;
create policy "admins delete regs" on public.event_registrations
    for delete to authenticated using (public.is_admin());


create or replace function public.admin_count()
returns int
language sql
security definer
stable
set search_path = public
as $$
    select count(*)::int from public.profiles where role = 'admin';
$$;


-- Grant or revoke admin, with the guards that stop you locking yourself out.
create or replace function public.set_admin(p_email text, p_is_admin boolean default true)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
    v_id    uuid;
    v_role  text;
    v_new   text := case when p_is_admin then 'admin' else 'student' end;
begin
    if auth.uid() is not null and not public.is_admin() then
        raise exception 'Only an admin can change roles';
    end if;

    select id, role into v_id, v_role
      from public.profiles where lower(email) = lower(trim(p_email));

    if v_id is null then
        return format('No profile found for %s - they must create an account first.', p_email);
    end if;
    if v_role = v_new then
        return format('%s is already %s.', p_email, v_new);
    end if;
    -- Removing your own admin rights would leave you unable to put them back.
    if not p_is_admin and v_id = auth.uid() then
        raise exception 'You cannot remove your own admin access. Ask another admin.';
    end if;
    if not p_is_admin and v_role = 'admin' and public.admin_count() <= 1 then
        raise exception 'This is the only admin. Promote someone else first.';
    end if;

    perform set_config('app.role_change_allowed', 'on', true);
    update public.profiles set role = v_new where id = v_id;

    return format('%s is now %s', lower(trim(p_email)), v_new);
end;
$$;


-- Delete an account from the admin screen.
create or replace function public.admin_delete_student(p_email text)
returns text
language plpgsql
security definer
set search_path = public, auth
as $$
declare
    v_id   uuid;
    v_role text;
begin
    if auth.uid() is not null and not public.is_admin() then
        raise exception 'Only an admin can delete accounts';
    end if;

    select id, role into v_id, v_role
      from public.profiles where lower(email) = lower(trim(p_email));

    if v_id is null then
        return format('No account found for %s', p_email);
    end if;
    if v_id = auth.uid() then
        raise exception 'You cannot delete your own account.';
    end if;
    if v_role = 'admin' and public.admin_count() <= 1 then
        raise exception 'This is the only admin. Promote someone else first.';
    end if;

    -- Deleting the auth user cascades to profiles and event_registrations. If this
    -- database role may not touch auth.users, remove them from the portal anyway and
    -- say so plainly rather than reporting a success that did not happen.
    begin
        delete from auth.users where id = v_id;
        return format('Deleted %s, their login and their registrations.', p_email);
    exception
        when insufficient_privilege or undefined_table then
            delete from public.profiles where id = v_id;
            return format(
                'Removed %s from the portal, but their login still exists. '
                'Delete it under Authentication > Users.', p_email);
    end;
end;
$$;


revoke all on function public.set_admin(text, boolean)      from anon;
revoke all on function public.admin_delete_student(text)    from anon;
revoke all on function public.admin_count()                 from anon;
grant execute on function public.set_admin(text, boolean)   to authenticated;
grant execute on function public.admin_delete_student(text) to authenticated;
grant execute on function public.admin_count()              to authenticated;
