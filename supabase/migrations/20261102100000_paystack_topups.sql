-- Paying a top-up by card. A top-up (extra students on a paid invoice, TOP-xxxxxxxx) used
-- to be marked paid only by a person. A school can now start a card checkout for one,
-- and Paystack's webhook pays it exactly as a person would: the amount and currency
-- must match, the top-up must still be waiting, and the school's allowance goes up and a
-- higher licence version is pushed. Anything that does not fit is held for a person.
--
-- Runs after 20261101100000_m6_reconfigure_and_drills.sql.

-- A checkout row is for an invoice, or for one top-up of an invoice (subscription_id is
-- then that top-up's invoice, so reporting by invoice still works).
alter table paystack_payments
  add column topup_id uuid references subscription_topups (id) on delete restrict;
create index paystack_payments_topup_idx on paystack_payments (topup_id) where topup_id is not null;

-- Starts a checkout for a top-up that is waiting for payment. The amount is the
-- top-up's, read here, never taken from the caller.
create or replace function paystack_begin_topup(p_school uuid, p_reference text, p_email text)
returns table (reference text, amount_kobo bigint)
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  t subscription_topups;
  s subscriptions;
  v_status text;
  v_ref text;
  tries integer := 0;
begin
  if p_email is null or p_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' or length(p_email) > 200 then
    raise exception 'A valid email address is needed for the card receipt.';
  end if;
  select * into t from subscription_topups
   where subscription_topups.reference = p_reference and school_id = p_school;
  if t.id is null then
    raise exception 'There is no top-up with that reference for this school.';
  end if;
  if t.status = 'paid' then
    raise exception 'That top-up has already been paid.';
  end if;
  if t.status <> 'pending' then
    raise exception 'That top-up is % and cannot be paid.', t.status;
  end if;
  select * into s from subscriptions where id = t.subscription_id;
  if s.status <> 'paid' then
    raise exception 'The invoice for that top-up is %, so it cannot be paid.', s.status;
  end if;
  select status into v_status from schools where id = p_school;
  if v_status is distinct from 'active' then
    raise exception 'Only an active school can pay a top-up.';
  end if;
  if s.grace_until <= now() then
    raise exception 'This session has ended, so the top-up cannot be paid. Ask for the next session''s invoice.';
  end if;
  if t.amount_kobo <= 0 then
    raise exception 'That top-up has nothing to pay.';
  end if;

  loop
    v_ref := 'PSK-' || upper(substr(md5(random()::text || clock_timestamp()::text), 1, 16));
    exit when not exists (select 1 from paystack_payments p where p.reference = v_ref);
    tries := tries + 1;
    if tries > 10 then raise exception 'Could not make a unique payment reference.'; end if;
  end loop;

  insert into paystack_payments (reference, subscription_id, topup_id, school_id, amount_kobo, payer_email)
  values (v_ref, t.subscription_id, t.id, p_school, t.amount_kobo, p_email);
  reference := v_ref;
  amount_kobo := t.amount_kobo;
  return next;
end;
$$;

-- Replaces the M6 function with one extra branch, for a charge that belongs to a top-up.
-- The invoice path below it is unchanged.
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
  t subscription_topups;
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

  -- A card payment for a top-up: the same rules as an invoice (the amount and currency
  -- must match, nothing is applied to something no longer payable), then the same
  -- effect as a person marking it paid.
  if pp.topup_id is not null then
    select * into t from subscription_topups where id = pp.topup_id for update;
    select * into s from subscriptions where id = pp.subscription_id for update;
    select name into v_school from schools where id = pp.school_id;

    if p_currency is distinct from 'NGN' or p_paid_kobo is distinct from pp.amount_kobo then
      v_note := format('Paystack reported %s %s but the top-up was NGN %s.',
                       coalesce(p_currency, '?'), coalesce(kobo_as_naira(p_paid_kobo), '?'), kobo_as_naira(pp.amount_kobo));
    elsif t.status <> 'pending' then
      v_note := format('The top-up was %s when the card payment arrived.', t.status);
    elsif s.status <> 'paid' then
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
                          v_school, t.reference, p_reference, v_note)));
      return 'needs_review';
    end if;

    update subscription_topups
       set status = 'paid', paid_at = now(), paid_by = 'system:paystack',
           decision_reason = 'Paid by card (' || p_reference || ').', payment_ref = p_reference
     where id = t.id;
    update subscriptions
       set extra_students = extra_students + t.extra_students,
           topup_kobo = topup_kobo + t.amount_kobo
     where id = s.id;
    update paystack_payments
       set status = 'applied', paystack_id = p_paystack_id, paid_amount_kobo = p_paid_kobo, paid_at = now()
     where id = pp.id;
    perform apply_subscription_license(s.id);
    return 'applied';
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

revoke all on function paystack_begin_topup(uuid, text, text) from public, anon, authenticated;
grant execute on function paystack_begin_topup(uuid, text, text) to service_role;
revoke all on function paystack_record_charge(text, text, bigint, text) from public, anon, authenticated;
grant execute on function paystack_record_charge(text, text, bigint, text) to service_role;
