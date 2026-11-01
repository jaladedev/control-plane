-- Claiming a bank transfer for a top-up. A school that paid a top-up (TOP-xxxxxxxx) by
-- transfer used to have no way to say so: a person had to notice the money and mark it
-- paid. It can now send a claim for the top-up, exactly as it does for an invoice. The
-- claim joins the same Billing queue; nothing is credited until a person confirms it
-- against the bank statement, and confirming pays the top-up through mark_topup_paid,
-- the same path as marking it paid by hand.
--
-- Runs after 20261103100000_invoice_reminders.sql.

-- A claim is for an invoice, or for one top-up of a paid invoice (subscription_id is
-- then that invoice, so reporting by invoice still works).
alter table payment_claims
  add column topup_id uuid references subscription_topups (id) on delete restrict;
create unique index payment_claims_one_pending_topup on payment_claims (topup_id)
  where status = 'pending' and topup_id is not null;

-- A decided claim stays history, topup_id included.
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
    if (new.id, new.school_id, new.subscription_id, new.topup_id, new.client_ref, new.claimed_by,
        new.amount_kobo, new.sent_on, new.sender_name, new.payer_reference, new.proof_path,
        new.status, new.confirmed_amount_kobo, new.decided_by, new.decided_at,
        new.decision_reason, new.created_at)
       is distinct from
       (old.id, old.school_id, old.subscription_id, old.topup_id, old.client_ref, old.claimed_by,
        old.amount_kobo, old.sent_on, old.sender_name, old.payer_reference, old.proof_path,
        old.status, old.confirmed_amount_kobo, old.decided_by, old.decided_at,
        old.decision_reason, old.created_at) then
      raise exception 'payment_claims is append-only: a decided claim cannot be changed.';
    end if;
  end if;
  return new;
end;
$$;

-- "I have paid this top-up by transfer". The top-up stays pending (it is still unpaid
-- until a person sees the money); the claim only asks for it to be checked. Retrying
-- with the same client_ref returns the same claim.
create or replace function submit_topup_claim(
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
  v_status text;
  t subscription_topups;
  s subscriptions;
  v_id uuid;
begin
  select id into v_existing from payment_claims where school_id = p_school and client_ref = p_client_ref;
  if v_existing is not null then
    return v_existing;
  end if;

  select * into t from subscription_topups where reference = p_reference and school_id = p_school;
  if t.id is null then
    raise exception 'There is no top-up with that reference for this school.';
  end if;
  if t.status = 'paid' then
    raise exception 'That top-up has already been paid.';
  end if;
  if t.status <> 'pending' then
    raise exception 'That top-up is % and cannot be claimed.', t.status;
  end if;
  if exists (select 1 from payment_claims where topup_id = t.id and status = 'pending') then
    raise exception 'A payment claim for that top-up is already waiting to be confirmed.';
  end if;
  select * into s from subscriptions where id = t.subscription_id;
  if s.status <> 'paid' then
    raise exception 'The invoice for that top-up is %, so it cannot be paid.', s.status;
  end if;
  select status, slug into v_status, v_slug from schools where id = p_school;
  if v_status is distinct from 'active' then
    raise exception 'Only an active school can pay a top-up.';
  end if;
  if s.grace_until <= now() then
    raise exception 'This session has ended, so the top-up cannot be paid. Ask for the next session''s invoice.';
  end if;
  if p_sent_on > current_date + 1 or p_sent_on < current_date - 90 then
    raise exception 'The date the payment was sent looks wrong.';
  end if;
  if p_proof_path is not null
     and p_proof_path !~ ('^proofs/' || v_slug || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp|pdf)$') then
    raise exception 'That is not a proof uploaded for this school.';
  end if;

  insert into payment_claims (school_id, subscription_id, topup_id, client_ref, claimed_by, amount_kobo,
                              sent_on, sender_name, payer_reference, proof_path)
  values (p_school, t.subscription_id, t.id, p_client_ref, p_claimed_by, p_amount_kobo,
          p_sent_on, p_sender, p_payer_reference, p_proof_path)
  returning id into v_id;
  insert into jobs (type, school_id, payload)
  values ('telegram_notify', p_school, jsonb_build_object('kind', 'claim', 'claim_id', v_id));
  return v_id;
end;
$$;

-- Replaces the M2b function with one extra branch, for a claim that belongs to a top-up.
-- The invoice path is unchanged.
create or replace function confirm_claim(p_claim uuid, p_amount_kobo bigint, p_by text, p_reason text)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  c payment_claims;
  s subscriptions;
  t subscription_topups;
begin
  if p_reason is null or length(btrim(p_reason)) = 0 then
    raise exception 'A reason is required (for example, the bank statement line you checked).';
  end if;
  select * into c from payment_claims where id = p_claim for update;
  if c.id is null or c.status <> 'pending' then
    raise exception 'Only a claim that is waiting for confirmation can be confirmed.';
  end if;

  if c.topup_id is not null then
    select * into t from subscription_topups where id = c.topup_id for update;
    if t.status <> 'pending' then
      raise exception 'The top-up is %, so this claim cannot be confirmed.', t.status;
    end if;
    if p_amount_kobo <> t.amount_kobo then
      raise exception 'The amount received (% kobo) does not match the top-up (% kobo). Reject the claim if the amount is different.',
        p_amount_kobo, t.amount_kobo;
    end if;
    -- The claim is closed first, so the top-up's own trigger finds nothing left to close.
    update payment_claims
       set status = 'confirmed', confirmed_amount_kobo = p_amount_kobo,
           decided_by = p_by, decided_at = now(), decision_reason = p_reason
     where id = p_claim;
    perform mark_topup_paid(t.id, p_amount_kobo, coalesce(c.payer_reference, t.reference), p_by, p_reason);
    return;
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

-- However a top-up stops waiting (paid by card, marked paid by hand, cancelled), a claim
-- still open for it is closed with the reason, so the queue never holds a claim that can
-- no longer be confirmed. confirm_claim closes its own claim first and so never gets here.
create or replace function close_claims_of_topup()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if old.status = 'pending' and new.status <> 'pending' then
    update payment_claims
       set status = 'rejected', decided_by = coalesce(new.paid_by, 'system'), decided_at = now(),
           decision_reason = case new.status
             when 'paid' then 'The top-up was paid another way (' || coalesce(new.payment_ref, new.reference) || ').'
             else 'The top-up was ' || new.status || '.'
           end
     where topup_id = new.id and status = 'pending';
  end if;
  return new;
end;
$$;
create trigger subscription_topups_close_claims after update of status on subscription_topups
  for each row execute function close_claims_of_topup();

-- The Telegram notice names what is being paid: the top-up's reference for a top-up
-- claim, the invoice's otherwise. Same columns as before, so callers do not change.
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
         coalesce(t.reference, s.reference), s.session, sc.name
    from payment_claims c
    join subscriptions s on s.id = c.subscription_id
    join schools sc on sc.id = c.school_id
    left join subscription_topups t on t.id = c.topup_id
   where c.id = p_claim;
$$;

revoke all on function submit_topup_claim(uuid, text, text, bigint, date, text, text, text, text) from public, anon, authenticated;
grant execute on function submit_topup_claim(uuid, text, text, bigint, date, text, text, text, text) to service_role;
revoke all on function confirm_claim(uuid, bigint, text, text) from public, anon, authenticated;
grant execute on function confirm_claim(uuid, bigint, text, text) to service_role;
revoke all on function close_claims_of_topup() from public, anon, authenticated;
revoke all on function claim_for_notice(uuid) from public, anon, authenticated;
grant execute on function claim_for_notice(uuid) to service_role;
