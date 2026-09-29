-- ============================================================================
-- Migration 003 - granting and revoking admin
--
-- Run in the Supabase SQL editor after schema.sql. Safe to re-run.
--
-- Why this exists: profiles_protect reverts any role change unless the caller is
-- service_role, which stops a student promoting themselves. But the SQL editor has
-- no JWT at all, so auth.role() is NULL there and a plain
--     update public.profiles set role = 'admin' where email = '...'
-- was silently reverted - it looked like it worked and changed nothing.
-- ============================================================================

-- A transaction-local flag lets set_admin() below make the one change it is allowed
-- to make. set_config(..., true) scopes it to the current transaction, so it cannot
-- leak into another session.
create or replace function public.protect_privileged_columns()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
    if coalesce(current_setting('app.role_change_allowed', true), '') = 'on' then
        return new;                       -- set_admin() is doing this deliberately
    end if;
    -- NULL means there is no API request context at all: the SQL editor, or a direct
    -- database connection. Both are already privileged. Requests through PostgREST
    -- always carry a role claim, so a student still cannot change their own role.
    if auth.role() is not null and auth.role() <> 'service_role' then
        new.role  := old.role;
        new.email := old.email;
    end if;
    return new;
end;
$$;

drop trigger if exists profiles_protect on public.profiles;
create trigger profiles_protect before update on public.profiles
    for each row execute function public.protect_privileged_columns();


-- Grant or revoke admin by email.
--   select public.set_admin('someone@kluniversity.in');          -- make admin
--   select public.set_admin('someone@kluniversity.in', false);   -- back to student
create or replace function public.set_admin(p_email text, p_is_admin boolean default true)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
    v_count int;
    v_role  text := case when p_is_admin then 'admin' else 'student' end;
begin
    -- auth.uid() is NULL in the SQL editor, which is already a privileged context.
    -- Through the API, only an existing admin may call this.
    if auth.uid() is not null and not public.is_admin() then
        raise exception 'Only an admin can change roles';
    end if;

    perform set_config('app.role_change_allowed', 'on', true);

    update public.profiles
       set role = v_role
     where lower(email) = lower(trim(p_email));
    get diagnostics v_count = row_count;

    if v_count = 0 then
        return format('No profile found for %s - they must create an account first.', p_email);
    end if;
    return format('%s is now %s', lower(trim(p_email)), v_role);
end;
$$;

revoke all on function public.set_admin(text, boolean) from anon;
grant execute on function public.set_admin(text, boolean) to authenticated;


-- Who currently has admin:
--   select email, full_name, role from public.profiles where role = 'admin';
