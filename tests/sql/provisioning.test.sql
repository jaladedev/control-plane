-- Provisioning wizard (plan M5): queueing, step records, going live.
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

insert into schools (slug, name, status, hostnames, license_version, license_session, license_valid_until, license_grace_until) values
  ('newone', 'New One', 'provisioning', '{new.example.com}', 1, '2026/2027', now() + interval '30 days', now() + interval '44 days'),
  ('nohost', 'No host', 'provisioning', '{}', 1, '2026/2027', now() + interval '30 days', now() + interval '44 days'),
  ('nolicence', 'No licence', 'provisioning', '{nl.example.com}', 0, null, null, null),
  ('live', 'Live', 'active', '{live.example.com}', 1, '2026/2027', now() + interval '30 days', now() + interval '44 days');
select id as newone from schools where slug = 'newone' \gset
select id as nohost from schools where slug = 'nohost' \gset
select id as nolicence from schools where slug = 'nolicence' \gset
select id as live from schools where slug = 'live' \gset

-- ------------------------------------------------------------- queueing
select pg_temp.assert(pg_temp.err(format($q$select queue_provision(%L, 't')$q$, :'newone')) like '%No release is registered%', 'nothing to deploy without a release');
insert into releases (image_tag) values (repeat('a', 40));

select pg_temp.assert(pg_temp.err(format($q$select queue_provision(%L, 't')$q$, gen_random_uuid())) like '%does not exist%', 'an unknown school is refused');
select pg_temp.assert(pg_temp.err(format($q$select queue_provision(%L, 't')$q$, :'live')) like '%is active and is not being provisioned%', 'a live school is refused');
select pg_temp.assert(pg_temp.err(format($q$select queue_provision(%L, 't')$q$, :'nohost')) like '%no hostname%', 'a school without a hostname is refused');
select pg_temp.assert(pg_temp.err(format($q$select queue_provision(%L, 't')$q$, :'nolicence')) like '%no licence saved%', 'a school without a licence is refused');
select pg_temp.assert((select count(*) = 0 from jobs where type = 'provision_school'), 'a refused request queues nothing');

select queue_provision(:'newone', 'owner@example.com') as j1 \gset
select pg_temp.assert((select type = 'provision_school' and status = 'queued' and max_attempts = 3
                              and school_id = :'newone'::uuid
                              and payload = jsonb_build_object('by', 'owner@example.com')
                         from jobs where id = :'j1'), 'the job is queued for that school with who asked');
select pg_temp.assert((select count(*) = 6 and bool_and(status = 'pending') from provision_steps where school_id = :'newone'), 'six pending steps are created');
select pg_temp.assert((select array_agg(step order by step) = array['activate','container','database','health','license','storage'] from provision_steps where school_id = :'newone'), 'the six steps are the expected ones');
select pg_temp.assert(pg_temp.err(format($q$select queue_provision(%L, 't')$q$, :'newone')) like '%already queued or running%', 'no second job while one is waiting');
select pg_temp.assert(pg_temp.fails($q$insert into jobs (type) values ('provision_everything')$q$), 'the job type list is enforced');

-- ------------------------------------------------------------- recording
select pg_temp.assert(pg_temp.err(format($q$select record_provision_step(%L, 'database', 'pending', null)$q$, :'newone')) like '%running, succeeded or failed%', 'only real outcomes can be recorded');
select pg_temp.assert(pg_temp.fails(format($q$select record_provision_step(%L, 'database', 'succeeded', null)$q$, :'live')), 'a school that was never queued has no steps to record');
select pg_temp.assert(pg_temp.fails(format($q$select record_provision_step(%L, 'cleanup', 'running', null)$q$, :'newone')), 'an unknown step is refused');

select record_provision_step(:'newone', 'database', 'running', null);
select pg_temp.assert((select status = 'running' and attempts = 1 and started_at is not null and finished_at is null from provision_steps where school_id = :'newone' and step = 'database'), 'running sets the start time and counts the attempt');
select record_provision_step(:'newone', 'database', 'succeeded', '2 migration(s) applied');
select pg_temp.assert((select status = 'succeeded' and finished_at is not null and detail = '2 migration(s) applied' and attempts = 1 from provision_steps where school_id = :'newone' and step = 'database'), 'succeeded sets the finish time and keeps the detail');
select record_provision_step(:'newone', 'storage', 'running', null);
select record_provision_step(:'newone', 'storage', 'failed', repeat('x', 5000));
select pg_temp.assert((select status = 'failed' and length(detail) = 1000 from provision_steps where school_id = :'newone' and step = 'storage'), 'a long detail is cut to 1000 characters');

-- ------------------------------------------------------------- resuming
update jobs set status = 'failed' where id = :'j1';
select queue_provision(:'newone', 'owner@example.com') as j2 \gset
select pg_temp.assert((select status = 'succeeded' from provision_steps where school_id = :'newone' and step = 'database'), 'a succeeded step stays succeeded on resume');
select pg_temp.assert((select status = 'pending' and detail is null from provision_steps where school_id = :'newone' and step = 'storage'), 'a failed step goes back to pending on resume');
select record_provision_step(:'newone', 'container', 'running', null);
update jobs set status = 'failed' where id = :'j2';
select queue_provision(:'newone', 'owner@example.com');
select pg_temp.assert((select status = 'pending' from provision_steps where school_id = :'newone' and step = 'container'), 'a step left running by a dead job goes back to pending');
update jobs set status = 'failed' where school_id = :'newone' and status = 'queued';

-- ------------------------------------------------------------- going live
select pg_temp.assert(pg_temp.err(format($q$select activate_provisioned_school(%L, repeat('a', 40), '20260101000000', 't')$q$, :'newone')) like '%Not every provisioning step has succeeded%', 'cannot go live with steps outstanding');
update provision_steps set status = 'succeeded' where school_id = :'newone' and step <> 'activate';
select pg_temp.assert(pg_temp.err(format($q$select activate_provisioned_school(%L, 'main', '20260101000000', 't')$q$, :'newone')) like '%40-character%', 'a branch name is not a tag');
select pg_temp.assert(pg_temp.err(format($q$select activate_provisioned_school(%L, repeat('a', 40), '20260101000000', 't')$q$, :'live')) like '%cannot be activated%', 'a school that is not provisioning cannot be activated');

select activate_provisioned_school(:'newone', repeat('a', 40), '20260101000000', 'owner@example.com') as changed \gset
select pg_temp.assert(:'changed' = 't', 'going live reports a change');
select pg_temp.assert((select status = 'active' and image_tag = repeat('a', 40) and app_version = repeat('a', 40)
                              and schema_version = '20260101000000' and credentials_status = 'ok'
                         from schools where id = :'newone'), 'the school is active on that release and schema version');
select pg_temp.assert((select count(*) = 1 and bool_and(actor_email = 'system:provisioning' and details ->> 'requested_by' = 'owner@example.com'
                                                          and details ->> 'slug' = 'newone')
                         from audit_log where action = 'school.provisioned' and school_id = :'newone'), 'going live writes its own audit row, naming who asked');
select activate_provisioned_school(:'newone', repeat('a', 40), null, 'owner@example.com') as again \gset
select pg_temp.assert(:'again' = 'f', 'repeating it for a live school changes nothing');
select pg_temp.assert((select count(*) = 1 from audit_log where action = 'school.provisioned' and school_id = :'newone'), 'and writes no second audit row');
select pg_temp.assert((select schema_version = '20260101000000' from schools where id = :'newone'), 'a repeat with no schema version does not erase it');
select pg_temp.assert(pg_temp.err(format($q$select queue_provision(%L, 't')$q$, :'newone')) like '%is active%', 'a live school cannot be provisioned again');

-- --------------------------------------------------------------- access
reset role;
set local role authenticated;
select pg_temp.assert(pg_temp.fails(format($q$select queue_provision(%L, 't')$q$, :'newone')), 'signed-in users cannot queue provisioning directly');
select pg_temp.assert(pg_temp.fails(format($q$select record_provision_step(%L, 'database', 'failed', 'x')$q$, :'newone')), 'signed-in users cannot record a step');
select pg_temp.assert(pg_temp.fails(format($q$select activate_provisioned_school(%L, repeat('a', 40), null, 't')$q$, :'newone')), 'signed-in users cannot activate a school');
select pg_temp.assert(pg_temp.fails($q$insert into provision_steps (school_id, step) values (gen_random_uuid(), 'database')$q$), 'signed-in users cannot write steps');
select pg_temp.assert(pg_temp.fails($q$update provision_steps set status = 'succeeded'$q$), 'signed-in users cannot edit steps');
select pg_temp.assert((select count(*) = 0 from provision_steps), 'a session with no dashboard role sees no steps');
select set_config('test.uid', '11111111-1111-4111-8111-111111111111', true);
reset role;
set local role anon;
select pg_temp.assert(pg_temp.fails(format($q$select queue_provision(%L, 't')$q$, :'newone')), 'anon cannot queue provisioning');
select pg_temp.assert(pg_temp.fails($q$select count(*) from provision_steps$q$), 'anon cannot read steps');
reset role;

rollback;
\echo ALL PROVISIONING SQL TESTS PASSED
