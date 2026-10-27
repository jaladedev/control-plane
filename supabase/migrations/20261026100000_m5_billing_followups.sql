-- M5 billing follow-ups: rate limiting for the claim endpoint, automatic
-- suspension of long-lapsed schools, mid-session top-ups, and refunds.
--
-- Same rules as M2b: money is whole kobo, every function that changes state is
-- callable by the service role only, the dashboard writes its audit row before it
-- calls one, and every refusal is worded for the person who will read it.

-- ---------------------------------------------------------------------------
-- Rate limiting (fixed windows, shared by every instance of the web app)
-- ---------------------------------------------------------------------------

create table rate_limit_hits (
  bucket text not null check (length(bucket) between 1 and 200),
  window_start timestamptz not null,
  hits integer not null default 0 check (hits >= 0),
  primary key (bucket, window_start)
);
alter table rate_limit_hits enable row level security;
revoke all on rate_limit_hits from public, anon, authenticated;

-- Counts one hit and says whether it is still within the limit. Old windows are
-- swept now and then so the table stays small.
create or replace function rate_limit_hit(p_bucket text, p_window_seconds integer, p_max integer)
returns boolean
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_start timestamptz;
  v_hits integer;
begin
  if p_window_seconds < 1 or p_window_seconds > 86400 or p_max < 1 then
    raise exception 'The rate limit settings are not valid.';
  end if;
  v_start := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);
  insert into rate_limit_hits (bucket, window_start, hits)
  values (p_bucket, v_start, 1)
  on conflict (bucket, window_start) do update set hits = rate_limit_hits.hits + 1
  returning hits into v_hits;
  if random() < 0.02 then
    delete from rate_limit_hits where window_start < now() - interval '1 day';
  end if;
  return v_hits <= p_max;
end;
$$;

-- ---------------------------------------------------------------------------
-- Automatic suspension and resumption
-- ---------------------------------------------------------------------------

-- Who suspended a school. Only a suspension made by the lapse rule is ever lifted
-- by a payment; a suspension an owner made by hand stays until an owner lifts it.
alter table schools
  add column suspended_reason text check (suspended_reason in ('lapsed')),
  add column suspended_at timestamptz;

-- Suspends active schools whose licence ended (grace included) more than
-- p_after_days days ago, unless the school has money in flight: an open invoice
-- or a claim waiting means it is paying, so it is left alone. Returns what it did.
create or replace function suspend_lapsed_schools(p_after_days integer)
returns table (school_id uuid, slug text, grace_until timestamptz)
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  r record;
begin
  if p_after_days < 7 or p_after_days > 365 then
    raise exception 'Suspend after between 7 and 365 days.';
  end if;
  for r in
    select s.id, s.slug, s.license_grace_until
      from schools s
     where s.status = 'active'
       and s.license_grace_until is not null
       and s.license_grace_until < now() - make_interval(days => p_after_days)
       and not exists (select 1 from subscriptions b
                        where b.school_id = s.id
                          and b.status in ('pending', 'pending_confirmation'))
     order by s.slug
       for update of s skip locked
  loop
    update schools set status = 'suspended', suspended_reason = 'lapsed', suspended_at = now()
     where id = r.id;
    insert into audit_log (actor_email, role, action, school_id, details)
    values ('system:auto-suspend', 'system', 'school.auto_suspend', r.id,
            jsonb_build_object('slug', r.slug, 'grace_until', r.license_grace_until,
                               'after_days', p_after_days));
    school_id := r.id;
    slug := r.slug;
    grace_until := r.license_grace_until;
    return next;
  end loop;
end;
$$;

-- A payment that follows an automatic suspension lifts it. Replaces the M2b
-- function with one extra step; everything else is unchanged.
create or replace function apply_subscription_license(p_sub uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  s subscriptions;
  v_resumed boolean;
begin
  select * into s from subscriptions where id = p_sub;
  update schools
     set license_version = license_version + 1,
         license_session = s.session,
         license_is_trial = false,
         license_valid_until = s.valid_until,
         license_grace_until = s.grace_until,
         included_students = s.included_students + s.extra_students,
         features = coalesce(
           (select array_agg(feature order by feature) from subscription_items
             where subscription_id = p_sub and removed_at is null), '{}'::text[])
   where id = s.school_id;
  update schools set status = 'active', suspended_reason = null, suspended_at = null
   where id = s.school_id and status = 'suspended' and suspended_reason = 'lapsed';
  v_resumed := found;
  if v_resumed then
    insert into audit_log (actor_email, role, action, school_id, details)
    values ('system:auto-resume', 'system', 'school.auto_resume', s.school_id,
            jsonb_build_object('subscription_id', p_sub, 'reference', s.reference));
  end if;
  insert into jobs (type, school_id, payload)
  values ('license_push', s.school_id, jsonb_build_object('subscription_id', p_sub));
end;
$$;

-- ---------------------------------------------------------------------------
-- Top-ups: extra students added to a paid session
-- ---------------------------------------------------------------------------

create table subscription_topups (
  id uuid primary key default gen_random_uuid(),
  subscription_id uuid not null references subscriptions (id) on delete restrict,
  school_id uuid not null references schools (id) on delete restrict,
  -- What the payer writes on the transfer.
  reference text not null unique check (reference ~ '^TOP-[0-9A-F]{8}$'),
  extra_students integer not null check (extra_students between 1 and 100000),
  amount_kobo bigint not null check (amount_kobo >= 0),
  -- The price line exactly as it was shown, with any override.
  line jsonb not null,
  status text not null default 'pending'
    check (status in ('pending', 'paid', 'cancelled', 'refunded')),
  payment_ref text,
  paid_at timestamptz,
  paid_by text,
  decision_reason text,
  created_by text not null,
  created_at timestamptz not null default now(),
  constraint topups_paid_is_complete check (
    status not in ('paid', 'refunded') or (paid_at is not null and paid_by is not null))
);
create unique index subscription_topups_one_open on subscription_topups (subscription_id)
  where status = 'pending';
create index subscription_topups_school_idx on subscription_topups (school_id, created_at desc);

alter table subscription_topups enable row level security;
create policy subscription_topups_select_billing on subscription_topups
  for select to authenticated using (dashboard_role() in ('owner', 'finance'));
revoke all on subscription_topups from public, anon, authenticated;
grant select on subscription_topups to authenticated;

-- Invoices a top-up for a PAID invoice. The amount must equal quantity times the
-- unit price on the line the dashboard showed.
create or replace function create_topup(
  p_sub uuid, p_extra integer, p_amount bigint, p_line jsonb, p_by text
)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  s subscriptions;
  v_status text;
  v_id uuid;
  v_ref text;
  tries integer := 0;
begin
  select * into s from subscriptions where id = p_sub for update;
  if s.id is null then
    raise exception 'That invoice does not exist.';
  end if;
  if s.status <> 'paid' then
    raise exception 'A top-up needs a paid invoice; this one is %.', s.status;
  end if;
  select status into v_status from schools where id = s.school_id;
  if v_status <> 'active' then
    raise exception 'Only an active school can be invoiced.';
  end if;
  if s.grace_until <= now() then
    raise exception 'This session has ended. Invoice the next session instead.';
  end if;
  if p_extra < 1 or p_extra > 100000 then
    raise exception 'Extra students must be a whole number from 1 to 100,000.';
  end if;
  if p_amount <> p_extra * coalesce((p_line ->> 'unit_kobo')::bigint, -1) then
    raise exception 'The top-up total (%) does not match its price line.', p_amount;
  end if;
  if exists (select 1 from subscription_topups where subscription_id = p_sub and status = 'pending') then
    raise exception 'This invoice already has a top-up waiting for payment. Cancel it first.';
  end if;

  loop
    v_ref := 'TOP-' || upper(substr(md5(random()::text || clock_timestamp()::text), 1, 8));
    exit when not exists (select 1 from subscription_topups where reference = v_ref);
    tries := tries + 1;
    if tries > 10 then raise exception 'Could not make a unique top-up reference.'; end if;
  end loop;

  insert into subscription_topups (subscription_id, school_id, reference, extra_students,
                                   amount_kobo, line, created_by)
  values (p_sub, s.school_id, v_ref, p_extra, p_amount, p_line, p_by)
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function cancel_topup(p_topup uuid, p_by text, p_reason text)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if p_reason is null or length(btrim(p_reason)) = 0 then
    raise exception 'A reason is required.';
  end if;
  update subscription_topups set status = 'cancelled', decision_reason = p_reason
   where id = p_topup and status = 'pending';
  if not found then
    raise exception 'Only a top-up that is waiting for payment can be cancelled.';
  end if;
end;
$$;

-- The money was seen in the bank. The school's allowance goes up and a higher
-- licence version is pushed. The amount received must equal the top-up.
create or replace function mark_topup_paid(
  p_topup uuid, p_amount_kobo bigint, p_ref text, p_by text, p_reason text
)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  t subscription_topups;
  s subscriptions;
begin
  if p_reason is null or length(btrim(p_reason)) = 0 then
    raise exception 'A reason is required (for example, the bank statement line you checked).';
  end if;
  select * into t from subscription_topups where id = p_topup for update;
  if t.id is null or t.status <> 'pending' then
    raise exception 'Only a top-up that is waiting for payment can be marked paid.';
  end if;
  if p_amount_kobo <> t.amount_kobo then
    raise exception 'The amount received (% kobo) does not match the top-up (% kobo).',
      p_amount_kobo, t.amount_kobo;
  end if;
  select * into s from subscriptions where id = t.subscription_id for update;
  if s.status <> 'paid' then
    raise exception 'The invoice is %, so this top-up cannot be paid.', s.status;
  end if;
  update subscription_topups
     set status = 'paid', paid_at = now(), paid_by = p_by, decision_reason = p_reason,
         payment_ref = coalesce(nullif(btrim(p_ref), ''), t.reference)
   where id = p_topup;
  update subscriptions
     set extra_students = extra_students + t.extra_students,
         topup_kobo = topup_kobo + t.amount_kobo
   where id = s.id;
  perform apply_subscription_license(s.id);
end;
$$;

-- ---------------------------------------------------------------------------
-- Refunds
-- ---------------------------------------------------------------------------

-- A refund is a record that the money went back (done in the bank, not here) and
-- an immediate end to the licence. Whole invoices only, inside the refund window.
alter table subscriptions
  add column refunded_at timestamptz,
  add column refunded_by text,
  add column refund_reason text,
  add column refund_kobo bigint check (refund_kobo is null or refund_kobo >= 0),
  add constraint subscriptions_refund_is_complete check (
    status <> 'refunded' or (refunded_at is not null and refunded_by is not null
                             and refund_reason is not null and refund_kobo is not null));

create or replace function refund_subscription(
  p_sub uuid, p_by text, p_reason text, p_window_days integer default 14
)
returns bigint
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  s subscriptions;
  sc schools;
  v_total bigint;
begin
  if p_reason is null or length(btrim(p_reason)) = 0 then
    raise exception 'A reason is required.';
  end if;
  if p_window_days < 0 or p_window_days > 365 then
    raise exception 'The refund window is not valid.';
  end if;
  select * into s from subscriptions where id = p_sub for update;
  if s.id is null then
    raise exception 'That invoice does not exist.';
  end if;
  if s.status <> 'paid' then
    raise exception 'Only a paid invoice can be refunded; this one is %.', s.status;
  end if;
  if now() > s.paid_at + make_interval(days => p_window_days) then
    raise exception 'This invoice was paid more than % days ago, so it is outside the refund window.',
      p_window_days;
  end if;
  if exists (select 1 from subscription_topups where subscription_id = p_sub and status = 'pending') then
    raise exception 'A top-up is waiting for payment on this invoice. Cancel it first.';
  end if;

  v_total := s.amount_kobo + s.topup_kobo;
  update subscription_topups set status = 'refunded' where subscription_id = p_sub and status = 'paid';
  update subscriptions
     set status = 'refunded', refunded_at = now(), refunded_by = p_by,
         refund_reason = p_reason, refund_kobo = v_total
   where id = p_sub;

  -- End the licence now, but only if this invoice is the one the school is
  -- running on. Refunding an old session must not switch off a newer one.
  select * into sc from schools where id = s.school_id for update;
  if sc.license_session = s.session then
    update schools
       set license_version = license_version + 1,
           license_valid_until = now(), license_grace_until = now()
     where id = s.school_id;
    insert into jobs (type, school_id, payload)
    values ('license_push', s.school_id,
            jsonb_build_object('subscription_id', p_sub, 'refund', true));
  end if;
  return v_total;
end;
$$;

-- ---------------------------------------------------------------------------
-- Access
-- ---------------------------------------------------------------------------

do $$
declare
  f text;
begin
  foreach f in array array[
    'rate_limit_hit(text, integer, integer)', 'suspend_lapsed_schools(integer)',
    'apply_subscription_license(uuid)',
    'create_topup(uuid, integer, bigint, jsonb, text)', 'cancel_topup(uuid, text, text)',
    'mark_topup_paid(uuid, bigint, text, text, text)',
    'refund_subscription(uuid, text, text, integer)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;
