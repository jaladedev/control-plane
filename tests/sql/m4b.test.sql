-- M4b: the backup policy on rollouts, and the backups table and its functions.
\set ON_ERROR_STOP on
create or replace function pg_temp.assert(ok boolean, msg text) returns void language plpgsql as $$
begin
  if not coalesce(ok, false) then raise exception 'FAILED: %', msg; end if;
end $$;
create or replace function pg_temp.fails(stmt text) returns boolean language plpgsql as $$
begin
  execute stmt;
  return false;
exception when others then
  return true;
end $$;
-- the error text of a failing statement, or null when it succeeds
create or replace function pg_temp.err(stmt text) returns text language plpgsql as $$
begin
  execute stmt;
  return null;
exception when others then
  return sqlerrm;
end $$;

begin;
set local role service_role;

insert into releases (image_tag, registered_by) values (repeat('a', 40), 't');
insert into schools (id, slug, name, status, hostnames, supabase_project_ref, rollout_group) values
  ('10000000-0000-0000-0000-000000000001', 'aaa-test', 'Test', 'active', '{aaa.example.com}', 'refaaa', 'test'),
  ('10000000-0000-0000-0000-000000000002', 'bbb',      'B',    'active', '{bbb.example.com}', 'refbbb', 'standard'),
  ('10000000-0000-0000-0000-000000000003', 'ccc',      'C',    'active', '{ccc.example.com}', 'refccc', 'standard');

-- ---------------------------------------------------------------- policy
create temp table pol as
  select create_rollout((select id from releases limit 1), 2, 'owner@example.com') as r;
select pg_temp.assert((select backup_policy from rollouts where id = (select r from pol)) = 'required', 'a rollout planned the old way requires backups');
select pg_temp.assert(pg_temp.err($q$select create_rollout((select id from releases limit 1), 2, 't', 'whenever')$q$) like '%backup policy%', 'an unknown policy is refused');
select pg_temp.assert(pg_temp.err($q$select create_rollout((select id from releases limit 1), 2, 't', null)$q$) like '%backup policy%', 'a null policy is refused');
select cancel_rollout((select r from pol));
create temp table pol2 as
  select create_rollout((select id from releases limit 1), 2, 'owner@example.com', 'skip_if_expand_only') as r;
select pg_temp.assert((select backup_policy from rollouts where id = (select r from pol2)) = 'skip_if_expand_only', 'the skip policy is recorded');
select pg_temp.assert(pg_temp.fails($q$update rollouts set backup_policy = 'maybe'$q$), 'the policy column is checked');

-- ---------------------------------------------------------------- start / finish
select pg_temp.assert(pg_temp.err($q$select start_backup(gen_random_uuid(), null)$q$) like '%school does not exist%', 'a backup for an unknown school is refused');

create temp table b1 as select start_backup('10000000-0000-0000-0000-000000000001', null) as id;
select pg_temp.assert((select status from backups where id = (select id from b1)) = 'running', 'a started backup is running');

create temp table b2 as select start_backup('10000000-0000-0000-0000-000000000001', null) as id;
select pg_temp.assert((select status from backups where id = (select id from b1)) = 'failed', 'starting again closes a backup left running');
select pg_temp.assert((select error from backups where id = (select id from b1)) like '%stopped before%', 'and says why');
select pg_temp.assert((select status from backups where id = (select id from b2)) = 'running', 'the new backup is running');

create temp table b3 as select start_backup('10000000-0000-0000-0000-000000000002', null) as id;
select pg_temp.assert((select status from backups where id = (select id from b2)) = 'running', 'another school''s backup is left alone');

select pg_temp.assert(pg_temp.err(format($q$select finish_backup(%L, true, null, 10, %L, null)$q$, (select id from b2), repeat('a', 64))) like '%object key, size and checksum%', 'success needs an object key');
select pg_temp.assert(pg_temp.err(format($q$select finish_backup(%L, true, 'k', null, %L, null)$q$, (select id from b2), repeat('a', 64))) like '%object key, size and checksum%', 'success needs a size');
select pg_temp.assert(pg_temp.err(format($q$select finish_backup(%L, true, 'k', 10, null, null)$q$, (select id from b2))) like '%object key, size and checksum%', 'success needs a checksum');
select pg_temp.assert(pg_temp.fails(format($q$select finish_backup(%L, true, 'k', 10, 'not-hex', null)$q$, (select id from b2))), 'the checksum must be sha256 hex');
select pg_temp.assert(pg_temp.fails(format($q$select finish_backup(%L, true, 'k', 0, %L, null)$q$, (select id from b2), repeat('a', 64))), 'an empty backup is refused');
select pg_temp.assert((select status from backups where id = (select id from b2)) = 'running', 'refused finishes leave the backup running');

select finish_backup((select id from b2), true, 'schools/aaa-test/one.dump.age', 12345, repeat('a', 64), null);
select pg_temp.assert((select status = 'succeeded' and object_key = 'schools/aaa-test/one.dump.age' and size_bytes = 12345 and sha256 = repeat('a', 64) and finished_at is not null from backups where id = (select id from b2)), 'a finished backup records where it is and how to check it');
select pg_temp.assert(pg_temp.err(format($q$select finish_backup(%L, false, null, null, null, 'x')$q$, (select id from b2))) like '%is not running%', 'a finished backup cannot be finished again');
select pg_temp.assert(pg_temp.err(format($q$select finish_backup(%L, true, 'k', 1, %L, null)$q$, gen_random_uuid(), repeat('a', 64))) like '%is not running%', 'an unknown backup cannot be finished');

select finish_backup((select id from b3), false, null, null, null, repeat('x', 3000));
select pg_temp.assert((select status = 'failed' and length(error) = 1000 and object_key is null from backups where id = (select id from b3)), 'a failed backup keeps a clipped error and no object');

select pg_temp.assert(pg_temp.fails($q$insert into backups (school_id, status) values ('10000000-0000-0000-0000-000000000001', 'succeeded')$q$), 'a succeeded row without an object is refused by the table itself');

-- ---------------------------------------------------------------- append-only
select pg_temp.assert(pg_temp.err(format($q$update backups set object_key = 'elsewhere' where id = %L$q$, (select id from b2))) like '%append-only%', 'a finished backup''s object cannot be changed');
select pg_temp.assert(pg_temp.err(format($q$update backups set status = 'failed' where id = %L$q$, (select id from b2))) like '%append-only%', 'a finished backup''s status cannot be changed');
select pg_temp.assert(pg_temp.err(format($q$update backups set sha256 = %L where id = %L$q$, repeat('b', 64), (select id from b2))) like '%append-only%', 'a finished backup''s checksum cannot be changed');
select pg_temp.assert(pg_temp.err($q$delete from backups$q$) like '%append-only%', 'backups cannot be deleted');
select pg_temp.assert(pg_temp.err($q$delete from schools where slug = 'aaa-test'$q$) is not null, 'a school with backups cannot be deleted');

-- ---------------------------------------------------------------- retention
-- five more finished backups for one school, oldest first, with fixed times
insert into backups (id, school_id, status, object_key, size_bytes, sha256, started_at, finished_at)
select ('20000000-0000-0000-0000-00000000000' || n)::uuid, '10000000-0000-0000-0000-000000000002', 'succeeded',
       'schools/bbb/' || n || '.dump.age', 100 * n, repeat('c', 64),
       timestamptz '2026-10-01 00:00:00+00' + (n || ' days')::interval,
       timestamptz '2026-10-01 00:10:00+00' + (n || ' days')::interval
  from generate_series(1, 5) n;

select pg_temp.assert((select count(*) from backups_to_prune('10000000-0000-0000-0000-000000000002', 2)) = 3, 'keep 2 of 5: three are due');
select pg_temp.assert((select string_agg(object_key, ',' order by started_at) from backups_to_prune('10000000-0000-0000-0000-000000000002', 2)) = 'schools/bbb/1.dump.age,schools/bbb/2.dump.age,schools/bbb/3.dump.age', 'the oldest are the ones due');
select pg_temp.assert((select count(*) from backups_to_prune('10000000-0000-0000-0000-000000000002', 10)) = 0, 'keeping more than exist prunes nothing');
select pg_temp.assert((select count(*) from backups_to_prune('10000000-0000-0000-0000-000000000002', 0)) = 4, 'keep 0 still keeps the newest one');
select pg_temp.assert((select count(*) from backups_to_prune('10000000-0000-0000-0000-000000000001', 1)) = 0, 'another school is not affected');

-- a backup tied to a running rollout is not due; once it is cancelled, it is
insert into backups (id, school_id, step_id, status, object_key, size_bytes, sha256, started_at, finished_at)
select ('30000000-0000-0000-0000-00000000000' || n)::uuid, '10000000-0000-0000-0000-000000000003',
       case when n = 1 then (select id from rollout_steps
                              where rollout_id = (select r from pol2)
                                and school_id = '10000000-0000-0000-0000-000000000003') end,
       'succeeded', 'schools/ccc/' || n || '.dump.age', 100 * n, repeat('d', 64),
       timestamptz '2026-10-01 00:00:00+00' + (n || ' days')::interval,
       timestamptz '2026-10-01 00:10:00+00' + (n || ' days')::interval
  from generate_series(1, 3) n;
select pg_temp.assert((select count(*) from backups_to_prune('10000000-0000-0000-0000-000000000003', 1)) = 1, 'a backup of a running rollout is not due');
select pg_temp.assert((select object_key from backups_to_prune('10000000-0000-0000-0000-000000000003', 1)) = 'schools/ccc/2.dump.age', 'only the untied old backup is due');
select cancel_rollout((select r from pol2));
select pg_temp.assert((select count(*) from backups_to_prune('10000000-0000-0000-0000-000000000003', 1)) = 2, 'once the rollout is over it is due again');

select mark_backup_pruned('20000000-0000-0000-0000-000000000001');
select pg_temp.assert((select pruned_at is not null from backups where id = '20000000-0000-0000-0000-000000000001'), 'pruning is recorded');
select pg_temp.assert((select count(*) from backups_to_prune('10000000-0000-0000-0000-000000000002', 2)) = 2, 'a pruned backup is not due again');
select pg_temp.assert(pg_temp.err($q$update backups set pruned_at = null where id = '20000000-0000-0000-0000-000000000001'$q$) like '%append-only%', 'pruning cannot be undone');
select pg_temp.assert(pg_temp.err($q$update backups set pruned_at = now() + interval '1 day' where id = '20000000-0000-0000-0000-000000000001'$q$) like '%append-only%', 'nor changed');
select pg_temp.assert((select count(*) from backups_to_prune('10000000-0000-0000-0000-000000000002', 2) where status <> 'succeeded') = 0, 'only succeeded backups are ever due');

-- a failed or running backup is never due
select pg_temp.assert((select count(*) from backups_to_prune('10000000-0000-0000-0000-000000000001', 1)) = 0, 'a failed or running backup is never due');

-- the step link may be cleared (rollout deleted) but not pointed elsewhere
select pg_temp.assert(pg_temp.fails($q$update backups set step_id = (select id from rollout_steps limit 1) where id = '20000000-0000-0000-0000-000000000002'$q$), 'a finished backup cannot be moved to another step');
select pg_temp.assert((select step_id is not null from backups where id = '30000000-0000-0000-0000-000000000001'), 'the tied backup points at its step before the rollout is deleted');
delete from rollouts where id = (select r from pol2);
select pg_temp.assert((select step_id is null from backups where id = '30000000-0000-0000-0000-000000000001'), 'deleting a rollout clears the link');
select pg_temp.assert((select count(*) from backups where id = '30000000-0000-0000-0000-000000000001') = 1, 'and keeps the backup record');

reset role;

-- ---------------------------------------------------------------- privileges
insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000a1', 'owner@example.com');
insert into dashboard_users (id, email, role) values ('00000000-0000-0000-0000-0000000000a1', 'owner@example.com', 'owner');
select set_config('test.uid', '00000000-0000-0000-0000-0000000000a1', true);
select set_config('test.jwt', '{"aal":"aal1"}', true);
set local role authenticated;
select pg_temp.assert((select count(*) from backups) = 0, 'an aal1 session cannot read backups');
reset role;
select set_config('test.jwt', '{"aal":"aal2"}', true);
set local role authenticated;
select pg_temp.assert((select count(*) from backups) > 0, 'an aal2 dashboard user reads backups');
select pg_temp.assert(pg_temp.fails($q$insert into backups (school_id) values ('10000000-0000-0000-0000-000000000001')$q$), 'a signed-in user cannot insert backups');
select pg_temp.assert(pg_temp.fails($q$update backups set error = 'x'$q$), 'a signed-in user cannot edit backups');
select pg_temp.assert(pg_temp.fails($q$delete from backups$q$), 'a signed-in user cannot delete backups');
select pg_temp.assert(pg_temp.fails($q$select start_backup('10000000-0000-0000-0000-000000000001', null)$q$), 'a signed-in user cannot start a backup');
select pg_temp.assert(pg_temp.fails($q$select finish_backup(gen_random_uuid(), false, null, null, null, 'x')$q$), 'a signed-in user cannot finish a backup');
select pg_temp.assert(pg_temp.fails($q$select backups_to_prune('10000000-0000-0000-0000-000000000001', 1)$q$), 'a signed-in user cannot list backups to prune');
select pg_temp.assert(pg_temp.fails($q$select mark_backup_pruned(gen_random_uuid())$q$), 'a signed-in user cannot mark a backup pruned');
select pg_temp.assert(pg_temp.fails($q$select create_rollout((select id from releases limit 1), 2, 'x', 'required')$q$), 'a signed-in user cannot call the four-argument create_rollout');
reset role;
set local role anon;
select pg_temp.assert(pg_temp.fails($q$select count(*) from backups$q$), 'anon cannot read backups');
select pg_temp.assert(pg_temp.fails($q$select start_backup('10000000-0000-0000-0000-000000000001', null)$q$), 'anon cannot start a backup');
reset role;

rollback;
\echo ALL M4B SQL TESTS PASSED
