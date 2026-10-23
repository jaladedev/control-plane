-- M2: push tracking columns.
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
insert into schools (slug, name) values ('greenfield', 'Greenfield');

select pg_temp.assert((select license_pushed_version from schools where slug = 'greenfield') = 0, 'pushed version starts at 0');
select pg_temp.assert(pg_temp.fails($q$update schools set license_pushed_version = 1 where slug = 'greenfield'$q$), 'cannot be pushed ahead of the saved version');
select pg_temp.assert(not pg_temp.fails($q$update schools set license_version = 2, license_pushed_version = 2 where slug = 'greenfield'$q$), 'pushed may equal the saved version');
select pg_temp.assert(pg_temp.fails($q$update schools set license_version = 1 where slug = 'greenfield'$q$), 'saved version cannot drop below pushed');

rollback;
\echo ALL M2 SQL TESTS PASSED
