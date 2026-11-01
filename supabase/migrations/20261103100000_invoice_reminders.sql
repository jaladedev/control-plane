-- Invoice reminders (plan M3). An invoice that is still open as the school's
-- licence runs out gets an email to the school's billing contact, once per stage,
-- and you are told on Telegram. The worker sends them; the database decides who
-- is due, so the rules hold whatever calls it.
--
-- Stages, by the school's CURRENT licence (not the invoice's new period):
--   before_14  the licence ends within 14 days
--   before_3   within 3 days
--   grace      it has ended and the school is in its grace period
--   lapsed     grace has ended too (the school is read-only)
-- Only the most urgent stage reached is ever sent, and each stage at most once per
-- invoice, so an invoice raised late does not trigger a burst of old reminders.
--
-- Runs after 20261101100000_m6_reconfigure_and_drills.sql.

alter table jobs drop constraint jobs_type_check;
alter table jobs add constraint jobs_type_check
  check (type in ('rollout_step', 'schema_scan', 'school_rollback', 'register_release',
                  'license_push', 'telegram_notify', 'provision_school', 'reconfigure_school',
                  'invoice_reminder'));

-- What was sent, for which invoice and stage. sent_to is null when the school has no
-- billing contact email: the owner was told instead, once, and the stage counts as done.
create table invoice_reminders (
  subscription_id uuid not null references subscriptions (id) on delete restrict,
  kind text not null check (kind in ('before_14', 'before_3', 'grace', 'lapsed')),
  sent_at timestamptz not null default now(),
  sent_to text,
  primary key (subscription_id, kind)
);
create trigger invoice_reminders_append_only before update or delete on invoice_reminders
  for each row execute function refuse_billing_history_change();

alter table invoice_reminders enable row level security;
create policy invoice_reminders_select_any_role on invoice_reminders
  for select to authenticated
  using (dashboard_role() is not null);
revoke all on invoice_reminders from public, anon, authenticated;
grant select on invoice_reminders to authenticated;

-- The stage a licence is in, or null when no reminder is due yet (or it has no dates).
create or replace function invoice_reminder_kind(
  p_valid timestamptz, p_grace timestamptz, p_now timestamptz default now()
)
returns text
language sql
immutable
set search_path to 'public'
as $$
  select case
    when p_valid is null or p_grace is null then null
    when p_now > p_grace then 'lapsed'
    when p_now > p_valid then 'grace'
    when p_now > p_valid - interval '3 days' then 'before_3'
    when p_now > p_valid - interval '14 days' then 'before_14'
    else null
  end;
$$;

-- Queues a reminder for every open invoice whose school has reached a new stage.
-- Only 'pending' invoices: one with a claim waiting ('pending_confirmation') means the
-- school has already paid. Only active schools: a suspended school cannot use the
-- renewal screen the reminder points to. A stage that failed is tried again after a
-- day, not on every scan, and never while one is queued or running.
create or replace function enqueue_invoice_reminders()
returns integer
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  n integer;
begin
  with due as (
    select s.id as sub, s.school_id,
           invoice_reminder_kind(sc.license_valid_until, sc.license_grace_until) as kind
      from subscriptions s
      join schools sc on sc.id = s.school_id
     where s.status = 'pending' and sc.status = 'active'
  ), todo as (
    select d.sub, d.school_id, d.kind from due d
     where d.kind is not null
       and not exists (select 1 from invoice_reminders r where r.subscription_id = d.sub and r.kind = d.kind)
       and not exists (select 1 from jobs j
                        where j.type = 'invoice_reminder'
                          and j.payload ->> 'subscription_id' = d.sub::text
                          and j.payload ->> 'kind' = d.kind
                          and (j.status in ('queued', 'running') or j.created_at > now() - interval '24 hours'))
  ), ins as (
    insert into jobs (type, school_id, payload)
    select 'invoice_reminder', school_id,
           jsonb_build_object('subscription_id', sub, 'kind', kind)
      from todo
    returning 1)
  select count(*) into n from ins;
  return n;
end;
$$;

-- Everything one reminder needs, in one flat row, including what has already gone out
-- and the stage the school is in right now (so a stale job can be skipped).
create or replace function invoice_for_reminder(p_sub uuid)
returns table (
  id uuid, status text, reference text, session text, amount_kobo bigint,
  school_name text, school_slug text, school_status text,
  billing_contact_name text, billing_contact_email text, hostname text,
  license_valid_until timestamptz, license_grace_until timestamptz,
  current_kind text, sent_kinds text[]
)
language sql
stable
security definer
set search_path to 'public'
as $$
  select s.id, s.status, s.reference, s.session, s.amount_kobo,
         sc.name, sc.slug, sc.status,
         sc.billing_contact_name, sc.billing_contact_email, sc.hostnames[1],
         sc.license_valid_until, sc.license_grace_until,
         invoice_reminder_kind(sc.license_valid_until, sc.license_grace_until),
         coalesce((select array_agg(r.kind) from invoice_reminders r where r.subscription_id = s.id), '{}')
    from subscriptions s
    join schools sc on sc.id = s.school_id
   where s.id = p_sub;
$$;

create or replace function mark_invoice_reminded(p_sub uuid, p_kind text, p_to text)
returns boolean
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  n integer;
begin
  if p_kind not in ('before_14', 'before_3', 'grace', 'lapsed') then
    raise exception 'Unknown reminder stage.';
  end if;
  insert into invoice_reminders (subscription_id, kind, sent_to)
  values (p_sub, p_kind, left(p_to, 200))
  on conflict do nothing;
  get diagnostics n = row_count;
  return n > 0;
end;
$$;

do $$
declare
  f text;
begin
  foreach f in array array[
    'invoice_reminder_kind(timestamptz, timestamptz, timestamptz)',
    'enqueue_invoice_reminders()', 'invoice_for_reminder(uuid)',
    'mark_invoice_reminded(uuid, text, text)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;
