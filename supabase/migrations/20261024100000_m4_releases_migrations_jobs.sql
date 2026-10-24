-- M4: releases, the migration registry and run history, the job queue, and
-- canary rollouts. The state machine for rollouts lives here, in SQL, so it is
-- tested on a real database; the worker only does the slow I/O (connect to a
-- school's database, run its migrations, deploy its container).
--
-- Nothing here holds a secret. Every function that changes state is callable
-- only by the service role; the dashboard calls them after writing its audit
-- row, and the worker calls them to report results.

alter table schools
  add column rollout_group text not null default 'standard'
    check (rollout_group in ('test', 'pilot', 'standard'));

-- A release is one image tag (a full commit hash) that CI built. seq gives
-- releases an order, which commit hashes do not have; "this school runs at
-- least version X" means releases.seq >= X's seq. A tag that is not
-- registered has no order, so it is never "new enough".
create table releases (
  id uuid primary key default gen_random_uuid(),
  seq bigint generated always as identity unique,
  image_tag text not null unique check (image_tag ~ '^[0-9a-f]{40}$'),
  notes text,
  registered_by text,
  created_at timestamptz not null default now()
);

-- One row per school_app migration file, registered with the SQL itself and
-- its checksum. kind: expand (works with the old and the new app) or contract
-- (drops or changes something the old app uses). A contract migration names
-- the oldest app version that no longer needs what it removes.
create table migrations (
  id uuid primary key default gen_random_uuid(),
  version text not null unique check (version ~ '^[0-9]{14}$'),
  name text not null unique,
  checksum text not null check (checksum ~ '^[0-9a-f]{64}$'),
  kind text not null default 'expand' check (kind in ('expand', 'contract')),
  min_app_version text references releases (image_tag),
  release_id uuid not null references releases (id),
  sql text not null,
  created_at timestamptz not null default now(),
  constraint contract_needs_min_app_version check (kind <> 'contract' or min_app_version is not null)
);

-- Registered releases and migrations are history. Changing one after schools
-- have applied it would make the registry lie.
create or replace function refuse_registry_change()
returns trigger
language plpgsql
set search_path to 'public'
as $$
begin
  raise exception '% is append-only: a registered release or migration cannot be changed or removed.', tg_table_name;
end;
$$;
create trigger releases_append_only before update or delete on releases
  for each row execute function refuse_registry_change();
create trigger migrations_append_only before update or delete on migrations
  for each row execute function refuse_registry_change();

create table migration_runs (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references schools (id) on delete cascade,
  migration_id uuid not null references migrations (id),
  step_id uuid,
  status text not null check (status in ('running', 'succeeded', 'failed')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  error text
);
-- A migration succeeds at most once per school.
create unique index migration_runs_one_success
  on migration_runs (school_id, migration_id) where status = 'succeeded';
create index migration_runs_school_idx on migration_runs (school_id, started_at desc);

create table jobs (
  id uuid primary key default gen_random_uuid(),
  type text not null check (type in ('rollout_step', 'schema_scan')),
  status text not null default 'queued'
    check (status in ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  school_id uuid references schools (id) on delete cascade,
  payload jsonb not null default '{}'::jsonb,
  attempts integer not null default 0,
  max_attempts integer not null default 3,
  run_after timestamptz not null default now(),
  locked_by text,
  locked_at timestamptz,
  result jsonb,
  error text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);
create index jobs_claim_idx on jobs (created_at, id) where status = 'queued';
create index jobs_running_idx on jobs (locked_at) where status = 'running';

create table rollouts (
  id uuid primary key default gen_random_uuid(),
  release_id uuid not null references releases (id),
  image_tag text not null,
  status text not null default 'running'
    check (status in ('running', 'halted', 'succeeded', 'cancelled')),
  batch_size integer not null check (batch_size between 1 and 50),
  -- Steps with position <= released_through may run. The owner raises it one
  -- stage or batch at a time (release_rollout).
  released_through integer not null default 0,
  halt_reason text,
  created_by text,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);
-- One lock: a rollout that is running or halted blocks starting another.
create unique index rollouts_one_active on rollouts ((true)) where status in ('running', 'halted');

create table rollout_steps (
  id uuid primary key default gen_random_uuid(),
  rollout_id uuid not null references rollouts (id) on delete cascade,
  school_id uuid not null references schools (id) on delete cascade,
  position integer not null,
  stage text not null check (stage in ('test', 'pilot', 'batch')),
  batch_no integer not null default 0,
  status text not null default 'pending'
    check (status in ('pending', 'queued', 'running', 'succeeded', 'failed', 'cancelled')),
  attempt integer not null default 1,
  job_id uuid references jobs (id) on delete set null,
  result jsonb,
  error text,
  started_at timestamptz,
  finished_at timestamptz,
  unique (rollout_id, position),
  unique (rollout_id, school_id)
);
alter table migration_runs
  add constraint migration_runs_step_fk foreign key (step_id) references rollout_steps (id) on delete set null;

-- Visible to any signed-in dashboard user with 2FA; written by nobody but the
-- service role.
do $$
declare
  t text;
begin
  foreach t in array array['releases', 'migrations', 'migration_runs', 'jobs', 'rollouts', 'rollout_steps'] loop
    execute format('alter table %I enable row level security', t);
    execute format(
      'create policy %I on %I for select to authenticated using (dashboard_role() is not null)',
      t || '_select_any_role', t);
    execute format('revoke all on %I from public, anon, authenticated', t);
    execute format('grant select on %I to authenticated', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Queue
-- ---------------------------------------------------------------------------

-- Hands one queued job to a worker. SKIP LOCKED lets several workers poll
-- without waiting on each other or taking the same job.
create or replace function claim_job(p_worker text, p_types text[])
returns setof jobs
language sql
security definer
set search_path to 'public'
as $$
  update jobs
     set status = 'running',
         locked_by = p_worker,
         locked_at = now(),
         attempts = attempts + 1,
         started_at = coalesce(started_at, now())
   where id = (
     select id from jobs
      where status = 'queued' and run_after <= now() and type = any (p_types)
      order by created_at, id
      for update skip locked
      limit 1)
  returning *;
$$;

-- A running worker calls this every minute so its job is not taken for lost.
create or replace function touch_job(p_job uuid, p_worker text)
returns boolean
language sql
security definer
set search_path to 'public'
as $$
  with t as (
    update jobs set locked_at = now()
     where id = p_job and locked_by = p_worker and status = 'running'
    returning 1)
  select exists (select 1 from t);
$$;

create or replace function finish_job(p_job uuid, p_worker text, p_ok boolean, p_result jsonb, p_error text)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  update jobs
     set status = case when p_ok then 'succeeded' else 'failed' end,
         result = p_result,
         error = left(p_error, 1000),
         finished_at = now(),
         locked_by = null,
         locked_at = null
   where id = p_job and locked_by = p_worker and status = 'running';
  if not found then
    raise exception 'Job % is not held by worker %.', p_job, p_worker;
  end if;
end;
$$;

-- Registers one release and the migrations it ships, atomically: either all of
-- it is recorded or none. New migrations must sort after everything already
-- registered, because a school that has the newest migration can never apply an
-- older one (the runner refuses out-of-order).
create or replace function register_release(p_tag text, p_notes text, p_by text, p_migrations jsonb)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_id uuid;
  v_newest text;
  m jsonb;
begin
  if p_tag is null or p_tag !~ '^[0-9a-f]{40}$' then
    raise exception 'The release tag must be a full 40-character commit hash.';
  end if;
  if exists (select 1 from releases where image_tag = p_tag) then
    raise exception 'Release % is already registered; migrations can only be registered with a new release.', left(p_tag, 12);
  end if;
  select max(version) into v_newest from migrations;
  for m in select * from jsonb_array_elements(coalesce(p_migrations, '[]'::jsonb)) loop
    if v_newest is not null and (m ->> 'version') <= v_newest then
      raise exception 'Migration % is not newer than the newest registered one (%); new migrations must sort after it.', m ->> 'name', v_newest;
    end if;
  end loop;

  insert into releases (image_tag, notes, registered_by) values (p_tag, p_notes, p_by)
  returning id into v_id;

  for m in select * from jsonb_array_elements(coalesce(p_migrations, '[]'::jsonb)) loop
    insert into migrations (version, name, checksum, kind, min_app_version, release_id, sql)
    values (m ->> 'version', m ->> 'name', m ->> 'checksum', coalesce(m ->> 'kind', 'expand'),
            nullif(m ->> 'min_app_version', ''), v_id, m ->> 'sql');
  end loop;
  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Rollouts
-- ---------------------------------------------------------------------------

-- Plans a rollout: every active school with a hostname and a Supabase project
-- ref, test schools first, then pilot, then the rest by slug in batches.
create or replace function create_rollout(p_release uuid, p_batch_size integer, p_by text)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_id uuid;
  v_tag text;
  v_tests integer;
begin
  if p_batch_size is null or p_batch_size < 1 or p_batch_size > 50 then
    raise exception 'Batch size must be between 1 and 50.';
  end if;
  select image_tag into v_tag from releases where id = p_release;
  if v_tag is null then
    raise exception 'That release does not exist.';
  end if;
  if exists (select 1 from rollouts where status in ('running', 'halted')) then
    raise exception 'Another rollout is still active. Finish or cancel it first.';
  end if;
  select count(*) into v_tests from schools
   where status = 'active' and cardinality(hostnames) > 0
     and supabase_project_ref is not null and rollout_group = 'test';
  if v_tests = 0 then
    raise exception 'Mark at least one active school as the test school first.';
  end if;

  insert into rollouts (release_id, image_tag, batch_size, created_by)
  values (p_release, v_tag, p_batch_size, p_by)
  returning id into v_id;

  insert into rollout_steps (rollout_id, school_id, position, stage, batch_no)
  select v_id, e.id,
         (row_number() over (order by e.grp, e.slug))::integer,
         case e.rollout_group when 'standard' then 'batch' else e.rollout_group end,
         case when e.rollout_group = 'standard'
              then ceil(e.idx::numeric / p_batch_size)::integer else 0 end
    from (
      select id, slug, rollout_group,
             case rollout_group when 'test' then 0 when 'pilot' then 1 else 2 end as grp,
             row_number() over (partition by rollout_group order by slug) as idx
        from schools
       where status = 'active' and cardinality(hostnames) > 0 and supabase_project_ref is not null
    ) e;

  return v_id;
end;
$$;

-- Starts the next released step if nothing is in flight; halts on a failure;
-- finishes the rollout when every step has succeeded. Internal: callers lock
-- the rollout row first.
create or replace function advance_rollout(p_rollout uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  r rollouts;
  s rollout_steps;
  v_job uuid;
begin
  select * into r from rollouts where id = p_rollout for update;
  if r.status <> 'running' then
    return;
  end if;
  if exists (select 1 from rollout_steps where rollout_id = p_rollout and status in ('queued', 'running')) then
    return;
  end if;
  if exists (select 1 from rollout_steps where rollout_id = p_rollout and status = 'failed') then
    update rollouts set status = 'halted',
           halt_reason = coalesce(halt_reason, 'A step failed.')
     where id = p_rollout;
    return;
  end if;

  select * into s from rollout_steps
   where rollout_id = p_rollout and status = 'pending' and position <= r.released_through
   order by position limit 1;
  if found then
    insert into jobs (type, school_id, payload)
    values ('rollout_step', s.school_id,
            jsonb_build_object('rollout_id', p_rollout, 'step_id', s.id))
    returning id into v_job;
    update rollout_steps set status = 'queued', job_id = v_job where id = s.id;
    return;
  end if;

  if not exists (select 1 from rollout_steps where rollout_id = p_rollout and status <> 'succeeded') then
    update rollouts set status = 'succeeded', finished_at = now() where id = p_rollout;
  end if;
end;
$$;

-- Lets more of the rollout run, in canary order:
--   test        the test schools (first)
--   pilot       the pilot schools (after every test school succeeded)
--   next_batch  the next batch of the rest (after test and pilot succeeded)
--   all         everything left (same condition)
-- Nothing further can be released while a released school is unfinished or failed.
create or replace function release_rollout(p_rollout uuid, p_target text)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  r rollouts;
  v_through integer;
  v_batch integer;
begin
  select * into r from rollouts where id = p_rollout for update;
  if r.id is null then
    raise exception 'That rollout does not exist.';
  end if;
  if r.status <> 'running' then
    raise exception 'The rollout is % and cannot release more schools.', r.status;
  end if;
  if exists (select 1 from rollout_steps
              where rollout_id = p_rollout and position <= r.released_through and status <> 'succeeded') then
    raise exception 'Wait for the schools already released to finish first.';
  end if;

  if p_target = 'test' then
    select max(position) into v_through from rollout_steps where rollout_id = p_rollout and stage = 'test';
  elsif p_target = 'pilot' then
    if exists (select 1 from rollout_steps where rollout_id = p_rollout and stage = 'test' and status <> 'succeeded') then
      raise exception 'Every test school must succeed before the pilot.';
    end if;
    select max(position) into v_through from rollout_steps where rollout_id = p_rollout and stage = 'pilot';
    if v_through is null then
      raise exception 'No pilot school is in this rollout. Mark one, or release the next batch.';
    end if;
  elsif p_target in ('next_batch', 'all') then
    if exists (select 1 from rollout_steps where rollout_id = p_rollout and stage in ('test', 'pilot') and status <> 'succeeded') then
      raise exception 'Every test and pilot school must succeed before the rest.';
    end if;
    if p_target = 'all' then
      select max(position) into v_through from rollout_steps where rollout_id = p_rollout;
    else
      select min(batch_no) into v_batch from rollout_steps
       where rollout_id = p_rollout and stage = 'batch' and status = 'pending';
      if v_batch is null then
        raise exception 'There is no further batch to release.';
      end if;
      select max(position) into v_through from rollout_steps
       where rollout_id = p_rollout and stage = 'batch' and batch_no = v_batch;
    end if;
  else
    raise exception 'Unknown release target: %.', p_target;
  end if;

  if v_through is null or v_through <= r.released_through then
    raise exception 'That part of the rollout is already released.';
  end if;

  update rollouts set released_through = v_through where id = p_rollout;
  perform advance_rollout(p_rollout);
end;
$$;

-- The worker calls start_step when it picks a step up. False means the
-- rollout was cancelled meanwhile and the step must not run.
create or replace function start_step(p_step uuid)
returns boolean
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  s rollout_steps;
  r rollouts;
begin
  select * into s from rollout_steps where id = p_step for update;
  if s.id is null or s.status <> 'queued' then
    return false;
  end if;
  select * into r from rollouts where id = s.rollout_id;
  if r.status <> 'running' then
    update rollout_steps set status = 'cancelled', finished_at = now() where id = p_step;
    return false;
  end if;
  update rollout_steps set status = 'running', started_at = now(), finished_at = null, error = null
   where id = p_step;
  return true;
end;
$$;

create or replace function complete_step(p_step uuid, p_ok boolean, p_result jsonb, p_error text)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  s rollout_steps;
  r rollouts;
begin
  select * into s from rollout_steps where id = p_step for update;
  if s.id is null or s.status <> 'running' then
    raise exception 'Step % is not running.', p_step;
  end if;
  select * into r from rollouts where id = s.rollout_id for update;

  update rollout_steps
     set status = case when p_ok then 'succeeded' else 'failed' end,
         result = p_result,
         error = left(p_error, 1000),
         finished_at = now()
   where id = p_step;

  if r.status <> 'running' then
    return; -- cancelled while this step ran: record the outcome, change nothing else
  end if;
  if not p_ok then
    update rollouts set status = 'halted',
           halt_reason = left('A step failed: ' || coalesce(p_error, 'unknown error'), 500)
     where id = r.id;
  else
    perform advance_rollout(r.id);
  end if;
end;
$$;

create or replace function retry_step(p_step uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  s rollout_steps;
  r rollouts;
begin
  select * into s from rollout_steps where id = p_step for update;
  if s.id is null or s.status <> 'failed' then
    raise exception 'Only a failed step can be retried.';
  end if;
  select * into r from rollouts where id = s.rollout_id for update;
  if r.status <> 'halted' then
    raise exception 'The rollout is %, so this step cannot be retried.', r.status;
  end if;
  update rollout_steps
     set status = 'pending', attempt = attempt + 1, error = null, result = null,
         started_at = null, finished_at = null, job_id = null
   where id = p_step;
  update rollouts set status = 'running', halt_reason = null where id = r.id;
  perform advance_rollout(r.id);
end;
$$;

-- Stops a rollout. Steps not yet started are cancelled; a step already running
-- is not interrupted (half a migration is worse than a finished one) and its
-- outcome is recorded when it ends.
create or replace function cancel_rollout(p_rollout uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  r rollouts;
begin
  select * into r from rollouts where id = p_rollout for update;
  if r.id is null or r.status not in ('running', 'halted') then
    raise exception 'Only a running or halted rollout can be cancelled.';
  end if;
  update jobs set status = 'cancelled', finished_at = now()
   where status = 'queued' and type = 'rollout_step' and payload ->> 'rollout_id' = p_rollout::text;
  update rollout_steps set status = 'cancelled', finished_at = now()
   where rollout_id = p_rollout and status in ('pending', 'queued');
  update rollouts set status = 'cancelled', finished_at = now() where id = p_rollout;
end;
$$;

-- The worker hit a problem before it could do the job (for example the control
-- plane was briefly unreachable). Puts the job back after a short delay, or
-- fails it when its attempts are used up, failing its rollout step too.
create or replace function retry_job(p_job uuid, p_worker text, p_error text, p_delay_seconds integer)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  j jobs;
  v_step uuid;
  v_status text;
begin
  select * into j from jobs where id = p_job and locked_by = p_worker and status = 'running' for update;
  if j.id is null then
    raise exception 'Job % is not held by worker %.', p_job, p_worker;
  end if;
  if j.attempts < j.max_attempts then
    update jobs set status = 'queued', locked_by = null, locked_at = null,
           error = left(p_error, 1000),
           run_after = now() + make_interval(secs => greatest(p_delay_seconds, 0))
     where id = p_job;
    if j.type = 'rollout_step' then
      -- the step may have been started; it must be startable again
      update rollout_steps set status = 'queued'
       where id = (j.payload ->> 'step_id')::uuid and status = 'running';
    end if;
    return;
  end if;
  update jobs set status = 'failed', error = left(p_error, 1000), finished_at = now(),
         locked_by = null, locked_at = null
   where id = p_job;
  if j.type = 'rollout_step' then
    v_step := (j.payload ->> 'step_id')::uuid;
    select status into v_status from rollout_steps where id = v_step;
    if v_status = 'queued' then
      update rollout_steps set status = 'running', started_at = now() where id = v_step;
      v_status := 'running';
    end if;
    if v_status = 'running' then
      perform complete_step(v_step, false, null, p_error);
    end if;
  end if;
end;
$$;

-- Queues a read of each school's applied migrations (or one school's). A
-- school with a scan already waiting or running is skipped.
create or replace function enqueue_schema_scan(p_school uuid default null)
returns integer
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  n integer;
begin
  with eligible as (
    select id from schools
     where status in ('active', 'suspended') and supabase_project_ref is not null
       and (p_school is null or id = p_school)
       and not exists (select 1 from jobs j where j.school_id = schools.id
                        and j.type = 'schema_scan' and j.status in ('queued', 'running'))
  ), ins as (
    insert into jobs (type, school_id, payload)
    select 'schema_scan', id, '{}'::jsonb from eligible
    returning 1)
  select count(*) into n from ins;
  return n;
end;
$$;

-- Jobs whose worker went quiet go back in the queue; after max_attempts they
-- fail, and a rollout step that failed this way halts its rollout. Safe to
-- repeat: migrations are re-read from the school and deploys are idempotent.
create or replace function requeue_stale_jobs(p_stale_minutes integer)
returns integer
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  j jobs;
  n integer := 0;
  v_step uuid;
begin
  for j in
    select * from jobs
     where status = 'running' and locked_at < now() - make_interval(mins => p_stale_minutes)
     for update skip locked
  loop
    n := n + 1;
    if j.attempts >= j.max_attempts then
      update jobs set status = 'failed', error = 'The worker stopped responding.',
             finished_at = now(), locked_by = null, locked_at = null
       where id = j.id;
      if j.type = 'rollout_step' then
        v_step := (j.payload ->> 'step_id')::uuid;
        if exists (select 1 from rollout_steps where id = v_step and status = 'running') then
          perform complete_step(v_step, false, null, 'The worker stopped responding.');
        end if;
      end if;
    else
      update jobs set status = 'queued', locked_by = null, locked_at = null where id = j.id;
      if j.type = 'rollout_step' then
        -- start_step runs again when the job is picked up
        update rollout_steps set status = 'queued'
         where id = (j.payload ->> 'step_id')::uuid and status = 'running';
      end if;
    end if;
  end loop;
  return n;
end;
$$;

-- Only the service role may call any of these.
do $$
declare
  f text;
begin
  foreach f in array array[
    'claim_job(text, text[])', 'touch_job(uuid, text)',
    'finish_job(uuid, text, boolean, jsonb, text)',
    'create_rollout(uuid, integer, text)', 'advance_rollout(uuid)',
    'release_rollout(uuid, text)', 'start_step(uuid)',
    'complete_step(uuid, boolean, jsonb, text)', 'retry_step(uuid)',
    'cancel_rollout(uuid)', 'enqueue_schema_scan(uuid)', 'requeue_stale_jobs(integer)',
    'retry_job(uuid, text, text, integer)', 'register_release(text, text, text, jsonb)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;
