-- M2 billing core and M2b transfer claims.
--
-- Money is integer kobo everywhere. The price catalog is append-only: a price
-- change is a new row with an effective date, and a quote copies the prices it
-- used into the invoice, so changing a price never rewrites an existing invoice.
--
-- A claim ("I've sent it") never pays anything by itself. Only confirm_claim,
-- called by an owner or finance user who has checked the bank statement, marks an
-- invoice paid, and that is also what updates the school's licence and queues the
-- push. Every function that changes state is callable by the service role only;
-- the dashboard calls them after writing its audit row.

-- ---------------------------------------------------------------------------
-- Prices
-- ---------------------------------------------------------------------------

create table price_catalog (
  id uuid primary key default gen_random_uuid(),
  item text not null
    check (item in ('base_fee', 'included_students', 'extra_student', 'pro_hosting')
           or item ~ '^feature:[a-z][a-z0-9_]{1,39}$'),
  amount_kobo bigint check (amount_kobo >= 0),
  count integer check (count >= 0),
  effective_from timestamptz not null default now(),
  reason text not null check (length(btrim(reason)) > 0),
  set_by text not null,
  created_at timestamptz not null default now(),
  -- included_students is a count; every other item is an amount.
  constraint price_catalog_one_value check (
    (item = 'included_students' and count is not null and amount_kobo is null)
    or (item <> 'included_students' and amount_kobo is not null and count is null))
);
create index price_catalog_item_idx on price_catalog (item, effective_from desc, created_at desc);

create table school_price_overrides (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references schools (id) on delete cascade,
  item text not null
    check (item in ('base_fee', 'extra_student', 'pro_hosting')
           or item ~ '^feature:[a-z][a-z0-9_]{1,39}$'),
  session text not null check (length(btrim(session)) between 1 and 40),
  amount_kobo bigint check (amount_kobo >= 0),
  percent_off integer check (percent_off between 1 and 100),
  reason text not null check (length(btrim(reason)) > 0),
  set_by text not null,
  created_at timestamptz not null default now(),
  constraint override_one_value check ((amount_kobo is null) <> (percent_off is null))
);
create index school_price_overrides_idx on school_price_overrides (school_id, session, item, created_at desc);

create or replace function refuse_billing_history_change()
returns trigger
language plpgsql
set search_path to 'public'
as $$
begin
  raise exception '% is append-only: add a new row instead of changing or removing one.', tg_table_name;
end;
$$;
create trigger price_catalog_append_only before update or delete on price_catalog
  for each row execute function refuse_billing_history_change();
create trigger school_price_overrides_append_only before update or delete on school_price_overrides
  for each row execute function refuse_billing_history_change();

-- ---------------------------------------------------------------------------
-- Subscriptions (invoices) and their add-on lines
-- ---------------------------------------------------------------------------

create table subscriptions (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references schools (id) on delete restrict,
  session text not null check (length(btrim(session)) between 1 and 40),
  -- What the payer writes on the transfer, so a payment can be matched to this.
  reference text not null unique check (reference ~ '^SUB-[0-9A-F]{8}$'),
  included_students integer not null check (included_students >= 0),
  extra_students integer not null default 0 check (extra_students >= 0),
  amount_kobo bigint not null check (amount_kobo >= 0),
  topup_kobo bigint not null default 0 check (topup_kobo >= 0),
  status text not null default 'pending'
    check (status in ('trial', 'pending', 'pending_confirmation', 'paid', 'refunded', 'cancelled')),
  method text check (method in ('paystack', 'transfer')),
  payment_ref text,
  paid_at timestamptz,
  valid_until timestamptz not null,
  grace_until timestamptz not null,
  -- The quote exactly as it was shown: every line, the price used and any override.
  quote jsonb not null,
  created_by text not null,
  created_at timestamptz not null default now(),
  constraint subscriptions_grace_after_valid check (grace_until >= valid_until),
  constraint subscriptions_paid_is_complete check (
    status <> 'paid' or (method is not null and paid_at is not null))
);
-- One open invoice per school and session, and one paid one.
create unique index subscriptions_one_open on subscriptions (school_id, session)
  where status in ('pending', 'pending_confirmation');
create unique index subscriptions_one_paid on subscriptions (school_id, session)
  where status = 'paid';
create index subscriptions_school_idx on subscriptions (school_id, created_at desc);

create table subscription_items (
  id uuid primary key default gen_random_uuid(),
  subscription_id uuid not null references subscriptions (id) on delete cascade,
  feature text not null check (feature ~ '^[a-z][a-z0-9_]{1,39}$'),
  amount_kobo bigint not null check (amount_kobo >= 0),
  added_at timestamptz not null default now(),
  removed_at timestamptz,
  unique (subscription_id, feature)
);

-- ---------------------------------------------------------------------------
-- Transfer claims
-- ---------------------------------------------------------------------------

create table payment_claims (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references schools (id) on delete restrict,
  subscription_id uuid not null references subscriptions (id) on delete restrict,
  -- The school's own id for this claim: makes a retried request idempotent.
  client_ref text not null check (length(client_ref) between 8 and 80),
  claimed_by text not null check (length(btrim(claimed_by)) between 1 and 120),
  amount_kobo bigint not null check (amount_kobo > 0),
  sent_on date not null,
  sender_name text not null check (length(btrim(sender_name)) between 1 and 120),
  payer_reference text check (payer_reference is null or length(payer_reference) <= 120),
  proof_path text check (proof_path is null or length(proof_path) <= 300),
  status text not null default 'pending' check (status in ('pending', 'confirmed', 'rejected')),
  confirmed_amount_kobo bigint,
  decided_by text,
  decided_at timestamptz,
  decision_reason text,
  notified_at timestamptz,
  reminded_at timestamptz,
  created_at timestamptz not null default now(),
  unique (school_id, client_ref),
  constraint claims_decided_is_complete check (
    status = 'pending' or (decided_by is not null and decided_at is not null
                           and decision_reason is not null))
);
-- One open claim per invoice at a time, to stop duplicates.
create unique index payment_claims_one_pending on payment_claims (subscription_id)
  where status = 'pending';
create index payment_claims_queue_idx on payment_claims (created_at) where status = 'pending';

-- Once decided, a claim is history: only the notification stamps may still change.
create or replace function guard_claim_change()
returns trigger
language plpgsql
set search_path to 'public'
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'payment_claims is append-only: a claim cannot be removed.';
  end if;
  if old.status <> 'pending' then
    if (new.id, new.school_id, new.subscription_id, new.client_ref, new.claimed_by, new.amount_kobo,
        new.sent_on, new.sender_name, new.payer_reference, new.proof_path, new.status,
        new.confirmed_amount_kobo, new.decided_by, new.decided_at, new.decision_reason, new.created_at)
       is distinct from
       (old.id, old.school_id, old.subscription_id, old.client_ref, old.claimed_by, old.amount_kobo,
        old.sent_on, old.sender_name, old.payer_reference, old.proof_path, old.status,
        old.confirmed_amount_kobo, old.decided_by, old.decided_at, old.decision_reason, old.created_at) then
      raise exception 'payment_claims is append-only: a decided claim cannot be changed.';
    end if;
  end if;
  return new;
end;
$$;
create trigger payment_claims_guard before update or delete on payment_claims
  for each row execute function guard_claim_change();

-- ---------------------------------------------------------------------------
-- Schools' public keys for signing claims (Ed25519, raw 32 bytes, base64url)
-- ---------------------------------------------------------------------------

create table school_signing_keys (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references schools (id) on delete cascade,
  public_key text not null check (public_key ~ '^[A-Za-z0-9_-]{43}$'),
  created_by text not null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  unique (school_id, public_key)
);

-- ---------------------------------------------------------------------------
-- Access: billing is for owner and finance; keys for the owner
-- ---------------------------------------------------------------------------

alter table price_catalog enable row level security;
alter table school_price_overrides enable row level security;
alter table subscriptions enable row level security;
alter table subscription_items enable row level security;
alter table payment_claims enable row level security;
alter table school_signing_keys enable row level security;

do $$
declare
  t text;
begin
  foreach t in array array['price_catalog', 'school_price_overrides', 'subscriptions',
                           'subscription_items', 'payment_claims'] loop
    execute format(
      'create policy %I on %I for select to authenticated using (dashboard_role() in (''owner'', ''finance''))',
      t || '_select_billing', t);
    execute format('revoke all on %I from public, anon, authenticated', t);
    execute format('grant select on %I to authenticated', t);
  end loop;
end $$;
create policy school_signing_keys_select_owner on school_signing_keys
  for select to authenticated using (dashboard_role() = 'owner');
revoke all on school_signing_keys from public, anon, authenticated;
grant select on school_signing_keys to authenticated;

-- ---------------------------------------------------------------------------
-- Job types the worker now handles
-- ---------------------------------------------------------------------------

alter table jobs drop constraint jobs_type_check;
alter table jobs add constraint jobs_type_check
  check (type in ('rollout_step', 'schema_scan', 'school_rollback', 'register_release',
                  'license_push', 'telegram_notify'));

-- ---------------------------------------------------------------------------
-- Prices and keys
-- ---------------------------------------------------------------------------

create or replace function set_price(
  p_item text, p_amount_kobo bigint, p_count integer,
  p_effective_from timestamptz, p_reason text, p_by text
)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_id uuid;
begin
  insert into price_catalog (item, amount_kobo, count, effective_from, reason, set_by)
  values (p_item, p_amount_kobo, p_count, coalesce(p_effective_from, now()), p_reason, p_by)
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function set_price_override(
  p_school uuid, p_item text, p_session text,
  p_amount_kobo bigint, p_percent_off integer, p_reason text, p_by text
)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_id uuid;
begin
  if not exists (select 1 from schools where id = p_school) then
    raise exception 'That school does not exist.';
  end if;
  insert into school_price_overrides (school_id, item, session, amount_kobo, percent_off, reason, set_by)
  values (p_school, p_item, p_session, p_amount_kobo, p_percent_off, p_reason, p_by)
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function add_school_signing_key(p_school uuid, p_public_key text, p_by text)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_id uuid;
begin
  if not exists (select 1 from schools where id = p_school) then
    raise exception 'That school does not exist.';
  end if;
  insert into school_signing_keys (school_id, public_key, created_by)
  values (p_school, p_public_key, p_by)
  returning id into v_id;
  return v_id;
exception when unique_violation then
  raise exception 'That key is already registered for this school.';
end;
$$;

create or replace function revoke_school_signing_key(p_key uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  update school_signing_keys set revoked_at = now() where id = p_key and revoked_at is null;
  if not found then
    raise exception 'That key does not exist or is already revoked.';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Invoices
-- ---------------------------------------------------------------------------

-- Turns a quote into an invoice. The amounts are computed by the dashboard and
-- re-checked here: the total must equal the sum of the quote's lines, so a
-- tampered or miscomputed total cannot be stored.
create or replace function create_subscription(
  p_school uuid, p_session text,
  p_included integer, p_extra integer, p_amount bigint,
  p_valid_until timestamptz, p_grace_until timestamptz,
  p_items jsonb, p_quote jsonb, p_by text
)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_id uuid;
  v_ref text;
  v_status text;
  v_lines bigint;
  i jsonb;
  tries integer := 0;
begin
  select status into v_status from schools where id = p_school;
  if v_status is null then
    raise exception 'That school does not exist.';
  end if;
  if v_status <> 'active' then
    raise exception 'Only an active school can be invoiced.';
  end if;
  if p_valid_until <= now() then
    raise exception 'The valid-until date is in the past.';
  end if;
  if exists (select 1 from subscriptions where school_id = p_school and session = p_session
              and status in ('pending', 'pending_confirmation')) then
    raise exception 'This school already has an open invoice for %. Cancel it first.', p_session;
  end if;
  if exists (select 1 from subscriptions where school_id = p_school and session = p_session
              and status = 'paid') then
    raise exception 'This school has already paid for %.', p_session;
  end if;

  select coalesce(sum((l ->> 'total_kobo')::bigint), 0) into v_lines
    from jsonb_array_elements(coalesce(p_quote -> 'lines', '[]'::jsonb)) l;
  if v_lines <> p_amount then
    raise exception 'The invoice total (%) does not match its lines (%).', p_amount, v_lines;
  end if;

  loop
    v_ref := 'SUB-' || upper(substr(md5(random()::text || clock_timestamp()::text), 1, 8));
    exit when not exists (select 1 from subscriptions where reference = v_ref);
    tries := tries + 1;
    if tries > 10 then raise exception 'Could not make a unique invoice reference.'; end if;
  end loop;

  insert into subscriptions (school_id, session, reference, included_students, extra_students,
                             amount_kobo, valid_until, grace_until, quote, created_by)
  values (p_school, p_session, v_ref, p_included, p_extra, p_amount,
          p_valid_until, p_grace_until, p_quote, p_by)
  returning id into v_id;

  for i in select * from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) loop
    insert into subscription_items (subscription_id, feature, amount_kobo)
    values (v_id, i ->> 'feature', (i ->> 'amount_kobo')::bigint);
  end loop;
  return v_id;
end;
$$;

create or replace function cancel_subscription(p_sub uuid, p_by text, p_reason text)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if p_reason is null or length(btrim(p_reason)) = 0 then
    raise exception 'A reason is required.';
  end if;
  update subscriptions set status = 'cancelled' where id = p_sub and status = 'pending';
  if not found then
    raise exception 'Only an invoice that is waiting for payment can be cancelled. If a claim is waiting, reject it first.';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- The licence follows a paid invoice
-- ---------------------------------------------------------------------------

-- Writes what the school SHOULD have onto its registry row (next version) and
-- queues the push. Internal: called by confirm_claim, mark_subscription_paid and
-- extend_subscription. The worker pushes it and records the outcome.
create or replace function apply_subscription_license(p_sub uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  s subscriptions;
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
  insert into jobs (type, school_id, payload)
  values ('license_push', s.school_id, jsonb_build_object('subscription_id', p_sub));
end;
$$;

-- ---------------------------------------------------------------------------
-- Claims
-- ---------------------------------------------------------------------------

-- Called by the signed claim endpoint, after the signature was checked. Safe to
-- repeat: the same client_ref returns the claim it already made.
create or replace function submit_claim(
  p_school uuid, p_reference text, p_client_ref text, p_amount_kobo bigint,
  p_sent_on date, p_sender text, p_payer_reference text, p_proof_path text, p_claimed_by text
)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_existing uuid;
  s subscriptions;
  v_id uuid;
begin
  select id into v_existing from payment_claims where school_id = p_school and client_ref = p_client_ref;
  if v_existing is not null then
    return v_existing;
  end if;

  select * into s from subscriptions where reference = p_reference and school_id = p_school;
  if s.id is null then
    raise exception 'There is no invoice with that reference for this school.';
  end if;
  if s.status = 'paid' then
    raise exception 'That invoice has already been paid.';
  end if;
  if s.status = 'pending_confirmation' then
    raise exception 'A payment claim for that invoice is already waiting to be confirmed.';
  end if;
  if s.status <> 'pending' then
    raise exception 'That invoice is % and cannot be claimed.', s.status;
  end if;
  if p_sent_on > current_date + 1 or p_sent_on < current_date - 90 then
    raise exception 'The date the payment was sent looks wrong.';
  end if;

  insert into payment_claims (school_id, subscription_id, client_ref, claimed_by, amount_kobo,
                              sent_on, sender_name, payer_reference, proof_path)
  values (p_school, s.id, p_client_ref, p_claimed_by, p_amount_kobo,
          p_sent_on, p_sender, p_payer_reference, p_proof_path)
  returning id into v_id;
  update subscriptions set status = 'pending_confirmation' where id = s.id;
  insert into jobs (type, school_id, payload)
  values ('telegram_notify', p_school, jsonb_build_object('kind', 'claim', 'claim_id', v_id));
  return v_id;
end;
$$;

-- Confirm = a person checked the bank statement. The amount received must equal
-- the invoice (partial payments are not supported: reject and re-quote instead).
create or replace function confirm_claim(p_claim uuid, p_amount_kobo bigint, p_by text, p_reason text)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  c payment_claims;
  s subscriptions;
begin
  if p_reason is null or length(btrim(p_reason)) = 0 then
    raise exception 'A reason is required (for example, the bank statement line you checked).';
  end if;
  select * into c from payment_claims where id = p_claim for update;
  if c.id is null or c.status <> 'pending' then
    raise exception 'Only a claim that is waiting for confirmation can be confirmed.';
  end if;
  select * into s from subscriptions where id = c.subscription_id for update;
  if s.status <> 'pending_confirmation' then
    raise exception 'The invoice is %, so this claim cannot be confirmed.', s.status;
  end if;
  if p_amount_kobo <> s.amount_kobo then
    raise exception 'The amount received (% kobo) does not match the invoice (% kobo). Reject the claim and issue a new invoice if the amount is different.',
      p_amount_kobo, s.amount_kobo;
  end if;

  update payment_claims
     set status = 'confirmed', confirmed_amount_kobo = p_amount_kobo,
         decided_by = p_by, decided_at = now(), decision_reason = p_reason
   where id = p_claim;
  update subscriptions
     set status = 'paid', method = 'transfer', payment_ref = coalesce(c.payer_reference, s.reference),
         paid_at = now()
   where id = s.id;
  perform apply_subscription_license(s.id);
end;
$$;

create or replace function reject_claim(p_claim uuid, p_by text, p_reason text)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  c payment_claims;
begin
  if p_reason is null or length(btrim(p_reason)) = 0 then
    raise exception 'A reason is required.';
  end if;
  select * into c from payment_claims where id = p_claim for update;
  if c.id is null or c.status <> 'pending' then
    raise exception 'Only a claim that is waiting for confirmation can be rejected.';
  end if;
  update payment_claims
     set status = 'rejected', decided_by = p_by, decided_at = now(), decision_reason = p_reason
   where id = p_claim;
  update subscriptions set status = 'pending' where id = c.subscription_id and status = 'pending_confirmation';
end;
$$;

-- A payment seen in the bank with no claim (or taken outside the app).
create or replace function mark_subscription_paid(p_sub uuid, p_ref text, p_by text, p_reason text)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  s subscriptions;
begin
  if p_reason is null or length(btrim(p_reason)) = 0 then
    raise exception 'A reason is required.';
  end if;
  select * into s from subscriptions where id = p_sub for update;
  if s.id is null then
    raise exception 'That invoice does not exist.';
  end if;
  if exists (select 1 from payment_claims where subscription_id = p_sub and status = 'pending') then
    raise exception 'A claim is waiting for this invoice. Confirm or reject it instead.';
  end if;
  if s.status <> 'pending' then
    raise exception 'The invoice is %, so it cannot be marked paid.', s.status;
  end if;
  update subscriptions
     set status = 'paid', method = 'transfer', payment_ref = coalesce(nullif(btrim(p_ref), ''), s.reference),
         paid_at = now()
   where id = p_sub;
  perform apply_subscription_license(p_sub);
end;
$$;

-- Moves a paid invoice's end dates later (a favour while a payment is checked,
-- or a goodwill extension). Never earlier: shortening is a different decision.
create or replace function extend_subscription(
  p_sub uuid, p_valid_until timestamptz, p_grace_until timestamptz, p_by text, p_reason text
)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  s subscriptions;
begin
  if p_reason is null or length(btrim(p_reason)) = 0 then
    raise exception 'A reason is required.';
  end if;
  select * into s from subscriptions where id = p_sub for update;
  if s.id is null or s.status <> 'paid' then
    raise exception 'Only a paid invoice can be extended.';
  end if;
  if p_valid_until <= s.valid_until then
    raise exception 'The new valid-until date must be later than the current one.';
  end if;
  if p_grace_until < p_valid_until then
    raise exception 'Grace cannot end before the licence does.';
  end if;
  update subscriptions set valid_until = p_valid_until, grace_until = p_grace_until where id = p_sub;
  perform apply_subscription_license(p_sub);
end;
$$;

-- The worker reports what the school said to a licence push.
create or replace function record_license_push(p_school uuid, p_version bigint, p_ok boolean, p_error text)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if p_ok then
    update schools
       set license_pushed_version = greatest(license_pushed_version, least(p_version, license_version)),
           license_pushed_at = now(), license_push_error = null
     where id = p_school;
  else
    update schools set license_push_error = left(coalesce(p_error, 'The push failed.'), 500)
     where id = p_school;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Telegram
-- ---------------------------------------------------------------------------

-- Claims still waiting after 48 hours get one reminder. A claim with a reminder
-- already sent or queued is skipped.
create or replace function enqueue_claim_reminders(p_after interval default interval '48 hours')
returns integer
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  n integer;
begin
  with due as (
    select c.id, c.school_id from payment_claims c
     where c.status = 'pending' and c.reminded_at is null
       and c.created_at < now() - p_after
       and not exists (select 1 from jobs j
                        where j.type = 'telegram_notify' and j.payload ->> 'claim_id' = c.id::text
                          and j.payload ->> 'kind' = 'reminder' and j.status in ('queued', 'running'))
  ), ins as (
    insert into jobs (type, school_id, payload)
    select 'telegram_notify', school_id, jsonb_build_object('kind', 'reminder', 'claim_id', id) from due
    returning 1)
  select count(*) into n from ins;
  return n;
end;
$$;

create or replace function mark_claim_notified(p_claim uuid, p_kind text)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if p_kind = 'claim' then
    update payment_claims set notified_at = coalesce(notified_at, now()) where id = p_claim;
  elsif p_kind = 'reminder' then
    update payment_claims set reminded_at = coalesce(reminded_at, now()) where id = p_claim;
  else
    raise exception 'Unknown notification kind.';
  end if;
end;
$$;

-- Everything the Telegram notice needs, in one flat row.
create or replace function claim_for_notice(p_claim uuid)
returns table (
  id uuid, status text, amount_kobo bigint, sent_on date, created_at timestamptz,
  notified_at timestamptz, reminded_at timestamptz,
  reference text, session text, school_name text
)
language sql
stable
security definer
set search_path to 'public'
as $$
  select c.id, c.status, c.amount_kobo, c.sent_on, c.created_at, c.notified_at, c.reminded_at,
         s.reference, s.session, sc.name
    from payment_claims c
    join subscriptions s on s.id = c.subscription_id
    join schools sc on sc.id = c.school_id
   where c.id = p_claim;
$$;

do $$
declare
  f text;
begin
  foreach f in array array[
    'set_price(text, bigint, integer, timestamptz, text, text)',
    'set_price_override(uuid, text, text, bigint, integer, text, text)',
    'add_school_signing_key(uuid, text, text)', 'revoke_school_signing_key(uuid)',
    'create_subscription(uuid, text, integer, integer, bigint, timestamptz, timestamptz, jsonb, jsonb, text)',
    'cancel_subscription(uuid, text, text)', 'apply_subscription_license(uuid)',
    'submit_claim(uuid, text, text, bigint, date, text, text, text, text)',
    'confirm_claim(uuid, bigint, text, text)', 'reject_claim(uuid, text, text)',
    'mark_subscription_paid(uuid, text, text, text)',
    'extend_subscription(uuid, timestamptz, timestamptz, text, text)',
    'record_license_push(uuid, bigint, boolean, text)',
    'enqueue_claim_reminders(interval)', 'mark_claim_notified(uuid, text)',
    'claim_for_notice(uuid)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;
