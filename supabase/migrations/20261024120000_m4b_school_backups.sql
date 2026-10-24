-- M4b: a backup of a school's database before its migrations run.
--
-- The worker takes the backup (pg_dump, encrypted, uploaded to R2); this file
-- only records it, and holds the owner's choice about when one may be skipped.
-- Nothing here holds a key or a database URL.
--
-- backup_policy is the owner's decision when a rollout is planned:
--   required             every school with pending migrations is backed up first
--   skip_if_expand_only  a school whose pending migrations are all "expand" may
--                        skip it; a school with any contract migration pending
--                        is still backed up
-- The worker decides per school from the school's own migration table, because
-- that, not migration_runs, is the source of truth for what is pending.

alter table rollouts
  add column backup_policy text not null default 'required'
    check (backup_policy in ('required', 'skip_if_expand_only'));

-- Same function as in M4, plus the policy. A new signature, so the old one goes.
drop function create_rollout(uuid, integer, text);
create function create_rollout(
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
  v_tests integer;
begin
  if p_batch_size is null or p_batch_size < 1 or p_batch_size > 50 then
    raise exception 'Batch size must be between 1 and 50.';
  end if;
  if p_backup_policy is null or p_backup_policy not in ('required', 'skip_if_expand_only') then
    raise exception 'The backup policy must be required or skip_if_expand_only.';
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

-- One row per backup attempt. Never deleted; the object in R2 may be pruned
-- (pruned_at), the record stays so the history is complete.
create table backups (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references schools (id) on delete restrict,
  step_id uuid references rollout_steps (id) on delete set null,
  status text not null default 'running' check (status in ('running', 'succeeded', 'failed')),
  object_key text,
  size_bytes bigint check (size_bytes > 0),
  sha256 text check (sha256 ~ '^[0-9a-f]{64}$'),
  error text,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  pruned_at timestamptz,
  -- A backup only counts as succeeded when it says where it is and how to check it.
  constraint backups_succeeded_is_complete check (
    status <> 'succeeded'
    or (object_key is not null and size_bytes is not null and sha256 is not null
        and finished_at is not null)
  )
);
create index backups_school_idx on backups (school_id, started_at desc);
create index backups_step_idx on backups (step_id);

-- Once a backup has finished, only two things may change: its object may be
-- marked pruned, and its step link may be cleared (when a rollout is deleted).
create or replace function guard_backup_change()
returns trigger
language plpgsql
set search_path to 'public'
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'backups is append-only: a backup record cannot be removed.';
  end if;
  if old.status <> 'running' then
    if (new.id, new.school_id, new.status, new.object_key, new.size_bytes, new.sha256,
        new.error, new.started_at, new.finished_at)
       is distinct from
       (old.id, old.school_id, old.status, old.object_key, old.size_bytes, old.sha256,
        old.error, old.started_at, old.finished_at) then
      raise exception 'backups is append-only: a finished backup cannot be changed.';
    end if;
    if old.pruned_at is not null and new.pruned_at is distinct from old.pruned_at then
      raise exception 'backups is append-only: a finished backup cannot be changed.';
    end if;
    if new.step_id is distinct from old.step_id and new.step_id is not null then
      raise exception 'backups is append-only: a finished backup cannot be changed.';
    end if;
  end if;
  return new;
end;
$$;
create trigger backups_guard before update or delete on backups
  for each row execute function guard_backup_change();

alter table backups enable row level security;
create policy backups_select_any_role on backups
  for select to authenticated using (dashboard_role() is not null);
revoke all on backups from public, anon, authenticated;
grant select on backups to authenticated;

-- ---------------------------------------------------------------------------
-- Functions (service role only)
-- ---------------------------------------------------------------------------

-- Opens a backup record. A record still "running" for this school belongs to a
-- worker that died: it is closed as failed first, so it cannot be mistaken for
-- a backup in progress.
create or replace function start_backup(p_school uuid, p_step uuid)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_id uuid;
begin
  if not exists (select 1 from schools where id = p_school) then
    raise exception 'That school does not exist.';
  end if;
  update backups
     set status = 'failed', finished_at = now(),
         error = 'The worker stopped before this backup finished.'
   where school_id = p_school and status = 'running';
  insert into backups (school_id, step_id) values (p_school, p_step)
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function finish_backup(
  p_backup uuid,
  p_ok boolean,
  p_object_key text,
  p_size bigint,
  p_sha256 text,
  p_error text
)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  b backups;
begin
  select * into b from backups where id = p_backup for update;
  if b.id is null or b.status <> 'running' then
    raise exception 'Backup % is not running.', p_backup;
  end if;
  if p_ok then
    if p_object_key is null or p_size is null or p_sha256 is null then
      raise exception 'A successful backup needs its object key, size and checksum.';
    end if;
    update backups
       set status = 'succeeded', object_key = p_object_key, size_bytes = p_size,
           sha256 = p_sha256, finished_at = now()
     where id = p_backup;
  else
    update backups
       set status = 'failed', error = left(coalesce(p_error, 'unknown error'), 1000),
           finished_at = now()
     where id = p_backup;
  end if;
end;
$$;

-- Backups whose objects can be deleted: succeeded, not already pruned, older
-- than the newest p_keep for the school, and not belonging to a rollout that is
-- still running or halted (a halted rollout is where a restore is most likely).
create or replace function backups_to_prune(p_school uuid, p_keep integer)
returns setof backups
language sql
security definer
set search_path to 'public'
as $$
  select b.*
    from backups b
   where b.school_id = p_school
     and b.status = 'succeeded'
     and b.pruned_at is null
     and b.id not in (
       select id from backups
        where school_id = p_school and status = 'succeeded' and pruned_at is null
        order by started_at desc, id desc
        limit greatest(p_keep, 1))
     and not exists (
       select 1 from rollout_steps s join rollouts r on r.id = s.rollout_id
        where s.id = b.step_id and r.status in ('running', 'halted'))
   order by b.started_at, b.id;
$$;

create or replace function mark_backup_pruned(p_backup uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  update backups set pruned_at = now()
   where id = p_backup and status = 'succeeded' and pruned_at is null;
end;
$$;

do $$
declare
  f text;
begin
  foreach f in array array[
    'create_rollout(uuid, integer, text, text)',
    'start_backup(uuid, uuid)',
    'finish_backup(uuid, boolean, text, bigint, text, text)',
    'backups_to_prune(uuid, integer)',
    'mark_backup_pruned(uuid)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;
