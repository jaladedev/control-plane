-- Plan M6: applying new settings to a running school (key rotation), and a
-- record of restore drills. Same rules as the rest of the control plane: the
-- database enforces them, the dashboard calls these after writing its audit
-- row, only the service role may.
--
-- Runs after 20261031100000_provision_first_admin.sql.

-- ---------------------------------------------------------------------------
-- Applying new container settings
-- ---------------------------------------------------------------------------

alter table jobs drop constraint jobs_type_check;
alter table jobs add constraint jobs_type_check
  check (type in ('rollout_step', 'schema_scan', 'school_rollback', 'register_release',
                  'license_push', 'telegram_notify', 'provision_school', 'reconfigure_school'));

-- One attempt only, like a rollback: if the new settings were refused or the
-- old ones put back, a person decides what to do next, and the same job is
-- never silently repeated. Refused while the school's own rollout step or
-- rollback is in flight, so two operations never restart one container.
create or replace function queue_reconfigure(p_school uuid, p_by text)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  s schools;
  v_job uuid;
begin
  select * into s from schools where id = p_school for update;
  if s.id is null then
    raise exception 'That school does not exist.';
  end if;
  if s.status <> 'active' or cardinality(s.hostnames) = 0 then
    raise exception '% is not active, or has no hostname, so its settings cannot be applied.', s.slug;
  end if;
  if exists (select 1 from jobs
              where school_id = p_school and status in ('queued', 'running')
                and type in ('reconfigure_school', 'school_rollback', 'provision_school')) then
    raise exception 'Another operation on % is already queued or running.', s.slug;
  end if;
  if exists (select 1
               from rollout_steps st join rollouts r on r.id = st.rollout_id
              where st.school_id = p_school and st.status in ('queued', 'running')
                and r.status = 'running') then
    raise exception '% is being rolled out right now. Wait for that step to finish.', s.slug;
  end if;

  insert into jobs (type, school_id, payload, max_attempts)
  values ('reconfigure_school', p_school, jsonb_build_object('by', p_by), 1)
  returning id into v_job;
  return v_job;
end;
$$;

-- ---------------------------------------------------------------------------
-- Restore drills
-- ---------------------------------------------------------------------------

-- A drill is a person restoring a backup into a scratch database and checking it
-- (scripts/restore-drill.sh, docs/backup-restore.md). Restoring needs the offline
-- age key, which never reaches this app, so the dashboard only records the
-- outcome. school_id is null for a drill of the control plane's own backup.
-- Append-only: a record of a drill is not edited afterwards.
create table restore_drills (
  id uuid primary key default gen_random_uuid(),
  school_id uuid references schools (id) on delete restrict,
  backup_id uuid references backups (id) on delete restrict,
  drilled_at timestamptz not null default now(),
  ok boolean not null,
  seconds integer not null check (seconds between 0 and 86400),
  notes text check (char_length(notes) <= 1000),
  recorded_by text not null
);
create index restore_drills_school_idx on restore_drills (school_id, drilled_at desc);

create or replace function refuse_drill_change()
returns trigger
language plpgsql
set search_path to 'public'
as $$
begin
  raise exception 'restore_drills is append-only';
end;
$$;
create trigger restore_drills_append_only before update or delete on restore_drills
  for each row execute function refuse_drill_change();
create trigger restore_drills_no_truncate before truncate on restore_drills
  for each statement execute function refuse_drill_change();

alter table restore_drills enable row level security;
create policy restore_drills_select_any_role on restore_drills
  for select to authenticated
  using (dashboard_role() is not null);
revoke all on restore_drills from public, anon, authenticated;
grant select on restore_drills to authenticated;

create or replace function record_restore_drill(
  p_school uuid, p_backup uuid, p_ok boolean, p_seconds integer, p_notes text, p_by text
)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  b backups;
  v_id uuid;
begin
  if p_school is not null and not exists (select 1 from schools where id = p_school) then
    raise exception 'That school does not exist.';
  end if;
  if p_school is null and p_backup is not null then
    raise exception 'A school backup needs its school.';
  end if;
  if p_backup is not null then
    select * into b from backups where id = p_backup;
    if b.id is null then
      raise exception 'That backup does not exist.';
    end if;
    if b.school_id is distinct from p_school then
      raise exception 'That backup belongs to another school.';
    end if;
    if b.status <> 'succeeded' then
      raise exception 'That backup did not succeed, so there is nothing to restore.';
    end if;
  end if;
  if p_ok and p_school is not null and p_backup is null then
    raise exception 'A successful school drill must say which backup was restored.';
  end if;
  if p_seconds is null or p_seconds < 0 or p_seconds > 86400 then
    raise exception 'Seconds must be between 0 and 86400.';
  end if;
  if p_by is null or p_by = '' then
    raise exception 'Say who did the drill.';
  end if;

  insert into restore_drills (school_id, backup_id, ok, seconds, notes, recorded_by)
  values (p_school, p_backup, p_ok, p_seconds, left(p_notes, 1000), left(p_by, 200))
  returning id into v_id;
  return v_id;
end;
$$;

do $$
declare
  f text;
begin
  foreach f in array array[
    'queue_reconfigure(uuid, text)',
    'record_restore_drill(uuid, uuid, boolean, integer, text, text)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;
