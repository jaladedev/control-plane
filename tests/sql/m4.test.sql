-- M4: registry immutability, the job queue, and the rollout state machine.
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
insert into releases (image_tag, registered_by) values (repeat('b', 40), 't');

-- ---------------------------------------------------------------- registry
select pg_temp.assert(pg_temp.fails($q$insert into releases (image_tag) values ('not-a-hash')$q$), 'release tag must be a 40-hex hash');
select pg_temp.assert(pg_temp.fails($q$insert into releases (image_tag) values (repeat('a', 40))$q$), 'release tags are unique');
select pg_temp.assert((select seq from releases where image_tag = repeat('b', 40)) > (select seq from releases where image_tag = repeat('a', 40)), 'releases are ordered by seq');
select pg_temp.assert(pg_temp.err($q$update releases set notes = 'x'$q$) like '%append-only%', 'releases cannot be edited');
select pg_temp.assert(pg_temp.err($q$delete from releases$q$) like '%append-only%', 'releases cannot be deleted');

insert into migrations (version, name, checksum, kind, release_id, sql)
select '20261001000000', '20261001000000_one', repeat('1', 64), 'expand', id, 'select 1' from releases where image_tag = repeat('a', 40);
select pg_temp.assert(pg_temp.fails($q$insert into migrations (version, name, checksum, release_id, sql)
  select '20261001000000', 'dup_version', repeat('1', 64), id, 'select 1' from releases limit 1$q$), 'migration versions are unique');
select pg_temp.assert(pg_temp.fails($q$insert into migrations (version, name, checksum, release_id, sql)
  select '2026', 'short_version', repeat('1', 64), id, 'select 1' from releases limit 1$q$), 'version must be 14 digits');
select pg_temp.assert(pg_temp.fails($q$insert into migrations (version, name, checksum, release_id, sql)
  select '20261002000000', 'bad_checksum', 'abc', id, 'select 1' from releases limit 1$q$), 'checksum must be sha256 hex');
select pg_temp.assert(pg_temp.fails($q$insert into migrations (version, name, checksum, kind, release_id, sql)
  select '20261002000000', 'contract_without_min', repeat('2', 64), 'contract', id, 'select 1' from releases limit 1$q$), 'a contract migration must name min_app_version');
select pg_temp.assert(not pg_temp.fails($q$insert into migrations (version, name, checksum, kind, min_app_version, release_id, sql)
  select '20261002000000', 'contract_ok', repeat('2', 64), 'contract', repeat('a', 40), id, 'select 1' from releases limit 1$q$), 'a contract migration with min_app_version is accepted');
select pg_temp.assert(pg_temp.fails($q$insert into migrations (version, name, checksum, kind, min_app_version, release_id, sql)
  select '20261003000000', 'unknown_min', repeat('3', 64), 'contract', repeat('c', 40), id, 'select 1' from releases limit 1$q$), 'min_app_version must be a registered release');
select pg_temp.assert(pg_temp.err($q$update migrations set sql = 'drop table x'$q$) like '%append-only%', 'migration SQL cannot be edited');
select pg_temp.assert(pg_temp.err($q$delete from migrations$q$) like '%append-only%', 'migrations cannot be deleted');

-- ---------------------------------------------------------------- register_release
select pg_temp.assert(pg_temp.err($q$select register_release('nope', null, 't', '[]')$q$) like '%40-character%', 'register_release: bad tag refused');
select pg_temp.assert(pg_temp.err($q$select register_release(repeat('a', 40), null, 't', '[]')$q$) like '%already registered%', 'register_release: a tag registers once');

select register_release(repeat('c', 40), 'notes', 'owner@example.com',
  jsonb_build_array(jsonb_build_object('version','20261010000000','name','20261010000000_r1','checksum',repeat('4',64),'kind','expand','sql','select 1')));
select pg_temp.assert((select count(*) from migrations where version = '20261010000000') = 1, 'register_release: records the migration');
select pg_temp.assert((select r.image_tag from migrations m join releases r on r.id = m.release_id where m.version = '20261010000000') = repeat('c', 40), 'register_release: ties it to the new release');
select pg_temp.assert((select registered_by from releases where image_tag = repeat('c', 40)) = 'owner@example.com', 'register_release: records who');

-- a failing migration rolls the whole release back
select pg_temp.assert(pg_temp.fails($q$select register_release(repeat('d', 40), null, 't', jsonb_build_array(
    jsonb_build_object('version','20261011000000','name','20261011000000_ok','checksum',repeat('5',64),'sql','select 1'),
    jsonb_build_object('version','20261012000000','name','20261012000000_bad','checksum','not-a-checksum','sql','select 1')))$q$), 'register_release: a bad migration fails the call');
select pg_temp.assert((select count(*) from releases where image_tag = repeat('d', 40)) = 0, 'register_release: and leaves no release behind');
select pg_temp.assert((select count(*) from migrations where version = '20261011000000') = 0, 'register_release: nor the good migration before it');

select pg_temp.assert(pg_temp.err($q$select register_release(repeat('e', 40), null, 't', jsonb_build_array(
    jsonb_build_object('version','20261009000000','name','20261009000000_old','checksum',repeat('6',64),'sql','select 1')))$q$) like '%not newer than the newest%', 'register_release: an older migration is refused');
select pg_temp.assert((select count(*) from releases where image_tag = repeat('e', 40)) = 0, 'register_release: no release for a refused older migration');

-- a contract migration may name the release being registered
select register_release(repeat('f', 40), null, 't', jsonb_build_array(
  jsonb_build_object('version','20261020000000','name','20261020000000_contract','checksum',repeat('7',64),'kind','contract','min_app_version',repeat('f', 40),'sql','select 1')));
select pg_temp.assert((select kind from migrations where version = '20261020000000') = 'contract', 'register_release: a contract migration naming its own release');
select pg_temp.assert(pg_temp.fails($q$select register_release(repeat('9', 40), null, 't', jsonb_build_array(
  jsonb_build_object('version','20261021000000','name','20261021000000_c','checksum',repeat('8',64),'kind','contract','sql','select 1')))$q$), 'register_release: a contract migration without min_app_version fails');
select register_release(repeat('8', 40), 'app-only release', 't', '[]');
select pg_temp.assert((select count(*) from releases where image_tag = repeat('8', 40)) = 1, 'register_release: a release with no migrations is fine');

-- ---------------------------------------------------------------- schools
insert into schools (id, slug, name, status, hostnames, supabase_project_ref, rollout_group) values
  ('10000000-0000-0000-0000-000000000001', 'aaa-test',  'Test',   'active',    '{aaa.example.com}', 'refaaa', 'test'),
  ('10000000-0000-0000-0000-000000000002', 'bbb-pilot', 'Pilot',  'active',    '{bbb.example.com}', 'refbbb', 'pilot'),
  ('10000000-0000-0000-0000-000000000003', 'ccc',       'C',      'active',    '{ccc.example.com}', 'refccc', 'standard'),
  ('10000000-0000-0000-0000-000000000004', 'ddd',       'D',      'active',    '{ddd.example.com}', 'refddd', 'standard'),
  ('10000000-0000-0000-0000-000000000005', 'eee',       'E',      'active',    '{eee.example.com}', 'refeee', 'standard'),
  ('10000000-0000-0000-0000-000000000006', 'fff',       'F',      'active',    '{fff.example.com}', 'refggg', 'standard'),
  ('10000000-0000-0000-0000-000000000007', 'ggg',       'G',      'active',    '{ggg.example.com}', 'refggg', 'standard'),
  ('10000000-0000-0000-0000-000000000008', 'hhh-susp',  'H',      'suspended', '{hhh.example.com}', 'refhhh', 'standard'),
  ('10000000-0000-0000-0000-000000000009', 'iii-nohost','I',      'active',    '{}',                'refiii', 'standard'),
  ('10000000-0000-0000-0000-00000000000a', 'jjj-noref', 'J',      'active',    '{jjj.example.com}', null,     'standard');
select pg_temp.assert(pg_temp.fails($q$update schools set rollout_group = 'canary' where slug = 'ccc'$q$), 'rollout_group is checked');

-- ---------------------------------------------------------------- planning
select pg_temp.assert(pg_temp.err($q$select create_rollout((select id from releases limit 1), 0, 't')$q$) like '%Batch size%', 'batch size 0 refused');
select pg_temp.assert(pg_temp.err($q$select create_rollout((select id from releases limit 1), 51, 't')$q$) like '%Batch size%', 'batch size 51 refused');
select pg_temp.assert(pg_temp.err($q$select create_rollout(gen_random_uuid(), 2, 't')$q$) like '%does not exist%', 'unknown release refused');

update schools set rollout_group = 'standard' where slug = 'aaa-test';
select pg_temp.assert(pg_temp.err($q$select create_rollout((select id from releases where image_tag = repeat('b', 40)), 2, 't')$q$) like '%test school%', 'no test school: refused');
update schools set rollout_group = 'test' where slug = 'aaa-test';

create temp table ctx as select create_rollout((select id from releases where image_tag = repeat('b', 40)), 2, 'owner@example.com') as r;
select pg_temp.assert((select count(*) from rollout_steps) = 7, 'plan covers active schools with hostname and ref only (7)');
select pg_temp.assert((select string_agg(s.slug, ',' order by st.position) from rollout_steps st join schools s on s.id = st.school_id) = 'aaa-test,bbb-pilot,ccc,ddd,eee,fff,ggg', 'order: test, pilot, then standard by slug');
select pg_temp.assert((select string_agg(st.stage || st.batch_no, ',' order by st.position) from rollout_steps st) = 'test0,pilot0,batch1,batch1,batch2,batch2,batch3', 'stages and batches of 2');
select pg_temp.assert((select min(position) = 1 and max(position) = 7 from rollout_steps), 'positions are 1..n');
select pg_temp.assert((select image_tag from rollouts) = repeat('b', 40) and (select status from rollouts) = 'running', 'rollout records the target tag and is running');
select pg_temp.assert(pg_temp.err($q$select create_rollout((select id from releases limit 1), 2, 't')$q$) like '%still active%', 'one active rollout at a time');
select pg_temp.assert(pg_temp.fails($q$insert into rollouts (release_id, image_tag, batch_size) select id, image_tag, 2 from releases limit 1$q$), 'the unique index also enforces the single active rollout');

-- ---------------------------------------------------------------- canary order
select pg_temp.assert(pg_temp.err($q$select release_rollout((select r from ctx), 'pilot')$q$) like '%test school must succeed%', 'pilot before test: refused');
select pg_temp.assert(pg_temp.err($q$select release_rollout((select r from ctx), 'next_batch')$q$) like '%test and pilot%', 'batch before test and pilot: refused');
select pg_temp.assert(pg_temp.err($q$select release_rollout((select r from ctx), 'all')$q$) like '%test and pilot%', 'all before test and pilot: refused');
select pg_temp.assert(pg_temp.err($q$select release_rollout((select r from ctx), 'everything')$q$) like '%Unknown release target%', 'unknown target refused');

select release_rollout((select r from ctx), 'test');
select pg_temp.assert((select released_through from rollouts) = 1, 'releasing test releases position 1');
select pg_temp.assert((select status from rollout_steps where position = 1) = 'queued', 'the test step is queued');
select pg_temp.assert((select count(*) from jobs where type = 'rollout_step' and status = 'queued') = 1, 'exactly one job is queued');
select pg_temp.assert(pg_temp.err($q$select release_rollout((select r from ctx), 'test')$q$) like '%Wait for the schools already released%', 'cannot release again while the test step is unfinished');

-- ---------------------------------------------------------------- queue
select pg_temp.assert((select count(*) from claim_job('w1', array['schema_scan'])) = 0, 'claim respects the type filter');
create temp table claimed as select * from claim_job('w1', array['rollout_step']);
select pg_temp.assert((select count(*) from claimed) = 1, 'a worker claims the job');
select pg_temp.assert((select status = 'running' and locked_by = 'w1' and attempts = 1 from jobs where id = (select id from claimed)), 'claimed job is running, locked and counted');
select pg_temp.assert((select count(*) from claim_job('w2', array['rollout_step'])) = 0, 'a second worker gets nothing');
select pg_temp.assert(touch_job((select id from claimed), 'w1'), 'the holder can touch its job');
select pg_temp.assert(not touch_job((select id from claimed), 'w2'), 'another worker cannot touch it');
select pg_temp.assert(pg_temp.err(format($f$select finish_job(%L, 'w2', true, null, null)$f$, (select id from claimed))) like '%not held%', 'another worker cannot finish it');

-- ---------------------------------------------------------------- running a step
select pg_temp.assert(start_step((select id from rollout_steps where position = 1)), 'start_step on a queued step in a running rollout');
select pg_temp.assert(not start_step((select id from rollout_steps where position = 1)), 'start_step twice is refused');
select complete_step((select id from rollout_steps where position = 1), true, '{"applied":[]}'::jsonb, null);
select finish_job((select id from claimed), 'w1', true, null, null);
select pg_temp.assert((select status from rollout_steps where position = 1) = 'succeeded', 'test step succeeded');
select pg_temp.assert((select count(*) from jobs where status = 'queued') = 0, 'no further job: the pilot is not released yet');
select pg_temp.assert((select status from rollouts) = 'running', 'rollout waits for the next release');
select pg_temp.assert(pg_temp.err($q$select complete_step((select id from rollout_steps where position = 1), true, null, null)$q$) like '%not running%', 'a finished step cannot be completed twice');

select pg_temp.assert(pg_temp.err($q$select release_rollout((select r from ctx), 'next_batch')$q$) like '%test and pilot%', 'batch still blocked by the pilot');
select release_rollout((select r from ctx), 'pilot');
select pg_temp.assert((select released_through from rollouts) = 2, 'pilot released');
create temp table c2 as select * from claim_job('w1', array['rollout_step']);
select start_step((select id from rollout_steps where position = 2));
select complete_step((select id from rollout_steps where position = 2), true, null, null);
select finish_job((select id from c2), 'w1', true, null, null);

-- first batch: releases positions 3 and 4 only, one at a time
select release_rollout((select r from ctx), 'next_batch');
select pg_temp.assert((select released_through from rollouts) = 4, 'next_batch releases batch 1 (positions 3-4)');
select pg_temp.assert((select count(*) from jobs where status = 'queued') = 1, 'only one batch job is queued at a time');
create temp table c3 as select * from claim_job('w1', array['rollout_step']);
select pg_temp.assert((select status from rollout_steps where position = 3) = 'queued', 'position 3 runs first');
select start_step((select id from rollout_steps where position = 3));
select pg_temp.assert((select count(*) from jobs where status = 'queued') = 0, 'position 4 waits for position 3');
select complete_step((select id from rollout_steps where position = 3), true, null, null);
select finish_job((select id from c3), 'w1', true, null, null);
select pg_temp.assert((select status from rollout_steps where position = 4) = 'queued', 'position 4 starts when position 3 succeeds');

-- a failure halts the rollout and nothing else starts
create temp table c4 as select * from claim_job('w1', array['rollout_step']);
select start_step((select id from rollout_steps where position = 4));
select complete_step((select id from rollout_steps where position = 4), false, '{"applied":["x"]}'::jsonb, 'boom');
select finish_job((select id from c4), 'w1', false, null, 'boom');
select pg_temp.assert((select status from rollouts) = 'halted', 'a failed step halts the rollout');
select pg_temp.assert((select halt_reason from rollouts) like '%boom%', 'the halt reason names the error');
select pg_temp.assert((select count(*) from jobs where status = 'queued') = 0, 'nothing else is queued after a failure');
select pg_temp.assert(pg_temp.err($q$select release_rollout((select r from ctx), 'all')$q$) like '%halted%', 'a halted rollout cannot release more');
select pg_temp.assert(pg_temp.err($q$select create_rollout((select id from releases limit 1), 2, 't')$q$) like '%still active%', 'a halted rollout still holds the lock');
select pg_temp.assert(pg_temp.err($q$select retry_step((select id from rollout_steps where position = 3))$q$) like '%Only a failed step%', 'only the failed step can be retried');

-- retry resumes the rollout
select retry_step((select id from rollout_steps where position = 4));
select pg_temp.assert((select status from rollouts) = 'running' and (select halt_reason from rollouts) is null, 'retry resumes the rollout');
select pg_temp.assert((select attempt from rollout_steps where position = 4) = 2, 'the step counts a second attempt');
select pg_temp.assert((select status from rollout_steps where position = 4) = 'queued', 'the retried step is queued again');
create temp table c4b as select * from claim_job('w1', array['rollout_step']);
select start_step((select id from rollout_steps where position = 4));
select complete_step((select id from rollout_steps where position = 4), true, null, null);
select finish_job((select id from c4b), 'w1', true, null, null);
select pg_temp.assert((select count(*) from jobs where status = 'queued') = 0, 'batch 1 done; batch 2 not released');

-- "all" releases every remaining step, still one at a time
select release_rollout((select r from ctx), 'all');
select pg_temp.assert((select released_through from rollouts) = 7, 'all releases through the last position');
do $$
declare
  j jobs;
  pos integer;
begin
  for pos in 5..7 loop
    select * into j from claim_job('w1', array['rollout_step']);
    perform pg_temp.assert(j.id is not null, 'a job is queued for position ' || pos);
    perform pg_temp.assert((select status from rollout_steps where position = pos) = 'queued', 'position ' || pos || ' is the one running');
    perform start_step((select id from rollout_steps where position = pos));
    perform complete_step((select id from rollout_steps where position = pos), true, null, null);
    perform finish_job(j.id, 'w1', true, null, null);
  end loop;
end $$;
select pg_temp.assert((select status from rollouts) = 'succeeded' and (select finished_at from rollouts) is not null, 'the rollout succeeds when every step has');
select pg_temp.assert((select count(*) from rollouts where status in ('running', 'halted')) = 0, 'the lock is released');

-- ---------------------------------------------------------------- cancel
drop table ctx;
create temp table ctx as select create_rollout((select id from releases where image_tag = repeat('b', 40)), 2, 't') as r;
select release_rollout((select r from ctx), 'test');
select cancel_rollout((select r from ctx));
select pg_temp.assert((select status from rollouts where id = (select r from ctx)) = 'cancelled', 'rollout cancelled');
select pg_temp.assert((select count(*) from rollout_steps where rollout_id = (select r from ctx) and status = 'cancelled') = 7, 'every unstarted step cancelled');
select pg_temp.assert((select count(*) from jobs where status = 'queued') = 0, 'its queued job was cancelled');
select pg_temp.assert(pg_temp.err($q$select cancel_rollout((select r from ctx))$q$) like '%Only a running or halted%', 'cancel twice refused');

-- cancelling while a step runs: it finishes, the rollout stays cancelled
drop table ctx;
create temp table ctx as select create_rollout((select id from releases where image_tag = repeat('b', 40)), 2, 't') as r;
select release_rollout((select r from ctx), 'test');
create temp table c5 as select * from claim_job('w1', array['rollout_step']);
select start_step((select id from rollout_steps where rollout_id = (select r from ctx) and position = 1));
select cancel_rollout((select r from ctx));
select pg_temp.assert((select status from rollout_steps where rollout_id = (select r from ctx) and position = 1) = 'running', 'the running step is not interrupted');
select complete_step((select id from rollout_steps where rollout_id = (select r from ctx) and position = 1), true, null, null);
select pg_temp.assert((select status from rollouts where id = (select r from ctx)) = 'cancelled', 'rollout stays cancelled when the running step ends');
select pg_temp.assert((select status from rollout_steps where rollout_id = (select r from ctx) and position = 1) = 'succeeded', 'the step outcome is still recorded');
select finish_job((select id from c5), 'w1', true, null, null);

-- a queued step whose rollout was cancelled before the worker started it
drop table ctx;
create temp table ctx as select create_rollout((select id from releases where image_tag = repeat('b', 40)), 2, 't') as r;
select release_rollout((select r from ctx), 'test');
create temp table c6 as select * from claim_job('w1', array['rollout_step']);
update rollouts set status = 'cancelled' where id = (select r from ctx);
select pg_temp.assert(not start_step((select id from rollout_steps where rollout_id = (select r from ctx) and position = 1)), 'start_step refuses in a cancelled rollout');
select pg_temp.assert((select status from rollout_steps where rollout_id = (select r from ctx) and position = 1) = 'cancelled', 'and marks the step cancelled');
select finish_job((select id from c6), 'w1', true, null, null);

-- ---------------------------------------------------------------- stale jobs
drop table ctx;
create temp table ctx as select create_rollout((select id from releases where image_tag = repeat('b', 40)), 2, 't') as r;
select release_rollout((select r from ctx), 'test');
create temp table c7 as select * from claim_job('w1', array['rollout_step']);
select start_step((select id from rollout_steps where rollout_id = (select r from ctx) and position = 1));
select pg_temp.assert(requeue_stale_jobs(30) = 0, 'a fresh job is not stale');
update jobs set locked_at = now() - interval '2 hours' where id = (select id from c7);
select pg_temp.assert(requeue_stale_jobs(30) = 1, 'a silent job is found');
select pg_temp.assert((select status from jobs where id = (select id from c7)) = 'queued', 'it goes back in the queue');
select pg_temp.assert((select status from rollout_steps where rollout_id = (select r from ctx) and position = 1) = 'queued', 'its step is queued again');
-- exhaust the attempts
update jobs set status = 'running', locked_by = 'w9', locked_at = now() - interval '2 hours', attempts = max_attempts where id = (select id from c7);
update rollout_steps set status = 'running' where rollout_id = (select r from ctx) and position = 1;
select requeue_stale_jobs(30);
select pg_temp.assert((select status from jobs where id = (select id from c7)) = 'failed', 'after max attempts the job fails');
select pg_temp.assert((select status from rollout_steps where rollout_id = (select r from ctx) and position = 1) = 'failed', 'its step fails');
select pg_temp.assert((select status from rollouts where id = (select r from ctx)) = 'halted', 'and the rollout halts');

-- ---------------------------------------------------------------- retry_job
-- the stale test above left a halted rollout; cancel it so a new one can start
update rollouts set status = 'cancelled' where status = 'halted';
drop table ctx;
create temp table ctx as select create_rollout((select id from releases where image_tag = repeat('b', 40)), 2, 't') as r;
select release_rollout((select r from ctx), 'test');
create temp table c8 as select * from claim_job('w1', array['rollout_step']);
select pg_temp.assert(pg_temp.err(format($f$select retry_job(%L, 'w2', 'x', 0)$f$, (select id from c8))) like '%not held%', 'another worker cannot retry the job');
select retry_job((select id from c8), 'w1', 'control plane unreachable', 60);
select pg_temp.assert((select status from jobs where id = (select id from c8)) = 'queued', 'retry_job puts the job back');
select pg_temp.assert((select status from rollout_steps where rollout_id = (select r from ctx) and position = 1) = 'queued', 'a step that had started is startable again');
select pg_temp.assert((select run_after > now() + interval '50 seconds' from jobs where id = (select id from c8)), 'after the delay');
select pg_temp.assert((select count(*) from claim_job('w1', array['rollout_step'])) = 0, 'it is not claimable before then');
update jobs set run_after = now() where id = (select id from c8);
create temp table c9 as select * from claim_job('w1', array['rollout_step']);
select pg_temp.assert((select attempts from jobs where id = (select id from c9)) = 2, 'the second attempt is counted');
update jobs set attempts = max_attempts where id = (select id from c9);
select retry_job((select id from c9), 'w1', 'still unreachable', 0);
select pg_temp.assert((select status from jobs where id = (select id from c9)) = 'failed', 'out of attempts the job fails');
select pg_temp.assert((select status from rollout_steps where rollout_id = (select r from ctx) and position = 1) = 'failed', 'and its step fails even though it never started');
select pg_temp.assert((select status from rollouts where id = (select r from ctx)) = 'halted', 'and the rollout halts');
update rollouts set status = 'cancelled' where id = (select r from ctx);

-- ---------------------------------------------------------------- migration runs
insert into migration_runs (school_id, migration_id, status)
select '10000000-0000-0000-0000-000000000001', id, 'failed' from migrations where version = '20261001000000';
insert into migration_runs (school_id, migration_id, status)
select '10000000-0000-0000-0000-000000000001', id, 'failed' from migrations where version = '20261001000000';
insert into migration_runs (school_id, migration_id, status, finished_at)
select '10000000-0000-0000-0000-000000000001', id, 'succeeded', now() from migrations where version = '20261001000000';
select pg_temp.assert(pg_temp.fails($q$insert into migration_runs (school_id, migration_id, status, finished_at)
  select '10000000-0000-0000-0000-000000000001', id, 'succeeded', now() from migrations where version = '20261001000000'$q$), 'a migration succeeds at most once per school');
select pg_temp.assert(not pg_temp.fails($q$insert into migration_runs (school_id, migration_id, status, finished_at)
  select '10000000-0000-0000-0000-000000000002', id, 'succeeded', now() from migrations where version = '20261001000000'$q$), 'but may succeed on another school');

-- ---------------------------------------------------------------- scans
delete from jobs;
select pg_temp.assert(enqueue_schema_scan() = 9, 'a scan per active or suspended school with a ref (9: a school with no hostname still has a database)');
select pg_temp.assert(enqueue_schema_scan() = 0, 'repeating while scans wait adds none');
select pg_temp.assert(enqueue_schema_scan('10000000-0000-0000-0000-000000000001') = 0, 'a single school with a waiting scan is skipped');
select pg_temp.assert((select count(*) from claim_job('w1', array['schema_scan'])) = 1, 'a scan can be claimed');

reset role;

-- ---------------------------------------------------------------- privileges
insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000a1', 'owner@example.com');
insert into dashboard_users (id, email, role) values ('00000000-0000-0000-0000-0000000000a1', 'owner@example.com', 'owner');
select set_config('test.uid', '00000000-0000-0000-0000-0000000000a1', true);
select set_config('test.jwt', '{"aal":"aal1"}', true);
set local role authenticated;
select pg_temp.assert((select count(*) from rollouts) = 0, 'an aal1 session cannot read rollouts');
select pg_temp.assert((select count(*) from migrations) = 0, 'an aal1 session cannot read migrations');
reset role;
select set_config('test.jwt', '{"aal":"aal2"}', true);
set local role authenticated;
select pg_temp.assert((select count(*) from rollouts) > 0, 'an aal2 dashboard user reads rollouts');
select pg_temp.assert((select count(*) from migrations) > 0, 'an aal2 dashboard user reads migrations');
select pg_temp.assert((select count(*) from jobs) > 0, 'an aal2 dashboard user reads jobs');
select pg_temp.assert(pg_temp.fails($q$insert into jobs (type) values ('schema_scan')$q$), 'a signed-in user cannot insert jobs');
select pg_temp.assert(pg_temp.fails($q$update rollouts set status = 'succeeded'$q$), 'a signed-in user cannot edit rollouts');
select pg_temp.assert(pg_temp.fails($q$insert into migrations (version, name, checksum, release_id, sql) select '20269999999999', 'x', repeat('1', 64), id, 'select 1' from releases limit 1$q$), 'a signed-in user cannot register migrations');
select pg_temp.assert(pg_temp.fails($q$select create_rollout((select id from releases limit 1), 2, 'x')$q$), 'a signed-in user cannot call create_rollout');
select pg_temp.assert(pg_temp.fails($q$select release_rollout(gen_random_uuid(), 'test')$q$), 'a signed-in user cannot call release_rollout');
select pg_temp.assert(pg_temp.fails($q$select claim_job('x', array['rollout_step'])$q$), 'a signed-in user cannot claim jobs');
select pg_temp.assert(pg_temp.fails($q$select complete_step(gen_random_uuid(), true, null, null)$q$), 'a signed-in user cannot complete steps');
select pg_temp.assert(pg_temp.fails($q$select retry_job(gen_random_uuid(), 'x', 'x', 0)$q$), 'a signed-in user cannot retry jobs');
select pg_temp.assert(pg_temp.fails($q$select register_release(repeat('7', 40), null, 'x', '[]')$q$), 'a signed-in user cannot register releases');
reset role;
set local role anon;
select pg_temp.assert(pg_temp.fails($q$select count(*) from rollouts$q$), 'anon cannot read rollouts');
select pg_temp.assert(pg_temp.fails($q$select claim_job('x', array['rollout_step'])$q$), 'anon cannot claim jobs');
reset role;

rollback;
\echo ALL M4 SQL TESTS PASSED
