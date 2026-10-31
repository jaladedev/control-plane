-- Provisioning, part 2: the school's first admin. A school that goes live with
-- nobody able to sign in is not usable, so provisioning now has an "admin" step
-- (after the licence, before the health check). The worker creates the login in
-- the school's own Auth and its profile rows; the temporary password goes to the
-- owner on Telegram and is never stored here.
--
-- Runs after 20261030100000_provisioning.sql.

alter table schools
  add column if not exists first_admin_name text,
  add column if not exists first_admin_email text;

alter table provision_steps drop constraint provision_steps_step_check;
alter table provision_steps add constraint provision_steps_step_check
  check (step in ('database', 'storage', 'container', 'license', 'admin', 'health', 'activate'));

-- Same function as before, plus: the first admin must be named, and there are
-- seven steps. A school already part-way through gets the new row on resume.
create or replace function queue_provision(p_school uuid, p_by text)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  s schools;
  v_job uuid;
  v_step text;
begin
  select * into s from schools where id = p_school for update;
  if s.id is null then
    raise exception 'That school does not exist.';
  end if;
  if s.status <> 'provisioning' then
    raise exception '% is % and is not being provisioned.', s.slug, s.status;
  end if;
  if cardinality(s.hostnames) = 0 then
    raise exception '% has no hostname. Add one in Details first.', s.slug;
  end if;
  if s.license_version = 0 or s.license_valid_until is null then
    raise exception '% has no licence saved. Set one before provisioning.', s.slug;
  end if;
  if coalesce(s.first_admin_name, '') = '' or coalesce(s.first_admin_email, '') = '' then
    raise exception '% has no first admin. Enter the admin''s name and email.', s.slug;
  end if;
  if not exists (select 1 from releases) then
    raise exception 'No release is registered, so there is nothing to deploy.';
  end if;
  if exists (select 1 from jobs where school_id = p_school and type = 'provision_school'
                and status in ('queued', 'running')) then
    raise exception 'Provisioning of % is already queued or running.', s.slug;
  end if;

  foreach v_step in array array['database', 'storage', 'container', 'license', 'admin', 'health', 'activate'] loop
    insert into provision_steps (school_id, step) values (p_school, v_step)
    on conflict (school_id, step) do update
      set status = 'pending', detail = null
      where provision_steps.status in ('failed', 'running');
  end loop;

  insert into jobs (type, school_id, payload, max_attempts)
  values ('provision_school', p_school, jsonb_build_object('by', p_by), 3)
  returning id into v_job;
  return v_job;
end;
$$;

revoke all on function queue_provision(uuid, text) from public, anon, authenticated;
grant execute on function queue_provision(uuid, text) to service_role;
