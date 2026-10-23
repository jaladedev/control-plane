-- Minimal stand-ins for the Supabase platform objects the migrations expect
-- (roles, auth schema, auth.uid() and auth.jwt()), so the migrations can be
-- replayed on plain Postgres. Used by tests/sql/run.sh. Not for a real project.
-- Tests set test.uid and test.jwt to act as a signed-in user.

drop schema if exists public cascade; create schema public;
drop schema if exists auth cascade; create schema auth;
do $$ begin create role anon nologin; exception when duplicate_object then null; end $$;
do $$ begin create role authenticated nologin; exception when duplicate_object then null; end $$;
do $$ begin create role service_role nologin bypassrls; exception when duplicate_object then null; end $$;
grant usage on schema public, auth to anon, authenticated, service_role;
-- Supabase grants new public tables to anon/authenticated/service_role by
-- default; mirror it so a migration that forgets to revoke is caught.
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('test.uid', true), '')::uuid $$;
create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('test.jwt', true), '')::jsonb, '{}'::jsonb) $$;
create table auth.users (id uuid primary key default gen_random_uuid(), email text);
