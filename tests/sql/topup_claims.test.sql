-- Claiming a bank transfer for a top-up: submit, confirm, reject, and every way a claim is closed for you.
\set ON_ERROR_STOP on
create or replace function pg_temp.assert(ok boolean, msg text) returns void language plpgsql as $$
begin
  if not coalesce(ok, false) then raise exception 'FAILED: %', msg; end if;
end $$;
create or replace function pg_temp.err(stmt text) returns text language plpgsql as $$
begin
  execute stmt;
  return null;
exception when others then
  return sqlerrm;
end $$;
create or replace function pg_temp.quote(total bigint) returns jsonb language sql as $$
  select jsonb_build_object('lines', jsonb_build_array(jsonb_build_object('item', 'base_fee', 'total_kobo', total)))
$$;
create or replace function pg_temp.topup_line(unit bigint) returns jsonb language sql as $$
  select jsonb_build_object('item', 'extra_student', 'unit_kobo', unit)
$$;

begin;
set local role service_role;

begin;
set local role service_role;

insert into schools (slug, name, status, hostnames, supabase_project_ref) values
  ('alpha', 'Alpha Academy', 'active', '{alpha.example.com}', 'refalpha'),
  ('beta', 'Beta College', 'active', '{beta.example.com}', 'refbeta');
select id as alpha from schools where slug = 'alpha' \gset
select id as beta from schools where slug = 'beta' \gset

select create_subscription(:'alpha', '2026/2027', 300, 0, 15000000, now() + interval '200 days', now() + interval '214 days', '[]', pg_temp.quote(15000000), 'f') as sa \gset
select mark_subscription_paid(:'sa', 'NIP1', 'finance@example.com', 'seen on statement');
select create_topup(:'sa', 5, 500000, pg_temp.topup_line(100000), 'finance@example.com') as t1 \gset
select reference as r1 from subscription_topups where id = :'t1' \gset
select license_version as v0 from schools where id = :'alpha' \gset

-- ------------------------------------------------------------- submit
select pg_temp.assert(pg_temp.err(format($q$select submit_topup_claim(%L, 'TOP-00000000', 'claim-0001-aaaa', 500000, current_date, 'Bursar', null, null, 'b@alpha.example')$q$, :'alpha')) like '%no top-up with that reference%', 'an unknown top-up is refused');
select pg_temp.assert(pg_temp.err(format($q$select submit_topup_claim(%L, %L, 'claim-0001-aaaa', 500000, current_date, 'Bursar', null, null, 'b@alpha.example')$q$, :'beta', :'r1')) like '%no top-up with that reference%', 'another school''s top-up is refused');
select pg_temp.assert(pg_temp.err(format($q$select submit_topup_claim(%L, %L, 'claim-0001-aaaa', 500000, current_date - 200, 'Bursar', null, null, 'b@alpha.example')$q$, :'alpha', :'r1')) like '%date%looks wrong%', 'a wild date is refused');
select pg_temp.assert(pg_temp.err(format($q$select submit_topup_claim(%L, %L, 'claim-0001-aaaa', 500000, current_date, 'Bursar', null, 'proofs/beta/11111111-1111-1111-1111-111111111111.pdf', 'b@alpha.example')$q$, :'alpha', :'r1')) like '%not a proof uploaded for this school%', 'another school''s proof is refused');

select submit_topup_claim(:'alpha', :'r1', 'claim-0001-aaaa', 500000, current_date, 'Bursar', 'NIP-777', null, 'b@alpha.example') as c1 \gset
select pg_temp.assert((select status = 'pending' and topup_id = :'t1'::uuid and subscription_id = :'sa'::uuid and amount_kobo = 500000 from payment_claims where id = :'c1'), 'the claim waits, tied to the top-up and its invoice');
select pg_temp.assert((select status = 'pending' from subscription_topups where id = :'t1'), 'the top-up is still unpaid');
select pg_temp.assert((select status = 'paid' and extra_students = 0 from subscriptions where id = :'sa'), 'the paid invoice is untouched');
select pg_temp.assert((select count(*) = 1 from jobs where type = 'telegram_notify' and payload ->> 'kind' = 'claim' and payload ->> 'claim_id' = :'c1'), 'the owner is told');
select pg_temp.assert(submit_topup_claim(:'alpha', :'r1', 'claim-0001-aaaa', 500000, current_date, 'Bursar', 'NIP-777', null, 'b@alpha.example') = :'c1'::uuid, 'the same client_ref returns the same claim');
select pg_temp.assert((select count(*) = 1 from jobs where payload ->> 'kind' = 'claim'), 'and tells the owner once');
select pg_temp.assert(pg_temp.err(format($q$select submit_topup_claim(%L, %L, 'claim-0002-bbbb', 500000, current_date, 'Bursar', null, null, 'b@alpha.example')$q$, :'alpha', :'r1')) like '%already waiting to be confirmed%', 'a second open claim for the top-up is refused');

select pg_temp.assert((select reference = :'r1' from claim_for_notice(:'c1')), 'the Telegram notice names the top-up');

-- ------------------------------------------------------------- confirm
select pg_temp.assert(pg_temp.err(format($q$select confirm_claim(%L, 400000, 'f@example.com', 'line 4')$q$, :'c1')) like '%does not match the top-up%', 'the wrong amount is refused');
select pg_temp.assert(pg_temp.err(format($q$select confirm_claim(%L, 500000, 'f@example.com', ' ')$q$, :'c1')) like '%reason is required%', 'a reason is required');
select pg_temp.assert((select status = 'pending' from payment_claims where id = :'c1'), 'a refused confirm leaves the claim waiting');
select confirm_claim(:'c1', 500000, 'f@example.com', 'statement line 4, 2 Nov');
select pg_temp.assert((select status = 'confirmed' and confirmed_amount_kobo = 500000 and decided_by = 'f@example.com' from payment_claims where id = :'c1'), 'the claim is confirmed by the person');
select pg_temp.assert((select status = 'paid' and paid_by = 'f@example.com' and payment_ref = 'NIP-777' and decision_reason = 'statement line 4, 2 Nov' from subscription_topups where id = :'t1'), 'the top-up is paid, with the bank reference');
select pg_temp.assert((select extra_students = 5 and topup_kobo = 500000 and status = 'paid' from subscriptions where id = :'sa'), 'the invoice gains the students and the money');
select pg_temp.assert((select license_version = :v0 + 1 and included_students = 305 from schools where id = :'alpha'), 'the allowance is raised and the licence version goes up');
select pg_temp.assert(pg_temp.err(format($q$select confirm_claim(%L, 500000, 'f@example.com', 'again')$q$, :'c1')) like '%waiting for confirmation%', 'a confirmed claim cannot be confirmed twice');
select pg_temp.assert(pg_temp.err(format($q$select submit_topup_claim(%L, %L, 'claim-0003-cccc', 500000, current_date, 'Bursar', null, null, 'b@alpha.example')$q$, :'alpha', :'r1')) like '%already been paid%', 'a paid top-up cannot be claimed');

-- ------------------------------------------------------------- reject
select create_topup(:'sa', 2, 200000, pg_temp.topup_line(100000), 'f') as t2 \gset
select reference as r2 from subscription_topups where id = :'t2' \gset
select submit_topup_claim(:'alpha', :'r2', 'claim-0004-dddd', 200000, current_date, 'Bursar', null, null, 'b@alpha.example') as c2 \gset
select reject_claim(:'c2', 'f@example.com', 'nothing in the bank');
select pg_temp.assert((select status = 'rejected' from payment_claims where id = :'c2'), 'the claim is rejected');
select pg_temp.assert((select status = 'pending' from subscription_topups where id = :'t2'), 'the top-up is waiting again');
select pg_temp.assert((select status = 'paid' from subscriptions where id = :'sa'), 'and the paid invoice is still paid');
select submit_topup_claim(:'alpha', :'r2', 'claim-0005-eeee', 200000, current_date, 'Bursar', null, null, 'b@alpha.example') as c3 \gset
select pg_temp.assert(:'c3' <> :'c2', 'after a rejection the school can claim again');

-- ------------------------------------------------------------- closed for you
-- paid by hand while a claim is open
select mark_topup_paid(:'t2', 200000, 'NIP-888', 'f@example.com', 'seen on statement');
select pg_temp.assert((select status = 'rejected' and decided_by = 'f@example.com' and decision_reason like 'The top-up was paid another way (NIP-888)%' from payment_claims where id = :'c3'), 'a top-up marked paid by hand closes its open claim');

-- cancelled while a claim is open
select create_topup(:'sa', 1, 100000, pg_temp.topup_line(100000), 'f') as t3 \gset
select reference as r3 from subscription_topups where id = :'t3' \gset
select submit_topup_claim(:'alpha', :'r3', 'claim-0006-ffff', 100000, current_date, 'Bursar', null, null, 'b@alpha.example') as c4 \gset
select cancel_topup(:'t3', 'f@example.com', 'raised by mistake');
select pg_temp.assert((select status = 'rejected' and decision_reason = 'The top-up was cancelled.' from payment_claims where id = :'c4'), 'a cancelled top-up closes its open claim');
select pg_temp.assert(pg_temp.err(format($q$select submit_topup_claim(%L, %L, 'claim-0007-gggg', 100000, current_date, 'Bursar', null, null, 'b@alpha.example')$q$, :'alpha', :'r3')) like '%is cancelled and cannot be claimed%', 'a cancelled top-up cannot be claimed');

-- paid by card while a claim is open
select create_topup(:'sa', 3, 300000, pg_temp.topup_line(100000), 'f') as t4 \gset
select reference as r4 from subscription_topups where id = :'t4' \gset
select submit_topup_claim(:'alpha', :'r4', 'claim-0008-hhhh', 300000, current_date, 'Bursar', null, null, 'b@alpha.example') as c5 \gset
select reference as p4 from paystack_begin_topup(:'alpha', :'r4', 'bursar@alpha.example') \gset
select pg_temp.assert(paystack_record_charge(:'p4', '9001', 300000, 'NGN') = 'applied', 'the card payment pays the top-up');
select pg_temp.assert((select status = 'rejected' and decided_by = 'system:paystack' and decision_reason like 'The top-up was paid another way (PSK-%' from payment_claims where id = :'c5'), 'and closes the open claim');

-- ------------------------------------------------------------- history stays
select pg_temp.assert(pg_temp.err(format($q$update payment_claims set topup_id = null where id = %L$q$, :'c1')) like '%append-only%', 'a decided claim''s top-up cannot be changed');
select pg_temp.assert(pg_temp.err(format($q$delete from payment_claims where id = %L$q$, :'c1')) like '%append-only%', 'and cannot be removed');

-- an invoice claim still works as before
select create_subscription(:'beta', '2026/2027', 100, 0, 5000000, now() + interval '200 days', now() + interval '214 days', '[]', pg_temp.quote(5000000), 'f') as sb \gset
select reference as sbr from subscriptions where id = :'sb' \gset
select submit_claim(:'beta', :'sbr', 'claim-0009-iiii', 5000000, current_date, 'Bursar', null, null, 'b@beta.example') as c6 \gset
select pg_temp.assert((select status = 'pending_confirmation' from subscriptions where id = :'sb'), 'an invoice claim still holds its invoice');
select pg_temp.assert((select reference = :'sbr' from claim_for_notice(:'c6')), 'and its notice still names the invoice');
select confirm_claim(:'c6', 5000000, 'f@example.com', 'line 9');
select pg_temp.assert((select status = 'paid' and method = 'transfer' from subscriptions where id = :'sb'), 'and confirming it still pays the invoice');

rollback;
\echo ALL TOP-UP CLAIM SQL TESTS PASSED
