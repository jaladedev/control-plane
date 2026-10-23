-- Control plane foundations (M0): dashboard users and roles, the append-only
-- audit log, the schools registry, and a keep-alive function.
--
-- Who can do what is decided in two places that must agree:
--   * here, with row-level security that requires an active dashboard user
--     AND a session that passed 2FA (JWT aal = 'aal2');
--   * in the app (lib/auth/guards.ts) for every write, which all go through
--     the service role and write an audit row first.
-- Browser sessions get no write access to any table.

-- ----------------------------------------------------------------------------
-- 1. Dashboard users. One row per person allowed to log in. The role is set
--    only by an owner, through the app; it is never taken from the JWT.
-- ----------------------------------------------------------------------------
create table dashboard_users (
  id uuid primary key references auth.users (id) on delete cascade,
  email text not null unique,
  role text not null check (role in ('owner', 'finance', 'support')),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid references dashboard_users (id) on delete set null
);
alter table dashboard_users enable row level security;

-- The caller's role, or null when they are not an active dashboard user or
-- their session has not passed 2FA. Every policy below goes through this, so
-- a password-only session sees nothing.
create or replace function dashboard_role()
returns text
language sql
stable
security definer
set search_path to 'public'
as $$
  select u.role
  from dashboard_users u
  where u.id = auth.uid()
    and u.is_active
    and coalesce(auth.jwt() ->> 'aal', '') = 'aal2';
$$;

revoke all on function dashboard_role() from public;
grant execute on function dashboard_role() to authenticated, service_role;

-- Never leave the dashboard without an active owner (deactivating, demoting
-- or deleting the last one is refused, even by the service role).
create or replace function keep_one_active_owner()
returns trigger
language plpgsql
as $$
begin
  if old.role = 'owner' and old.is_active
     and (tg_op = 'DELETE' or new.role <> 'owner' or not new.is_active)
     and not exists (
       select 1 from dashboard_users o
       where o.role = 'owner' and o.is_active and o.id <> old.id
     )
  then
    raise exception 'There must always be at least one active owner';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

create trigger dashboard_users_keep_one_owner
before update or delete on dashboard_users
for each row execute function keep_one_active_owner();

create policy dashboard_users_select_owner on dashboard_users
  for select to authenticated
  using (dashboard_role() = 'owner');

create policy dashboard_users_select_self on dashboard_users
  for select to authenticated
  using (id = auth.uid() and dashboard_role() is not null);

-- ----------------------------------------------------------------------------
-- 2. Audit log. Append-only: rows are only ever inserted, by the service role.
--    Update, delete and truncate are revoked from every role, and a trigger
--    refuses them even for the table owner.
-- ----------------------------------------------------------------------------
create table audit_log (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  actor_id uuid,
  actor_email text,
  role text,
  action text not null,
  school_id uuid,
  details jsonb not null default '{}'::jsonb,
  ip text
);
create index audit_log_at_idx on audit_log (at desc);
create index audit_log_school_idx on audit_log (school_id, at desc);
create index audit_log_actor_idx on audit_log (actor_id, at desc);
create index audit_log_action_idx on audit_log (action);

alter table audit_log enable row level security;

create or replace function refuse_audit_change()
returns trigger
language plpgsql
as $$
begin
  raise exception 'audit_log is append-only';
end;
$$;

create trigger audit_log_no_update_delete
before update or delete on audit_log
for each row execute function refuse_audit_change();

create trigger audit_log_no_truncate
before truncate on audit_log
for each statement execute function refuse_audit_change();

create policy audit_log_select_owner on audit_log
  for select to authenticated
  using (dashboard_role() = 'owner');

-- ----------------------------------------------------------------------------
-- 3. Schools registry. No secrets here, ever: connection strings and keys live
--    in the secrets manager. credentials_status is a status only.
-- ----------------------------------------------------------------------------
create table schools (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]*$'),
  name text not null,
  hostnames text[] not null default '{}',
  included_students integer not null default 0 check (included_students >= 0),
  status text not null default 'provisioning'
    check (status in ('provisioning', 'active', 'suspended', 'archived')),
  billing_contact_name text,
  billing_contact_email text,
  supabase_account_email text,
  supabase_project_ref text,
  cloudflare_account_email text,
  r2_bucket text,
  container_name text,
  app_version text,
  image_tag text,
  region text,
  schema_version text,
  credentials_status text not null default 'ok'
    check (credentials_status in ('ok', 'auth_failed', 'paused', 'unreachable')),
  hosting_plan text not null default 'free' check (hosting_plan in ('free', 'pro')),
  features text[] not null default '{}',
  created_at timestamptz not null default now()
);
alter table schools enable row level security;

create policy schools_select_any_role on schools
  for select to authenticated
  using (dashboard_role() is not null);

-- ----------------------------------------------------------------------------
-- 4. Table privileges. Signed-in sessions can only read; the app writes with
--    the service role. The audit log cannot be changed by anyone.
-- ----------------------------------------------------------------------------
revoke all on dashboard_users, audit_log, schools from public, anon, authenticated;
grant select on dashboard_users, audit_log, schools to authenticated;

revoke update, delete, truncate on audit_log from service_role;

-- ----------------------------------------------------------------------------
-- 5. Keep-alive. Supabase's Free plan pauses a project after a week without
--    activity. A scheduled request to this function (see
--    .github/workflows/keepalive.yml) counts as activity. It returns the time
--    and reads nothing.
-- ----------------------------------------------------------------------------
create or replace function keepalive()
returns timestamptz
language sql
stable
security definer
set search_path to 'public'
as $$
  select now();
$$;

revoke all on function keepalive() from public;
grant execute on function keepalive() to anon, authenticated;
