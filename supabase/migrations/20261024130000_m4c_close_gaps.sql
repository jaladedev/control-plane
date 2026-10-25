-- M4 follow-up: standalone school rollback, single-school rollouts, release
-- registration from the dashboard, and a guard against moving schools to an
-- older release. Same rules as the rest of M4: the database enforces them, the
-- dashboard calls these after writing its audit row, only the service role may.
--
-- Runs AFTER 20261024120000_m4b_school_backups.sql: that file replaced
-- create_rollout with a four-argument version (the backup policy), and this one
-- adds the downgrade guard to that same four-argument function.

-- ---------------------------------------------------------------------------
-- Shapes
-- ---------------------------------------------------------------------------

alter table jobs drop constraint jobs_type_check;
alter table jobs add constraint jobs_type_check
  check (type in ('rollout_step', 'schema_scan', 'school_rollback', 'register_release'));

-- 'all' is the canary rollout over every active school; 'school' is one school.
alter table rollouts
  add column if not exists scope text not null default 'all' check (scope in ('all', 'school'));

alter table rollout_steps drop constraint rollout_steps_stage_check;
alter table rollout_steps add constraint rollout_steps_stage_check
  check (stage in ('test', 'pilot', 'batch', 'single'));

-- ---------------------------------------------------------------------------
-- Full rollouts: never move a school to an OLDER release
-- ---------------------------------------------------------------------------

-- Same as before, plus: refuse when a school that would be included already
-- runs a newer registered release. Going back is a rollback, which is its own
-- action; a rollout of an old release over newer schools is a mistake.
create or replace function create_rollout(
  p_release uuid,
  p_batch_size integer,
  p_by text,
  p_backup_policy text default 'required'
)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_id uuid;
  v_tag text;
  v_seq bigint;
  v_tests integer;
  v_newer text;
begin
  if p_batch_size is null or p_batch_size < 1 or p_batch_size > 50 then
    raise exception 'Batch size must be between 1 and 50.';
  end if;
  if p_backup_policy is null or p_backup_policy not in ('required', 'skip_if_expand_only') then
    raise exception 'The backup policy must be required or skip_if_expand_only.';
  end if;
  select image_tag, seq into v_tag, v_seq from releases where id = p_release;
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

  select string_agg(s.slug || ' (release ' || r.seq || ')', ', ' order by s.slug) into v_newer
    from schools s join releases r on r.image_tag = s.image_tag
   where s.status = 'active' and cardinality(s.hostnames) > 0
     and s.supabase_project_ref is not null and r.seq > v_seq;
  if v_newer is not null then
    raise exception 'Already on a newer release than this one: %. Roll out the newest release, or roll those schools back first.', v_newer;
  end if;

  insert into rollouts (release_id, image_tag, batch_size, backup_policy, created_by)
  values (p_release, v_tag, p_batch_size, p_backup_policy, p_by)
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

-- ---------------------------------------------------------------------------
-- One school
-- ---------------------------------------------------------------------------

-- A rollout of one school, for an urgent fix or an upgrade of a single school.
-- No canary stages: the owner chose one school and typed its name. It is
-- released at once, and everything else (halt on failure, retry, cancel, the
-- one-rollout lock) works as for a full rollout.
create or replace function create_school_rollout(p_release uuid, p_school uuid, p_by text)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_id uuid;
  v_tag text;
  v_seq bigint;
  s schools;
  v_current bigint;
begin
  select image_tag, seq into v_tag, v_seq from releases where id = p_release;
  if v_tag is null then
    raise exception 'That release does not exist.';
  end if;
  select * into s from schools where id = p_school;
  if s.id is null then
    raise exception 'That school does not exist.';
  end if;
  if s.status <> 'active' or cardinality(s.hostnames) = 0 or s.supabase_project_ref is null then
    raise exception '% is not active, or has no hostname or database, so it cannot be rolled out.', s.slug;
  end if;
  if s.image_tag = v_tag then
    raise exception '% already runs this release.', s.slug;
  end if;
  select seq into v_current from releases where image_tag = s.image_tag;
  if v_current is not null and v_current > v_seq then
    raise exception '% runs a newer release than this one. Choose the newest release, or roll the school back.', s.slug;
  end if;
  if exists (select 1 from rollouts where status in ('running', 'halted')) then
    raise exception 'Another rollout is still active. Finish or cancel it first.';
  end if;

  insert into rollouts (release_id, image_tag, batch_size, scope, released_through, created_by)
  values (p_release, v_tag, 1, 'school', 1, p_by)
  returning id into v_id;
  insert into rollout_steps (rollout_id, school_id, position, stage, batch_no)
  values (v_id, p_school, 1, 'single', 0);

  perform advance_rollout(v_id); -- queues the step's job straight away
  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Rolling a school back
-- ---------------------------------------------------------------------------

-- Queues a rollback of one school to the image it ran before. Migrations are
-- not undone (expand migrations are safe for the old app by design).
--
-- A rollback is NOT idempotent: the server swaps "current" and "previous", so
-- running it twice puts the school forward again. The job therefore gets one
-- attempt only (max_attempts = 1): if the worker dies mid-way it is failed for
-- a person to look at, never silently repeated.
create or replace function queue_school_rollback(p_school uuid, p_by text)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  s schools;
  v_job uuid;
begin
  select * into s from schools where id = p_school;
  if s.id is null then
    raise exception 'That school does not exist.';
  end if;
  if s.status <> 'active' or cardinality(s.hostnames) = 0 then
    raise exception '% is not active, or has no hostname, so it cannot be rolled back.', s.slug;
  end if;
  if exists (select 1 from jobs where school_id = p_school and type = 'school_rollback'
                and status in ('queued', 'running')) then
    raise exception 'A rollback of % is already queued or running.', s.slug;
  end if;
  if exists (select 1
               from rollout_steps st join rollouts r on r.id = st.rollout_id
              where st.school_id = p_school and st.status in ('queued', 'running')
                and r.status = 'running') then
    raise exception '% is being rolled out right now. Wait for that step to finish.', s.slug;
  end if;

  insert into jobs (type, school_id, payload, max_attempts)
  values ('school_rollback', p_school, jsonb_build_object('by', p_by), 1)
  returning id into v_job;
  return v_job;
end;
$$;

-- ---------------------------------------------------------------------------
-- Registering a release from the dashboard
-- ---------------------------------------------------------------------------

-- Queues the worker to read a commit's migrations from GitHub and register the
-- release. (The first registration, which needs --baseline, stays a CLI step.)
create or replace function queue_register_release(p_tag text, p_notes text, p_by text)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_job uuid;
begin
  if p_tag is null or p_tag !~ '^[0-9a-f]{40}$' then
    raise exception 'The release must be a full 40-character commit hash.';
  end if;
  if exists (select 1 from releases where image_tag = p_tag) then
    raise exception 'That release is already registered.';
  end if;
  if exists (select 1 from jobs where type = 'register_release'
                and payload ->> 'tag' = p_tag and status in ('queued', 'running')) then
    raise exception 'That release is already being registered.';
  end if;
  insert into jobs (type, payload)
  values ('register_release',
          jsonb_build_object('tag', p_tag, 'notes', left(p_notes, 500), 'by', p_by))
  returning id into v_job;
  return v_job;
end;
$$;

do $$
declare
  f text;
begin
  foreach f in array array[
    'create_rollout(uuid, integer, text, text)', 'create_school_rollout(uuid, uuid, text)',
    'queue_school_rollback(uuid, text)', 'queue_register_release(text, text, text)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;
