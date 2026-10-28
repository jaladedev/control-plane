-- M6: proofs of payment in the control plane's own bucket, and card payments
-- through one Paystack account.
--
-- Same rules as before: whole kobo, service role only, an audit row written by the
-- caller first, and every refusal worded for the person who reads it.

-- ---------------------------------------------------------------------------
-- A claim may only name a proof this school was given a link for
-- ---------------------------------------------------------------------------

-- Replaces the M2b function with one extra check. The path must be
-- proofs/<this school's slug>/<uuid>.<jpg|png|webp|pdf>, which is exactly what the
-- upload endpoint hands out, so a school cannot point a claim at another school's
-- file or at anything else in the bucket.
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
  v_slug text;
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
  if p_proof_path is not null then
    select slug into v_slug from schools where id = p_school;
    if p_proof_path !~ ('^proofs/' || v_slug || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp|pdf)$') then
      raise exception 'That is not a proof uploaded for this school.';
    end if;
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

-- ---------------------------------------------------------------------------
-- Card payments (Paystack)
-- ---------------------------------------------------------------------------

-- One row per checkout started. The reference is ours (PSK-...), sent to Paystack as
-- the transaction reference, and is how a webhook is matched back to an invoice.
create table paystack_payments (
  id uuid primary key default gen_random_uuid(),
  reference text not null unique check (reference ~ '^PSK-[0-9A-F]{16}$'),
  subscription_id uuid not null references subscriptions (id) on delete restrict,
  school_id uuid not null references schools (id) on delete restrict,
  -- What the invoice was when the checkout started.
  amount_kobo bigint not null check (amount_kobo > 0),
  payer_email text not null check (length(payer_email) between 3 and 200),
  -- initiated: waiting for the school to pay. applied: money matched and the invoice
  -- paid. needs_review: money arrived that could not be applied, so a person must look.
  -- resolved: a person dealt with a needs_review row.
  status text not null default 'initiated'
    check (status in ('initiated', 'applied', 'needs_review', 'resolved')),
  paystack_id text,
  paid_amount_kobo bigint check (paid_amount_kobo is null or paid_amount_kobo >= 0),
  paid_at timestamptz,
  note text,
  resolved_by text,
  resolved_at timestamptz,
  resolution text,
  created_at timestamptz not null default now(),
  constraint paystack_paid_is_complete check (
    status = 'initiated' or (paystack_id is not null and paid_at is not null)),
  constraint paystack_resolved_is_complete check (
    status <> 'resolved' or (resolved_by is not null and resolved_at is not null and resolution is not null))
);
create index paystack_payments_sub_idx on paystack_payments (subscription_id, status);
create index paystack_payments_review_idx on paystack_payments (created_at) where status = 'needs_review';

alter table paystack_payments enable row level security;
create policy paystack_payments_select_billing on paystack_payments
  for select to authenticated using (dashboard_role() in ('owner', 'finance'));
revoke all on paystack_payments from public, anon, authenticated;
grant select on paystack_payments to authenticated;

-- Starts a checkout for an invoice that is waiting for payment. The amount is the
-- invoice's, read here, never taken from the caller.
create or replace function paystack_begin(p_school uuid, p_reference text, p_email text)
returns table (reference text, amount_kobo bigint)
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  s subscriptions;
  v_ref text;
  tries integer := 0;
begin
  if p_email is null or p_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' or length(p_email) > 200 then
    raise exception 'A valid email address is needed for the card receipt.';
  end if;
  select * into s from subscriptions where subscriptions.reference = p_reference and school_id = p_school;
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
    raise exception 'That invoice is % and cannot be paid.', s.status;
  end if;
  if s.amount_kobo <= 0 then
    raise exception 'That invoice has nothing to pay.';
  end if;

  loop
    v_ref := 'PSK-' || upper(substr(md5(random()::text || clock_timestamp()::text), 1, 16));
    exit when not exists (select 1 from paystack_payments p where p.reference = v_ref);
    tries := tries + 1;
    if tries > 10 then raise exception 'Could not make a unique payment reference.'; end if;
  end loop;

  insert into paystack_payments (reference, subscription_id, school_id, amount_kobo, payer_email)
  values (v_ref, s.id, p_school, s.amount_kobo, p_email);
  reference := v_ref;
  amount_kobo := s.amount_kobo;
  return next;
end;
$$;

-- Money as a person reads it (150000.00), for notices.
create or replace function kobo_as_naira(p_kobo bigint) returns text
language sql immutable
as $$ select (p_kobo / 100)::text || '.' || lpad((p_kobo % 100)::text, 2, '0') $$;

-- Called when Paystack says a charge succeeded. Safe to call again for the same
-- charge. Returns what happened:
--   applied      the invoice is now paid and the licence is being updated
--   duplicate    this charge was already dealt with
--   needs_review money arrived that could not be applied; a person is told
--   unknown      the reference is not one of ours (Paystack account used for something else)
create or replace function paystack_record_charge(
  p_reference text, p_paystack_id text, p_paid_kobo bigint, p_currency text
)
returns text
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  pp paystack_payments;
  s subscriptions;
  v_school text;
  v_note text;
begin
  if p_paystack_id is null or length(btrim(p_paystack_id)) = 0 then
    raise exception 'The charge has no Paystack id.';
  end if;
  select * into pp from paystack_payments where reference = p_reference for update;
  if pp.id is null then
    return 'unknown';
  end if;
  if pp.status in ('applied', 'resolved') or (pp.status = 'needs_review' and pp.paystack_id = p_paystack_id) then
    return 'duplicate';
  end if;

  select * into s from subscriptions where id = pp.subscription_id for update;
  select name into v_school from schools where id = pp.school_id;

  if p_currency is distinct from 'NGN' or p_paid_kobo is distinct from pp.amount_kobo then
    v_note := format('Paystack reported %s %s but the invoice was NGN %s.',
                     coalesce(p_currency, '?'), coalesce(kobo_as_naira(p_paid_kobo), '?'), kobo_as_naira(pp.amount_kobo));
  elsif s.status = 'pending_confirmation' then
    -- The school also sent a transfer claim. The card payment is money in hand, so the
    -- claim is closed and the invoice is paid; a person can see why in the claim's reason.
    update payment_claims
       set status = 'rejected', decided_by = 'system:paystack', decided_at = now(),
           decision_reason = 'The invoice was paid by card (' || p_reference || ').'
     where subscription_id = s.id and status = 'pending';
    update subscriptions set status = 'pending' where id = s.id and status = 'pending_confirmation';
    s.status := 'pending';
  end if;

  if v_note is null and s.status <> 'pending' then
    v_note := format('The invoice was %s when the card payment arrived.', s.status);
  end if;

  if v_note is not null then
    update paystack_payments
       set status = 'needs_review', paystack_id = p_paystack_id, paid_amount_kobo = p_paid_kobo,
           paid_at = now(), note = v_note
     where id = pp.id;
    insert into jobs (type, school_id, payload)
    values ('telegram_notify', pp.school_id, jsonb_build_object(
      'kind', 'paystack_review',
      'message', format(E'Card payment needs review: %s\n%s (%s)\n%s\nIt is under Billing, "Card payments needing review".',
                        v_school, s.reference, p_reference, v_note)));
    return 'needs_review';
  end if;

  update subscriptions
     set status = 'paid', method = 'paystack', payment_ref = p_reference, paid_at = now()
   where id = s.id;
  update paystack_payments
     set status = 'applied', paystack_id = p_paystack_id, paid_amount_kobo = p_paid_kobo, paid_at = now()
   where id = pp.id;
  perform apply_subscription_license(s.id);
  return 'applied';
end;
$$;

-- A person dealt with a payment that needed review (for example, refunded it from the
-- Paystack dashboard). Records who and what they did.
create or replace function resolve_paystack_review(p_id uuid, p_by text, p_resolution text)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if p_resolution is null or length(btrim(p_resolution)) = 0 then
    raise exception 'Say what you did about it.';
  end if;
  update paystack_payments
     set status = 'resolved', resolved_by = p_by, resolved_at = now(), resolution = p_resolution
   where id = p_id and status = 'needs_review';
  if not found then
    raise exception 'Only a card payment that needs review can be resolved.';
  end if;
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
    'kobo_as_naira(bigint)',
    'submit_claim(uuid, text, text, bigint, date, text, text, text, text)',
    'paystack_begin(uuid, text, text)',
    'paystack_record_charge(text, text, bigint, text)',
    'resolve_paystack_review(uuid, text, text)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;
