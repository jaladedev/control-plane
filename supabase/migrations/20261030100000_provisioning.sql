-- Provisioning wizard (plan M5): bring a registered school (status
-- 'provisioning') live from the dashboard. The owner presses Provision; the
-- worker runs the steps below, one at a time, and can resume after a failure.
--
-- Same rules as the rest of the control plane: the database enforces them, the
-- dashboard calls these after writing its audit row, only the service role may.

-- ---------------------------------------------------------------------------
-- Job type
-- ---------------------------------------------------------------------------

alter table jobs drop constraint jobs_type_check;
alter table jobs add constraint jobs_type_check
  check (type in ('rollout_step', 'schema_scan', 'school_rollback', 'register_release',
                  'license_push', 'telegram_notify', 'provision_school'));

-- ---------------------------------------------------------------------------
-- Per-step progress
-- ---------------------------------------------------------------------------

-- One row per school and step. A step that succeeded is never run again, so a
-- failed provisioning resumes where it stopped. Detail is a short message for
-- the owner and never holds a secret.
create table provision_steps (
  school_id uuid not null references schools (id) on delete cascade,
  step text not null
    check (step in ('database', 'storage', 'container', 'license', 'health', 'activate')),
  status text not null default 'pending'
    check (status in ('pending', 'running', 'succeeded', 'failed')),
  detail text,
  attempts integer not null default 0,
  started_at timestamptz,
  finished_at timestamptz,
  primary key (school_id, step)
);

alter table provision_steps enable row level security;
create policy provision_steps_select_any_role on provision_steps
  for select to authenticated
  using (dashboard_role() is not null);
revoke all on provision_steps from public, anon, authenticated;
grant select on provision_steps to authenticated;

-- ---------------------------------------------------------------------------
-- Queue a provisioning job
-- ---------------------------------------------------------------------------

-- Refuses anything that would leave a half-made school: the school must still be
-- in 'provisioning', have a hostname and a saved licence, and a release must
-- exist to deploy. Failed steps go back to pending (a resume); succeeded steps
-- stay succeeded.
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
  if not exists (select 1 from releases) then
    raise exception 'No release is registered, so there is nothing to deploy.';
  end if;
  if exists (select 1 from jobs where school_id = p_school and type = 'provision_school'
                and status in ('queued', 'running')) then
    raise exception 'Provisioning of % is already queued or running.', s.slug;
  end if;

  foreach v_step in array array['database', 'storage', 'container', 'license', 'health', 'activate'] loop
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

-- ---------------------------------------------------------------------------
-- Worker: record a step
-- ---------------------------------------------------------------------------

create or replace function record_provision_step(
  p_school uuid, p_step text, p_status text, p_detail text
)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if p_status not in ('running', 'succeeded', 'failed') then
    raise exception 'A step is recorded as running, succeeded or failed.';
  end if;
  update provision_steps
     set status = p_status,
         detail = left(p_detail, 1000),
         attempts = attempts + case when p_status = 'running' then 1 else 0 end,
         started_at = case when p_status = 'running' then now() else started_at end,
         finished_at = case when p_status = 'running' then null else now() end
   where school_id = p_school and step = p_step;
  if not found then
    raise exception 'That school has no step "%". Provisioning was not queued.', p_step;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Worker: go live
-- ---------------------------------------------------------------------------

-- The last step. Flips the school to 'active' and records what is running, with
-- its own audit row (the worker has no actor). Repeating it for a school that is
-- already active at that tag does nothing, so a retried job is harmless.
create or replace function activate_provisioned_school(
  p_school uuid, p_tag text, p_schema_version text, p_by text
)
returns boolean
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  s schools;
begin
  select * into s from schools where id = p_school for update;
  if s.id is null then
    raise exception 'That school does not exist.';
  end if;
  if s.status = 'active' and s.image_tag = p_tag then
    return false;
  end if;
  if s.status <> 'provisioning' then
    raise exception '% is % and cannot be activated by provisioning.', s.slug, s.status;
  end if;
  if p_tag is null or p_tag !~ '^[0-9a-f]{40}$' then
    raise exception 'Activation needs the full 40-character tag that is running.';
  end if;
  if exists (select 1 from provision_steps
              where school_id = p_school and step <> 'activate' and status <> 'succeeded') then
    raise exception 'Not every provisioning step has succeeded for %.', s.slug;
  end if;

  update schools
     set status = 'active', image_tag = p_tag, app_version = p_tag,
         schema_version = coalesce(p_schema_version, schema_version), credentials_status = 'ok'
   where id = p_school;
  insert into audit_log (actor_email, role, action, school_id, details)
  values ('system:provisioning', 'system', 'school.provisioned', p_school,
          jsonb_build_object('slug', s.slug, 'image_tag', p_tag, 'schema_version', p_schema_version,
                             'requested_by', left(p_by, 200)));
  return true;
end;
$$;

do $$
declare
  f text;
begin
  foreach f in array array[
    'queue_provision(uuid, text)', 'record_provision_step(uuid, text, text, text)',
    'activate_provisioned_school(uuid, text, text, text)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;
