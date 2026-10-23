-- M1: schools registry. Adds the licence mirror and health columns to
-- schools, and a health_checks history. Still aggregates only: nothing here is
-- a secret or a student record. The licence columns are what the control plane
-- WANTS the school to have (M2 pushes them with set_license); health_* is what
-- the last probe saw.

alter table schools
  add column license_version bigint not null default 0 check (license_version >= 0),
  add column license_session text,
  add column license_is_trial boolean not null default false,
  add column license_valid_until timestamptz,
  add column license_grace_until timestamptz,
  add column health_status text not null default 'unknown'
    check (health_status in ('unknown', 'up', 'degraded', 'down')),
  add column last_checked_at timestamptz,
  add column last_ok_at timestamptz,
  add column consecutive_failures integer not null default 0 check (consecutive_failures >= 0),
  add column last_latency_ms integer,
  add column last_error text,
  add constraint schools_license_dates check (
    (license_valid_until is null) = (license_grace_until is null)
    and (license_grace_until is null or license_grace_until >= license_valid_until)
  );

-- Hostnames are fetched by the health cron, so they are held to a strict
-- shape: lowercase DNS names with at least one dot, no ports, paths or IPs.
alter table schools
  add constraint schools_hostnames_shape check (
    array_to_string(hostnames, ',') ~ '^[a-z0-9.,-]*$'
  );

create table health_checks (
  id bigint generated always as identity primary key,
  school_id uuid not null references schools (id) on delete cascade,
  at timestamptz not null default now(),
  ok boolean not null,
  http_status integer,
  latency_ms integer,
  version text,
  error text
);
create index health_checks_school_at_idx on health_checks (school_id, at desc);
create index health_checks_at_idx on health_checks (at);
alter table health_checks enable row level security;

create policy health_checks_select_any_role on health_checks
  for select to authenticated
  using (dashboard_role() is not null);

revoke all on health_checks from public, anon, authenticated;
grant select on health_checks to authenticated;

-- Old probes are noise. The cron calls this after each run.
create or replace function prune_health_checks(p_keep_days integer default 30)
returns integer
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  n integer;
begin
  delete from public.health_checks where at < now() - make_interval(days => p_keep_days);
  get diagnostics n = row_count;
  return n;
end;
$$;
revoke all on function prune_health_checks(integer) from public, anon, authenticated;
grant execute on function prune_health_checks(integer) to service_role;
