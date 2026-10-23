-- M0 foundations: role lookup, row-level security with the 2FA requirement,
-- the append-only audit log, last-owner protection, and keep-alive.
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

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000000a', 'owner@example.com'),
  ('00000000-0000-0000-0000-00000000000b', 'finance@example.com'),
  ('00000000-0000-0000-0000-00000000000c', 'support@example.com'),
  ('00000000-0000-0000-0000-00000000000d', 'gone@example.com');
insert into dashboard_users (id, email, role, is_active) values
  ('00000000-0000-0000-0000-00000000000a', 'owner@example.com', 'owner', true),
  ('00000000-0000-0000-0000-00000000000b', 'finance@example.com', 'finance', true),
  ('00000000-0000-0000-0000-00000000000c', 'support@example.com', 'support', true),
  ('00000000-0000-0000-0000-00000000000d', 'gone@example.com', 'support', false);
insert into schools (slug, name) values ('greenfield', 'Greenfield School');
insert into audit_log (action, actor_id, role) values ('test.seed', '00000000-0000-0000-0000-00000000000a', 'owner');

-- ---- dashboard_role(): needs an active user AND a 2FA session ----------------
select set_config('test.uid', '00000000-0000-0000-0000-00000000000a', true);
select set_config('test.jwt', '{"aal":"aal1"}', true);
select pg_temp.assert(dashboard_role() is null, 'password-only session has no role');
select set_config('test.jwt', '{}', true);
select pg_temp.assert(dashboard_role() is null, 'session with no aal claim has no role');
select set_config('test.jwt', '{"aal":"aal2"}', true);
select pg_temp.assert(dashboard_role() = 'owner', 'owner with 2FA has the owner role');
select set_config('test.uid', '00000000-0000-0000-0000-00000000000d', true);
select pg_temp.assert(dashboard_role() is null, 'deactivated user has no role');
select set_config('test.uid', '00000000-0000-0000-0000-0000000000ff', true);
select pg_temp.assert(dashboard_role() is null, 'a user who is not a dashboard user has no role');

-- ---- row-level security --------------------------------------------------------
-- A password-only owner sees nothing.
select set_config('test.uid', '00000000-0000-0000-0000-00000000000a', true);
select set_config('test.jwt', '{"aal":"aal1"}', true);
set local role authenticated;
select pg_temp.assert((select count(*) from schools) = 0, 'aal1 owner cannot read schools');
select pg_temp.assert((select count(*) from dashboard_users) = 0, 'aal1 owner cannot read users');
select pg_temp.assert((select count(*) from audit_log) = 0, 'aal1 owner cannot read the audit log');
reset role;

-- An owner with 2FA reads everything.
select set_config('test.jwt', '{"aal":"aal2"}', true);
set local role authenticated;
select pg_temp.assert((select count(*) from schools) = 1, 'owner reads schools');
select pg_temp.assert((select count(*) from dashboard_users) = 4, 'owner reads all users');
select pg_temp.assert((select count(*) from audit_log) >= 1, 'owner reads the audit log');
reset role;

-- Finance reads schools and only their own user row; not the audit log.
select set_config('test.uid', '00000000-0000-0000-0000-00000000000b', true);
set local role authenticated;
select pg_temp.assert((select count(*) from schools) = 1, 'finance reads schools');
select pg_temp.assert((select count(*) from dashboard_users) = 1, 'finance sees only their own user row');
select pg_temp.assert((select count(*) from audit_log) = 0, 'finance cannot read the audit log');
reset role;

-- Support likewise.
select set_config('test.uid', '00000000-0000-0000-0000-00000000000c', true);
set local role authenticated;
select pg_temp.assert((select count(*) from schools) = 1, 'support reads schools');
select pg_temp.assert((select count(*) from audit_log) = 0, 'support cannot read the audit log');
reset role;

-- Signed-in sessions cannot write anything, whatever their role.
select set_config('test.uid', '00000000-0000-0000-0000-00000000000a', true);
set local role authenticated;
select pg_temp.assert(pg_temp.fails($q$ insert into schools (slug, name) values ('x', 'X') $q$), 'owner session cannot insert a school');
select pg_temp.assert(pg_temp.fails($q$ update dashboard_users set role = 'owner' $q$), 'a session cannot change roles');
select pg_temp.assert(pg_temp.fails($q$ insert into audit_log (action) values ('forged') $q$), 'a session cannot write the audit log');
reset role;

-- Anonymous visitors see nothing at all.
set local role anon;
select pg_temp.assert(pg_temp.fails($q$ select * from schools $q$), 'anon cannot read schools');
select pg_temp.assert(pg_temp.fails($q$ select * from dashboard_users $q$), 'anon cannot read users');
select pg_temp.assert(pg_temp.fails($q$ select * from audit_log $q$), 'anon cannot read the audit log');
reset role;

-- ---- audit log is append-only ----------------------------------------------
set local role service_role;
insert into audit_log (action, actor_id, role) values ('test.append', '00000000-0000-0000-0000-00000000000a', 'owner');
select pg_temp.assert(pg_temp.fails($q$ update audit_log set action = 'edited' $q$), 'service role cannot update the audit log');
select pg_temp.assert(pg_temp.fails($q$ delete from audit_log $q$), 'service role cannot delete from the audit log');
select pg_temp.assert(pg_temp.fails($q$ truncate audit_log $q$), 'service role cannot truncate the audit log');
reset role;
-- Even the table owner is stopped, by the trigger.
select pg_temp.assert(pg_temp.fails($q$ update audit_log set action = 'edited' $q$), 'owner of the table cannot update the audit log');
select pg_temp.assert(pg_temp.fails($q$ delete from audit_log $q$), 'owner of the table cannot delete from the audit log');
select pg_temp.assert(pg_temp.fails($q$ truncate audit_log $q$), 'owner of the table cannot truncate the audit log');
select pg_temp.assert((select count(*) from audit_log where action = 'test.append') = 1, 'appended row is still there');

-- ---- there is always an active owner ---------------------------------------
select pg_temp.assert(pg_temp.fails($q$ update dashboard_users set role = 'finance' where id = '00000000-0000-0000-0000-00000000000a' $q$), 'cannot demote the only owner');
select pg_temp.assert(pg_temp.fails($q$ update dashboard_users set is_active = false where id = '00000000-0000-0000-0000-00000000000a' $q$), 'cannot deactivate the only owner');
select pg_temp.assert(pg_temp.fails($q$ delete from dashboard_users where id = '00000000-0000-0000-0000-00000000000a' $q$), 'cannot delete the only owner');
select pg_temp.assert(pg_temp.fails($q$ delete from auth.users where id = '00000000-0000-0000-0000-00000000000a' $q$), 'cannot delete the only owner by deleting their login');
-- With a second owner the first can be demoted, and then the second is the last.
update dashboard_users set role = 'owner' where id = '00000000-0000-0000-0000-00000000000b';
update dashboard_users set role = 'finance' where id = '00000000-0000-0000-0000-00000000000a';
select pg_temp.assert((select role from dashboard_users where id = '00000000-0000-0000-0000-00000000000a') = 'finance', 'first owner demoted once there is a second');
select pg_temp.assert(pg_temp.fails($q$ update dashboard_users set is_active = false where id = '00000000-0000-0000-0000-00000000000b' $q$), 'the remaining owner is now protected');
-- Changing something else about the only owner is fine.
update dashboard_users set email = 'owner2@example.com' where id = '00000000-0000-0000-0000-00000000000b';

-- ---- schools rules ----------------------------------------------------------
select pg_temp.assert(pg_temp.fails($q$ insert into schools (slug, name) values ('Bad Slug', 'X') $q$), 'slug must be lowercase letters, digits, hyphens');
select pg_temp.assert(pg_temp.fails($q$ insert into schools (slug, name) values ('greenfield', 'Dup') $q$), 'slug is unique');
select pg_temp.assert(pg_temp.fails($q$ insert into schools (slug, name, status) values ('s2', 'S2', 'weird') $q$), 'status is restricted');
select pg_temp.assert((select hosting_plan from schools where slug = 'greenfield') = 'free', 'new schools default to the free hosting plan');

-- ---- keep-alive -------------------------------------------------------------
set local role anon;
select pg_temp.assert(keepalive() is not null, 'anon can call keepalive');
reset role;

rollback;
\echo ALL FOUNDATIONS SQL TESTS PASSED
