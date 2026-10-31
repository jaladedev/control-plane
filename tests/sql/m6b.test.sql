-- Plan M6: applying settings to a running school, and restore drills.
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

insert into releases (image_tag) values (repeat('a', 40));
insert into schools (slug, name, status, hostnames, image_tag, supabase_project_ref) values
  ('alpha', 'Alpha', 'active', '{alpha.example.com}', repeat('a', 40), 'refalpha'),
  ('beta', 'Beta', 'active', '{beta.example.com}', repeat('a', 40), 'refbeta'),
  ('gone', 'Gone', 'suspended', '{gone.example.com}', repeat('a', 40), 'refgone'),
  ('nohost', 'No host', 'active', '{}', repeat('a', 40), 'refnohost'),
  ('fresh', 'Fresh', 'provisioning', '{fresh.example.com}', null, null);
select id as alpha from schools where slug = 'alpha' \gset
select id as beta from schools where slug = 'beta' \gset
select id as gone from schools where slug = 'gone' \gset
select id as nohost from schools where slug = 'nohost' \gset
select id as fresh from schools where slug = 'fresh' \gset

-- ------------------------------------------------------- applying settings
select pg_temp.assert(pg_temp.err(format($q$select queue_reconfigure(%L, 't')$q$, gen_random_uuid())) like '%does not exist%', 'an unknown school is refused');
select pg_temp.assert(pg_temp.err(format($q$select queue_reconfigure(%L, 't')$q$, :'gone')) like '%not active%', 'a suspended school is refused');
select pg_temp.assert(pg_temp.err(format($q$select queue_reconfigure(%L, 't')$q$, :'fresh')) like '%not active%', 'a school still provisioning is refused');
select pg_temp.assert(pg_temp.err(format($q$select queue_reconfigure(%L, 't')$q$, :'nohost')) like '%no hostname%', 'a school with no hostname is refused');
select pg_temp.assert((select count(*) = 0 from jobs where type = 'reconfigure_school'), 'a refused request queues nothing');

select queue_reconfigure(:'alpha', 'owner@example.com') as j1 \gset
select pg_temp.assert((select type = 'reconfigure_school' and status = 'queued' and max_attempts = 1
                              and school_id = :'alpha'::uuid and payload = jsonb_build_object('by', 'owner@example.com')
                         from jobs where id = :'j1'), 'queued for that school, one attempt, with who asked');
select pg_temp.assert(pg_temp.err(format($q$select queue_reconfigure(%L, 't')$q$, :'alpha')) like '%already queued or running%', 'no second job while one is waiting');
select pg_temp.assert(not pg_temp.fails(format($q$select queue_reconfigure(%L, 't')$q$, :'beta')), 'another school is not blocked');

update jobs set status = 'succeeded' where id = :'j1';
select pg_temp.assert(not pg_temp.fails(format($q$select queue_reconfigure(%L, 't')$q$, :'alpha')), 'after it finishes, it can be queued again');
update jobs set status = 'failed' where school_id = :'alpha';

-- a rollback or a provisioning job in flight blocks it
select queue_school_rollback(:'alpha', 't') as rb \gset
select pg_temp.assert(pg_temp.err(format($q$select queue_reconfigure(%L, 't')$q$, :'alpha')) like '%already queued or running%', 'not while a rollback is queued');
update jobs set status = 'failed' where id = :'rb';

-- a running rollout step for the school blocks it
select id as rel from releases limit 1 \gset
insert into releases (image_tag) values (repeat('b', 40));
select id as relb from releases where image_tag = repeat('b', 40) \gset
select create_school_rollout(:'relb', :'alpha', 't') as ro \gset
select pg_temp.assert(pg_temp.err(format($q$select queue_reconfigure(%L, 't')$q$, :'alpha')) like '%being rolled out right now%', 'not in the middle of the school''s own rollout step');
delete from jobs where type = 'rollout_step';

select pg_temp.assert(pg_temp.fails($q$insert into jobs (type) values ('reconfigure_everything')$q$), 'the job type list is enforced');

-- ------------------------------------------------------------ restore drills
insert into backups (school_id, status, object_key, size_bytes, sha256, finished_at)
  values (:'alpha', 'succeeded', 'schools/alpha/x.dump.age', 2048, repeat('c', 64), now());
insert into backups (school_id, status, error, finished_at)
  values (:'alpha', 'failed', 'dump failed', now());
insert into backups (school_id, status, object_key, size_bytes, sha256, finished_at)
  values (:'beta', 'succeeded', 'schools/beta/y.dump.age', 2048, repeat('d', 64), now());
select id as good from backups where school_id = :'alpha' and status = 'succeeded' \gset
select id as failed from backups where school_id = :'alpha' and status = 'failed' \gset
select id as betas from backups where school_id = :'beta' \gset

select record_restore_drill(:'alpha', :'good', true, 754, 'matched', 'owner@example.com') as d1 \gset
select pg_temp.assert((select ok and seconds = 754 and notes = 'matched' and recorded_by = 'owner@example.com'
                              and school_id = :'alpha'::uuid and backup_id = :'good'::uuid and drilled_at is not null
                         from restore_drills where id = :'d1'), 'a drill is recorded with its backup, time and who');
select record_restore_drill(:'alpha', null, false, 30, 'the key was the wrong one', 'owner@example.com');
select record_restore_drill(null, null, true, 120, 'control plane', 'owner@example.com');
select pg_temp.assert((select count(*) = 3 from restore_drills), 'a failed drill with no backup and a control-plane drill are recorded');
select record_restore_drill(:'alpha', :'good', true, 1, repeat('n', 5000), 'o');
select pg_temp.assert((select max(char_length(notes)) = 1000 from restore_drills), 'long notes are cut to 1000');

select pg_temp.assert(pg_temp.err(format($q$select record_restore_drill(%L, null, true, 1, null, 'o')$q$, gen_random_uuid())) like '%school does not exist%', 'an unknown school is refused');
select pg_temp.assert(pg_temp.err(format($q$select record_restore_drill(%L, %L, true, 1, null, 'o')$q$, :'alpha', gen_random_uuid())) like '%backup does not exist%', 'an unknown backup is refused');
select pg_temp.assert(pg_temp.err(format($q$select record_restore_drill(%L, %L, true, 1, null, 'o')$q$, :'alpha', :'betas')) like '%another school%', 'another school''s backup is refused');
select pg_temp.assert(pg_temp.err(format($q$select record_restore_drill(%L, %L, true, 1, null, 'o')$q$, :'alpha', :'failed')) like '%did not succeed%', 'a failed backup cannot be drilled');
select pg_temp.assert(pg_temp.err(format($q$select record_restore_drill(null, %L, true, 1, null, 'o')$q$, :'good')) like '%needs its school%', 'a school backup needs its school');
select pg_temp.assert(pg_temp.err(format($q$select record_restore_drill(%L, null, true, 1, null, 'o')$q$, :'alpha')) like '%must say which backup%', 'a passed school drill must name its backup');
select pg_temp.assert(pg_temp.err(format($q$select record_restore_drill(%L, %L, true, -1, null, 'o')$q$, :'alpha', :'good')) like '%between 0 and 86400%', 'negative seconds are refused');
select pg_temp.assert(pg_temp.err(format($q$select record_restore_drill(%L, %L, true, 86401, null, 'o')$q$, :'alpha', :'good')) like '%between 0 and 86400%', 'over a day is refused');
select pg_temp.assert(pg_temp.err(format($q$select record_restore_drill(%L, %L, true, 1, null, '')$q$, :'alpha', :'good')) like '%who did the drill%', 'who is required');

select pg_temp.assert(pg_temp.err(format($q$update restore_drills set ok = false where id = %L$q$, :'d1')) like '%append-only%', 'a drill cannot be edited');
select pg_temp.assert(pg_temp.err(format($q$delete from restore_drills where id = %L$q$, :'d1')) like '%append-only%', 'a drill cannot be deleted');
select pg_temp.assert(pg_temp.err($q$truncate restore_drills$q$) like '%append-only%', 'the table cannot be truncated');
select pg_temp.assert(pg_temp.fails(format($q$delete from backups where id = %L$q$, :'good')), 'a backup that has a drill cannot be deleted');
select pg_temp.assert(pg_temp.fails(format($q$delete from schools where id = %L$q$, :'alpha')), 'a school with drills cannot be deleted');

-- --------------------------------------------------------------- access
reset role;
set local role authenticated;
select pg_temp.assert(pg_temp.fails(format($q$select queue_reconfigure(%L, 't')$q$, :'beta')), 'signed-in users cannot queue settings directly');
select pg_temp.assert(pg_temp.fails(format($q$select record_restore_drill(%L, null, false, 1, null, 'o')$q$, :'beta')), 'signed-in users cannot record a drill directly');
select pg_temp.assert(pg_temp.fails($q$insert into restore_drills (ok, seconds, recorded_by) values (true, 1, 'x')$q$), 'signed-in users cannot write drills');
select pg_temp.assert((select count(*) = 0 from restore_drills), 'a session with no dashboard role sees no drills');
reset role;
set local role anon;
select pg_temp.assert(pg_temp.fails(format($q$select queue_reconfigure(%L, 't')$q$, :'beta')), 'anon cannot queue settings');
select pg_temp.assert(pg_temp.fails($q$select count(*) from restore_drills$q$), 'anon cannot read drills');
reset role;

rollback;
\echo ALL M6B SQL TESTS PASSED
