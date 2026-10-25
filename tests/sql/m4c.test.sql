-- M4 follow-up: downgrade guard, single-school rollouts, school rollback,
-- release registration from the dashboard.
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
create or replace function pg_temp.err(stmt text) returns text language plpgsql as $$
begin
  execute stmt;
  return null;
exception when others then
  return sqlerrm;
end $$;

begin;
set local role service_role;

insert into releases (image_tag) values (repeat('a', 40)), (repeat('b', 40)), (repeat('c', 40));
select id as ra from releases where image_tag = repeat('a', 40) \gset
select id as rb from releases where image_tag = repeat('b', 40) \gset
select id as rc from releases where image_tag = repeat('c', 40) \gset

insert into schools (slug, name, status, hostnames, supabase_project_ref, rollout_group, image_tag) values
  ('alpha', 'Alpha', 'active', '{alpha.example.com}', 'refalpha', 'test', repeat('b', 40)),
  ('beta', 'Beta', 'active', '{beta.example.com}', 'refbeta', 'standard', repeat('a', 40)),
  ('gone', 'Gone', 'suspended', '{gone.example.com}', 'refgone', 'standard', repeat('a', 40)),
  ('nohost', 'No host', 'active', '{}', 'refnohost', 'standard', repeat('a', 40));
select id as alpha from schools where slug = 'alpha' \gset
select id as beta from schools where slug = 'beta' \gset
select id as gone from schools where slug = 'gone' \gset
select id as nohost from schools where slug = 'nohost' \gset

-- ------------------------------------------------------------ job types
select pg_temp.assert(not pg_temp.fails($q$insert into jobs (type) values ('school_rollback')$q$), 'school_rollback is a job type');
select pg_temp.assert(not pg_temp.fails($q$insert into jobs (type) values ('register_release')$q$), 'register_release is a job type');
select pg_temp.assert(pg_temp.fails($q$insert into jobs (type) values ('shell')$q$), 'other job types are still refused');
delete from jobs;

-- ------------------------------------------- full rollout: no downgrades
select pg_temp.assert(pg_temp.err(format($q$select create_rollout(%L, 5, 't')$q$, :'ra')) like '%newer release than this one: alpha (release %',
  'a full rollout of an older release over a school on a newer one is refused, naming the school');
select pg_temp.assert(pg_temp.err(format($q$select create_rollout(%L, 5, 't', 'skip_if_expand_only')$q$, :'ra')) like '%newer release than this one%',
  'the downgrade guard also applies when a backup policy is given');
select pg_temp.assert(pg_temp.err(format($q$select create_rollout(%L, 5, 't', 'whenever')$q$, :'rc')) like '%backup policy%',
  'an unknown backup policy is still refused after this migration');
select pg_temp.assert(not pg_temp.fails(format($q$select create_rollout(%L, 5, 't')$q$, :'rc')), 'a rollout of the newest release is fine');
select pg_temp.assert((select scope from rollouts) = 'all', 'a full rollout has scope all');
select cancel_rollout(id) from rollouts;
select pg_temp.assert((select count(*) from rollouts where status in ('running','halted')) = 0, 'cancelled');
select create_rollout(:'rc', 5, 't', 'skip_if_expand_only') as rp \gset
select pg_temp.assert((select backup_policy = 'skip_if_expand_only' from rollouts where id = :'rp'),
  'the backup policy is kept by the version of create_rollout that has the downgrade guard');
select pg_temp.assert((select backup_policy = 'required' from rollouts where scope = 'all' and id <> :'rp'),
  'and a rollout planned without one requires backups');
select cancel_rollout(:'rp');

-- ------------------------------------------------- single-school rollout
select pg_temp.assert(pg_temp.err(format($q$select create_school_rollout(%L, %L, 't')$q$, gen_random_uuid(), :'beta')) like '%release does not exist%', 'unknown release is refused');
select pg_temp.assert(pg_temp.err(format($q$select create_school_rollout(%L, %L, 't')$q$, :'rb', gen_random_uuid())) like '%school does not exist%', 'unknown school is refused');
select pg_temp.assert(pg_temp.err(format($q$select create_school_rollout(%L, %L, 't')$q$, :'rb', :'gone')) like '%not active%', 'a suspended school is refused');
select pg_temp.assert(pg_temp.err(format($q$select create_school_rollout(%L, %L, 't')$q$, :'rb', :'nohost')) like '%no hostname%', 'a school without a hostname is refused');
select pg_temp.assert(pg_temp.err(format($q$select create_school_rollout(%L, %L, 't')$q$, :'rb', :'alpha')) like '%already runs this release%', 'a school already on the release is refused');
select pg_temp.assert(pg_temp.err(format($q$select create_school_rollout(%L, %L, 't')$q$, :'ra', :'alpha')) like '%newer release than this one%', 'a school on a newer release is refused');

select create_school_rollout(:'rb', :'beta', 'owner@example.com') as r1 \gset
select pg_temp.assert((select scope = 'school' and released_through = 1 and status = 'running' and batch_size = 1 and created_by = 'owner@example.com' from rollouts where id = :'r1'), 'a school rollout is released at once');
select pg_temp.assert((select count(*) = 1 and bool_and(stage = 'single' and status = 'queued' and job_id is not null) from rollout_steps where rollout_id = :'r1'), 'one single step, already queued with a job');
select pg_temp.assert((select count(*) from jobs where type = 'rollout_step' and status = 'queued') = 1, 'one job for the worker');
select pg_temp.assert(pg_temp.err(format($q$select create_school_rollout(%L, %L, 't')$q$, :'rc', :'beta')) like '%Another rollout is still active%', 'only one rollout at a time');
select pg_temp.assert(pg_temp.fails(format($q$select release_rollout(%L, 'test')$q$, :'r1')), 'there is no stage to release in a school rollout');

select id as step1 from rollout_steps where rollout_id = :'r1' \gset
select pg_temp.assert(start_step(:'step1'), 'the worker can start the step');
select complete_step(:'step1', true, '{"deployed":true}', null);
select pg_temp.assert((select status from rollouts where id = :'r1') = 'succeeded', 'success finishes the rollout');

-- failure halts, retry resumes, and cancel works, as for a full rollout
select create_school_rollout(:'rc', :'beta', 'o') as r2 \gset
select id as step2 from rollout_steps where rollout_id = :'r2' \gset
select start_step(:'step2');
select complete_step(:'step2', false, null, 'boom');
select pg_temp.assert((select status from rollouts where id = :'r2') = 'halted', 'a failure halts the school rollout');
select retry_step(:'step2');
select pg_temp.assert((select status from rollouts where id = :'r2') = 'running', 'retry runs it again');
select pg_temp.assert((select status from rollout_steps where id = :'step2') = 'queued', 'with the step queued once more');
select cancel_rollout(:'r2');
select pg_temp.assert((select status from rollouts where id = :'r2') = 'cancelled', 'and it can be cancelled');
delete from jobs;

-- ----------------------------------------------------- school rollback
select pg_temp.assert(pg_temp.err(format($q$select queue_school_rollback(%L, 't')$q$, gen_random_uuid())) like '%school does not exist%', 'unknown school is refused');
select pg_temp.assert(pg_temp.err(format($q$select queue_school_rollback(%L, 't')$q$, :'gone')) like '%not active%', 'a suspended school cannot be rolled back');
select pg_temp.assert(pg_temp.err(format($q$select queue_school_rollback(%L, 't')$q$, :'nohost')) like '%no hostname%', 'a school without a hostname cannot be rolled back');

select queue_school_rollback(:'alpha', 'owner@example.com') as j1 \gset
select pg_temp.assert((select type = 'school_rollback' and school_id = :'alpha'::uuid and max_attempts = 1 and status = 'queued' and payload ->> 'by' = 'owner@example.com' from jobs where id = :'j1'),
  'a rollback is one queued job with a single attempt');
select pg_temp.assert(pg_temp.err(format($q$select queue_school_rollback(%L, 't')$q$, :'alpha')) like '%already queued or running%', 'no second rollback while one is pending');

-- one attempt only: a failure or a dead worker never repeats a (non-idempotent) rollback
select (claim_job('w1', array['school_rollback'])).id as claimed \gset
select pg_temp.assert(:'claimed' = :'j1', 'the worker claims it');
select retry_job(:'j1', 'w1', 'ssh hiccup', 0);
select pg_temp.assert((select status from jobs where id = :'j1') = 'failed', 'retry_job fails a rollback instead of requeueing it');
select queue_school_rollback(:'alpha', 't') as j2 \gset
select claim_job('w1', array['school_rollback']);
update jobs set locked_at = now() - interval '2 hours' where id = :'j2';
select pg_temp.assert(requeue_stale_jobs(30) = 1, 'a stale rollback job is handled');
select pg_temp.assert((select status from jobs where id = :'j2') = 'failed', 'and failed, never requeued');

-- not during that school's own rollout step; allowed when the rollout is halted
select create_school_rollout(:'rb', :'beta', 't') as r3 \gset
select id as step3 from rollout_steps where rollout_id = :'r3' \gset
select start_step(:'step3');
select pg_temp.assert(pg_temp.err(format($q$select queue_school_rollback(%L, 't')$q$, :'beta')) like '%being rolled out right now%', 'no rollback in the middle of the school''s own step');
select complete_step(:'step3', false, null, 'unhealthy');
select pg_temp.assert(not pg_temp.fails(format($q$select queue_school_rollback(%L, 't')$q$, :'beta')), 'but a halted rollout does not block rolling the school back');
select cancel_rollout(:'r3');
delete from jobs;

-- -------------------------------------------- registering from the dashboard
select pg_temp.assert(pg_temp.err($q$select queue_register_release('main', null, 't')$q$) like '%40-character%', 'a branch name is refused');
select pg_temp.assert(pg_temp.err($q$select queue_register_release(repeat('a', 40), null, 't')$q$) like '%already registered%', 'a registered release is refused');
select queue_register_release(repeat('d', 40), 'hotfix', 'owner@example.com') as j3 \gset
select pg_temp.assert((select type = 'register_release' and payload = jsonb_build_object('tag', repeat('d', 40), 'notes', 'hotfix', 'by', 'owner@example.com') from jobs where id = :'j3'), 'the job carries the tag, notes and who asked');
select pg_temp.assert(pg_temp.err($q$select queue_register_release(repeat('d', 40), null, 't')$q$) like '%already being registered%', 'no duplicate registration job');

-- --------------------------------------------------------------- access
reset role;
set local role authenticated;
select pg_temp.assert(pg_temp.fails($q$select create_school_rollout(gen_random_uuid(), gen_random_uuid(), 't')$q$), 'signed-in users cannot start a school rollout directly');
select pg_temp.assert(pg_temp.fails($q$select queue_school_rollback(gen_random_uuid(), 't')$q$), 'signed-in users cannot queue a rollback directly');
select pg_temp.assert(pg_temp.fails($q$select queue_register_release(repeat('e', 40), null, 't')$q$), 'signed-in users cannot queue a registration directly');
reset role;
set local role anon;
select pg_temp.assert(pg_temp.fails($q$select queue_school_rollback(gen_random_uuid(), 't')$q$), 'anon cannot queue a rollback');
reset role;

rollback;
\echo ALL M4C SQL TESTS PASSED
