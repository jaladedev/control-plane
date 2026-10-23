-- M1: licence and health columns, health_checks privileges, pruning.
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

begin;
insert into auth.users (id, email) values ('00000000-0000-0000-0000-00000000000a', 'owner@example.com');
insert into dashboard_users (id, email, role) values
  ('00000000-0000-0000-0000-00000000000a', 'owner@example.com', 'owner');
insert into schools (id, slug, name, hostnames) values
  ('10000000-0000-0000-0000-000000000001', 'greenfield', 'Greenfield', '{greenfield.example.com}');

-- defaults
select pg_temp.assert((select health_status from schools where slug = 'greenfield') = 'unknown', 'new school health is unknown');
select pg_temp.assert((select license_version from schools where slug = 'greenfield') = 0, 'new school licence version is 0');

-- licence dates must come as a pair and in order
select pg_temp.assert(pg_temp.fails($q$update schools set license_valid_until = now() where slug = 'greenfield'$q$), 'valid_until without grace_until is refused');
select pg_temp.assert(pg_temp.fails($q$update schools set license_valid_until = now(), license_grace_until = now() - interval '1 day' where slug = 'greenfield'$q$), 'grace before valid is refused');
select pg_temp.assert(not pg_temp.fails($q$update schools set license_valid_until = now(), license_grace_until = now() + interval '7 days' where slug = 'greenfield'$q$), 'ordered pair is accepted');

-- hostnames: lowercase DNS characters only
select pg_temp.assert(pg_temp.fails($q$update schools set hostnames = '{Bad.Example.com}' where slug = 'greenfield'$q$), 'uppercase hostname refused');
select pg_temp.assert(pg_temp.fails($q$update schools set hostnames = '{a.com/path}' where slug = 'greenfield'$q$), 'hostname with a path refused');
select pg_temp.assert(pg_temp.fails($q$update schools set hostnames = '{a.com:8080}' where slug = 'greenfield'$q$), 'hostname with a port refused');

-- health_checks: visible to a 2FA dashboard user, writable by nobody but the service role
insert into health_checks (school_id, ok, http_status, latency_ms, version) values
  ('10000000-0000-0000-0000-000000000001', true, 200, 80, 'abc123');
insert into health_checks (school_id, at, ok, error) values
  ('10000000-0000-0000-0000-000000000001', now() - interval '40 days', false, 'old');

select set_config('test.uid', '00000000-0000-0000-0000-00000000000a', true);
select set_config('test.jwt', '{"aal":"aal1"}', true);
set local role authenticated;
select pg_temp.assert((select count(*) from health_checks) = 0, 'aal1 session cannot read health checks');
reset role;

select set_config('test.jwt', '{"aal":"aal2"}', true);
set local role authenticated;
select pg_temp.assert((select count(*) from health_checks) = 2, 'aal2 owner reads health checks');
select pg_temp.assert(pg_temp.fails($q$insert into health_checks (school_id, ok) values ('10000000-0000-0000-0000-000000000001', true)$q$), 'signed-in user cannot insert health checks');
select pg_temp.assert(pg_temp.fails($q$delete from health_checks$q$), 'signed-in user cannot delete health checks');
select pg_temp.assert(pg_temp.fails($q$select prune_health_checks(30)$q$), 'signed-in user cannot run the pruner');
reset role;

set local role service_role;
select pg_temp.assert(prune_health_checks(30) = 1, 'pruner deletes only rows older than the window');
reset role;
select pg_temp.assert((select count(*) from health_checks) = 1, 'recent check survives pruning');

-- deleting a school removes its history
delete from schools where slug = 'greenfield';
select pg_temp.assert((select count(*) from health_checks) = 0, 'health checks go with the school');

rollback;
\echo ALL M1 SQL TESTS PASSED
