-- Paying a top-up by card: begin, the webhook's charge, and everything that must be held for a person.
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

insert into schools (slug, name, status, hostnames, supabase_project_ref) values
  ('alpha', 'Alpha Academy', 'active', '{alpha.example.com}', 'refalpha'),
  ('beta', 'Beta College', 'active', '{beta.example.com}', 'refbeta');
select id as alpha from schools where slug = 'alpha' \gset
select id as beta from schools where slug = 'beta' \gset

select create_subscription(:'alpha', '2026/2027', 300, 0, 15000000, now() + interval '200 days', now() + interval '214 days', '[]', pg_temp.quote(15000000), 'f') as sa \gset
select mark_subscription_paid(:'sa', 'NIP1', 'finance@example.com', 'seen on statement');
select create_topup(:'sa', 5, 500000, pg_temp.topup_line(100000), 'finance@example.com') as t1 \gset
select reference as r1 from subscription_topups where id = :'t1' \gset

-- ------------------------------------------------------------- begin
select pg_temp.assert(pg_temp.err(format($q$select * from paystack_begin_topup(%L, %L, 'not-an-email')$q$, :'alpha', :'r1')) like '%valid email%', 'a bad email is refused');
select pg_temp.assert(pg_temp.err(format($q$select * from paystack_begin_topup(%L, 'TOP-00000000', 'a@b.co')$q$, :'alpha')) like '%no top-up with that reference%', 'an unknown top-up is refused');
select pg_temp.assert(pg_temp.err(format($q$select * from paystack_begin_topup(%L, %L, 'a@b.co')$q$, :'beta', :'r1')) like '%no top-up with that reference%', 'another school''s top-up is refused');
select pg_temp.assert(pg_temp.err(format($q$select * from paystack_begin_topup(%L, %L, 'a@b.co')$q$, :'alpha', :'sa')) is not null, 'an invoice id is not a top-up reference');

select reference as p1, amount_kobo as a1 from paystack_begin_topup(:'alpha', :'r1', 'bursar@alpha.example') \gset
select pg_temp.assert(:'p1' ~ '^PSK-[0-9A-F]{16}$' and :a1 = 500000, 'a checkout gets its own reference and the top-up''s amount');
select pg_temp.assert((select status = 'initiated' and topup_id = :'t1'::uuid and subscription_id = :'sa'::uuid and school_id = :'alpha'::uuid and amount_kobo = 500000
                         from paystack_payments where reference = :'p1'), 'the row waits as initiated, tied to the top-up and its invoice');

-- ------------------------------------------------------------- a wrong amount is held, not applied
select license_version as v0 from schools where id = :'alpha' \gset
select pg_temp.assert(paystack_record_charge(:'p1', '5001', 400000, 'NGN') = 'needs_review', 'a charge for the wrong amount is held for a person');
select pg_temp.assert((select status = 'pending' from subscription_topups where id = :'t1'), 'the top-up is still waiting');
select pg_temp.assert((select extra_students = 0 and topup_kobo = 0 from subscriptions where id = :'sa'), 'the invoice is untouched');
select pg_temp.assert((select license_version = :v0 from schools where id = :'alpha'), 'no licence change');
select pg_temp.assert((select status = 'needs_review' and note like '%the top-up was NGN 5000.00%' from paystack_payments where reference = :'p1'), 'the note says what was expected');
select pg_temp.assert((select count(*) = 1 from jobs where type = 'telegram_notify' and payload ->> 'kind' = 'paystack_review' and payload ->> 'message' like '%' || :'r1' || '%'), 'the owner is told, naming the top-up');
select pg_temp.assert(paystack_record_charge(:'p1', '5001', 400000, 'NGN') = 'duplicate', 'the same held charge again is a duplicate');
select resolve_paystack_review((select id from paystack_payments where reference = :'p1'), 'owner@example.com', 'refunded in the Paystack dashboard');

-- ------------------------------------------------------------- a matching charge pays it
select reference as p2 from paystack_begin_topup(:'alpha', :'r1', 'bursar@alpha.example') \gset
select pg_temp.assert(paystack_record_charge(:'p2', '5002', 500000, 'USD') = 'needs_review', 'the wrong currency is held');
select resolve_paystack_review((select id from paystack_payments where reference = :'p2'), 'owner@example.com', 'refunded');
select reference as p3 from paystack_begin_topup(:'alpha', :'r1', 'bursar@alpha.example') \gset
select pg_temp.assert(paystack_record_charge(:'p3', '5003', 500000, 'NGN') = 'applied', 'a matching charge is applied');
select pg_temp.assert((select status = 'paid' and paid_by = 'system:paystack' and payment_ref = :'p3' and paid_at is not null and decision_reason like 'Paid by card (%' from subscription_topups where id = :'t1'), 'the top-up is paid by card with Paystack''s reference');
select pg_temp.assert((select extra_students = 5 and topup_kobo = 500000 and amount_kobo = 15000000 and status = 'paid' from subscriptions where id = :'sa'), 'the invoice gains the students and the money, and stays paid');
select pg_temp.assert((select license_version = :v0 + 1 and included_students = 305 from schools where id = :'alpha'), 'the allowance is raised and the licence version goes up');
select pg_temp.assert((select count(*) = 2 from jobs where type = 'license_push' and school_id = :'alpha'), 'and a second licence push is queued (the first was for the invoice)');
select pg_temp.assert((select status = 'applied' and paystack_id = '5003' and paid_amount_kobo = 500000 from paystack_payments where reference = :'p3'), 'the payment row is applied');
select pg_temp.assert(paystack_record_charge(:'p3', '5003', 500000, 'NGN') = 'duplicate', 'the same charge again is a duplicate');
select pg_temp.assert((select license_version from schools where id = :'alpha') = :v0 + 1, 'a duplicate changes nothing');
select pg_temp.assert(pg_temp.err(format($q$select * from paystack_begin_topup(%L, %L, 'a@b.co')$q$, :'alpha', :'r1')) like '%already been paid%', 'a paid top-up cannot start a checkout');

-- ------------------------------------------------------------- two checkouts for one top-up: the second is held
select create_topup(:'sa', 2, 200000, pg_temp.topup_line(100000), 'f') as t2 \gset
select reference as r2 from subscription_topups where id = :'t2' \gset
select reference as q1 from paystack_begin_topup(:'alpha', :'r2', 'a@b.co') \gset
select reference as q2 from paystack_begin_topup(:'alpha', :'r2', 'a@b.co') \gset
select pg_temp.assert(paystack_record_charge(:'q1', '6001', 200000, 'NGN') = 'applied', 'the first payment pays the top-up');
select pg_temp.assert(paystack_record_charge(:'q2', '6002', 200000, 'NGN') = 'needs_review', 'a second payment for the same top-up is held');
select pg_temp.assert((select note like '%top-up was paid when the card payment arrived%' from paystack_payments where reference = :'q2'), 'the note says it was already paid');
select pg_temp.assert((select extra_students = 7 and topup_kobo = 700000 from subscriptions where id = :'sa'), 'the students were added once');

-- ------------------------------------------------------------- cancelled while the payer was paying
select create_topup(:'sa', 1, 100000, pg_temp.topup_line(100000), 'f') as t3 \gset
select reference as r3 from subscription_topups where id = :'t3' \gset
select reference as c1 from paystack_begin_topup(:'alpha', :'r3', 'a@b.co') \gset
select cancel_topup(:'t3', 'finance@example.com', 'asked for the wrong number');
select pg_temp.assert(paystack_record_charge(:'c1', '7001', 100000, 'NGN') = 'needs_review', 'a payment for a cancelled top-up is held');
select pg_temp.assert((select note like '%top-up was cancelled%' from paystack_payments where reference = :'c1'), 'the note says it was cancelled');
select pg_temp.assert((select status = 'cancelled' from subscription_topups where id = :'t3'), 'the top-up stays cancelled');
select pg_temp.assert(pg_temp.err(format($q$select * from paystack_begin_topup(%L, %L, 'a@b.co')$q$, :'alpha', :'r3')) like '%is cancelled and cannot be paid%', 'a cancelled top-up cannot start a checkout');

-- ------------------------------------------------------------- the session has ended / the school is not active
select create_topup(:'sa', 1, 100000, pg_temp.topup_line(100000), 'f') as t4 \gset
select reference as r4 from subscription_topups where id = :'t4' \gset
update schools set status = 'suspended' where id = :'alpha';
select pg_temp.assert(pg_temp.err(format($q$select * from paystack_begin_topup(%L, %L, 'a@b.co')$q$, :'alpha', :'r4')) like '%active school%', 'a suspended school cannot start a top-up checkout');
update schools set status = 'active' where id = :'alpha';
-- an invoice that was already open when the session ended
select reference as e1 from paystack_begin_topup(:'alpha', :'r4', 'a@b.co') \gset
update subscriptions set valid_until = now() - interval '20 days', grace_until = now() - interval '1 day' where id = :'sa';
select pg_temp.assert(pg_temp.err(format($q$select * from paystack_begin_topup(%L, %L, 'a@b.co')$q$, :'alpha', :'r4')) like '%session has ended%', 'a top-up cannot be started after the session ended');

-- ------------------------------------------------------------- the invoice path is untouched
select create_subscription(:'beta', '2026/2027', 300, 0, 15000000, now() + interval '200 days', now() + interval '214 days', '[]', pg_temp.quote(15000000), 'f') as sb \gset
select reference as rb from subscriptions where id = :'sb' \gset
select reference as pb from paystack_begin(:'beta', :'rb', 'a@b.co') \gset
select pg_temp.assert((select topup_id is null from paystack_payments where reference = :'pb'), 'an invoice checkout has no top-up');
select pg_temp.assert(paystack_record_charge(:'pb', '8001', 15000000, 'NGN') = 'applied', 'an invoice charge is still applied');
select pg_temp.assert((select status = 'paid' and method = 'paystack' from subscriptions where id = :'sb'), 'and the invoice is paid by card');
select pg_temp.assert(pg_temp.err(format($q$select * from paystack_begin(%L, %L, 'a@b.co')$q$, :'alpha', :'r1')) like '%no invoice with that reference%', 'a top-up reference is not an invoice reference');

-- ------------------------------------------------------------- access
reset role;
set local role authenticated;
select pg_temp.assert(pg_temp.err(format($q$select * from paystack_begin_topup(%L, %L, 'a@b.co')$q$, :'alpha', :'r4')) like '%permission denied%', 'a signed-in dashboard user cannot call it directly');
reset role;
set local role anon;
select pg_temp.assert(pg_temp.err(format($q$select * from paystack_begin_topup(%L, %L, 'a@b.co')$q$, :'alpha', :'r4')) like '%permission denied%', 'the public cannot call it');
reset role;

rollback;
\echo ALL PAYSTACK TOP-UP SQL TESTS PASSED
