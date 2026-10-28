-- M6: proof path checks on claims, and card payments through Paystack.
\set ON_ERROR_STOP on
create or replace function pg_temp.assert(ok boolean, msg text) returns void language plpgsql as $$
begin
  if not coalesce(ok, false) then raise exception 'FAILED: %', msg; end if;
end $$;
create or replace function pg_temp.fails(stmt text) returns boolean language plpgsql as $$
begin
  execute stmt;
  return false;
exception when others then
  return true;
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

begin;
set local role service_role;

insert into schools (slug, name, status, hostnames, supabase_project_ref) values
  ('alpha', 'Alpha Academy', 'active', '{alpha.example.com}', 'refalpha'),
  ('beta', 'Beta College', 'active', '{beta.example.com}', 'refbeta');
select id as alpha from schools where slug = 'alpha' \gset
select id as beta from schools where slug = 'beta' \gset

-- ------------------------------------------------------------- proof paths
select create_subscription(:'alpha', '2026/2027', 300, 0, 15000000, now() + interval '200 days', now() + interval '214 days', '[]', pg_temp.quote(15000000), 'f') as sa \gset
select reference as ra from subscriptions where id = :'sa' \gset

select pg_temp.assert(pg_temp.err(format($q$select submit_claim(%L, %L, 'client-ref-c1', 15000000, current_date, 'A. Bursar', null, 'proofs/beta/123e4567-e89b-42d3-a456-426614174000.jpg', 'b@alpha.example')$q$, :'alpha', :'ra')) = 'That is not a proof uploaded for this school.', 'another school''s proof path is refused');
select pg_temp.assert(pg_temp.fails(format($q$select submit_claim(%L, %L, 'client-ref-c2', 15000000, current_date, 'A. Bursar', null, 'proofs/alpha/a.jpg', 'b@alpha.example')$q$, :'alpha', :'ra')), 'a made-up name is refused');
select pg_temp.assert(pg_temp.fails(format($q$select submit_claim(%L, %L, 'client-ref-c3', 15000000, current_date, 'A. Bursar', null, 'proofs/alpha/../beta/123e4567-e89b-42d3-a456-426614174000.jpg', 'b@alpha.example')$q$, :'alpha', :'ra')), 'a traversal is refused');
select pg_temp.assert(pg_temp.fails(format($q$select submit_claim(%L, %L, 'client-ref-c4', 15000000, current_date, 'A. Bursar', null, 'proofs/alpha/123e4567-e89b-42d3-a456-426614174000.exe', 'b@alpha.example')$q$, :'alpha', :'ra')), 'a wrong extension is refused');
select pg_temp.assert((select status from subscriptions where id = :'sa') = 'pending', 'refused claims leave the invoice open');
select submit_claim(:'alpha', :'ra', 'client-ref-c5', 15000000, current_date, 'A. Bursar', null, 'proofs/alpha/123e4567-e89b-42d3-a456-426614174000.pdf', 'b@alpha.example') as claim1 \gset
select pg_temp.assert((select proof_path = 'proofs/alpha/123e4567-e89b-42d3-a456-426614174000.pdf' from payment_claims where id = :'claim1'), 'the school''s own proof path is kept');
select pg_temp.assert(submit_claim(:'alpha', :'ra', 'client-ref-c5', 15000000, current_date, 'A. Bursar', null, null, 'b@alpha.example') = :'claim1', 'sending the same claim again returns the same claim');
select reject_claim(:'claim1', 'finance@example.com', 'sent in error');

-- --------------------------------------------------------- paystack_begin
select pg_temp.assert(pg_temp.err(format($q$select * from paystack_begin(%L, %L, 'not-an-email')$q$, :'alpha', :'ra')) like '%valid email%', 'a bad email is refused');
select pg_temp.assert(pg_temp.err(format($q$select * from paystack_begin(%L, 'SUB-00000000', 'a@b.co')$q$, :'alpha')) like '%no invoice with that reference%', 'an unknown invoice is refused');
select pg_temp.assert(pg_temp.err(format($q$select * from paystack_begin(%L, %L, 'a@b.co')$q$, :'beta', :'ra')) like '%no invoice with that reference%', 'another school''s invoice is refused');
select reference as pref, amount_kobo as pamt from paystack_begin(:'alpha', :'ra', 'bursar@alpha.example') \gset
select pg_temp.assert(:'pref' ~ '^PSK-[0-9A-F]{16}$' and :pamt = 15000000, 'a checkout gets its own reference and the invoice''s amount');
select pg_temp.assert((select status = 'initiated' and payer_email = 'bursar@alpha.example' from paystack_payments where reference = :'pref'), 'the row waits as initiated');

-- a transfer claim waiting blocks a new checkout
select submit_claim(:'alpha', :'ra', 'client-ref-c6', 15000000, current_date, 'A. Bursar', null, null, 'b@alpha.example') as claim2 \gset
select pg_temp.assert(pg_temp.err(format($q$select * from paystack_begin(%L, %L, 'a@b.co')$q$, :'alpha', :'ra')) like '%already waiting to be confirmed%', 'a waiting claim blocks a checkout');

-- ------------------------------------------------ a charge while a claim waits
select license_version as v0 from schools where id = :'alpha' \gset
select pg_temp.assert(paystack_record_charge(:'pref', '4099260516', 15000000, 'NGN') = 'applied', 'a matching charge is applied even while a transfer claim waits');
select pg_temp.assert((select status = 'paid' and method = 'paystack' and payment_ref = :'pref' and paid_at is not null from subscriptions where id = :'sa'), 'the invoice is paid by card with Paystack''s reference');
select pg_temp.assert((select status = 'rejected' and decided_by = 'system:paystack' and decision_reason like '%paid by card%' from payment_claims where id = :'claim2'), 'the waiting claim is closed with the reason');
select pg_temp.assert((select status = 'applied' and paystack_id = '4099260516' and paid_amount_kobo = 15000000 from paystack_payments where reference = :'pref'), 'the payment row is applied');
select pg_temp.assert((select license_version = :v0 + 1 and license_session = '2026/2027' and license_valid_until > now() from schools where id = :'alpha'), 'the licence is raised to a new version');
select pg_temp.assert((select count(*) from jobs where type = 'license_push' and school_id = :'alpha') = 1, 'and a licence push is queued');
select pg_temp.assert(paystack_record_charge(:'pref', '4099260516', 15000000, 'NGN') = 'duplicate', 'the same charge again is a duplicate');
select pg_temp.assert((select license_version from schools where id = :'alpha') = :v0 + 1, 'a duplicate changes nothing');
select pg_temp.assert(paystack_record_charge('PSK-FFFFFFFFFFFFFFFF', '1', 100, 'NGN') = 'unknown', 'a reference that is not ours is unknown, not an error');
select pg_temp.assert(pg_temp.fails($q$select paystack_record_charge('PSK-FFFFFFFFFFFFFFFF', '', 100, 'NGN')$q$), 'a charge without an id is refused');
select pg_temp.assert(pg_temp.err(format($q$select * from paystack_begin(%L, %L, 'a@b.co')$q$, :'alpha', :'ra')) like '%already been paid%', 'a paid invoice cannot start a checkout');

-- --------------------------------------------- wrong amount, wrong currency
select create_subscription(:'beta', '2026/2027', 300, 0, 15000000, now() + interval '200 days', now() + interval '214 days', '[]', pg_temp.quote(15000000), 'f') as sb \gset
select reference as rb from subscriptions where id = :'sb' \gset
select reference as pref2 from paystack_begin(:'beta', :'rb', 'bursar@beta.example') \gset
select license_version as vb from schools where id = :'beta' \gset
select pg_temp.assert(paystack_record_charge(:'pref2', '555', 14999999, 'NGN') = 'needs_review', 'a short payment needs review');
select pg_temp.assert((select status = 'pending' from subscriptions where id = :'sb'), 'and the invoice stays open');
select pg_temp.assert((select status = 'needs_review' and paid_amount_kobo = 14999999 and note like '%invoice was NGN 150000.00%' from paystack_payments where reference = :'pref2'), 'the row says what was paid and what was invoiced');
select pg_temp.assert((select license_version = :vb from schools where id = :'beta'), 'no licence change');
select pg_temp.assert((select payload ->> 'kind' = 'paystack_review' and payload ->> 'message' like '%Beta College%' and payload ->> 'message' like '%' || :'rb' || '%' from jobs where type = 'telegram_notify' and school_id = :'beta' order by created_at desc limit 1), 'a notice is queued naming the school and invoice');
select pg_temp.assert(paystack_record_charge(:'pref2', '555', 14999999, 'NGN') = 'duplicate', 'the same needs-review charge again is a duplicate, with no second notice');
select pg_temp.assert((select count(*) from jobs where type = 'telegram_notify' and school_id = :'beta') = 1, 'only one notice');

select reference as pref3 from paystack_begin(:'beta', :'rb', 'bursar@beta.example') \gset
select pg_temp.assert(paystack_record_charge(:'pref3', '556', 15000000, 'USD') = 'needs_review', 'the wrong currency needs review');
select pg_temp.assert((select note like 'Paystack reported USD%' from paystack_payments where reference = :'pref3'), 'and says so');

-- two checkouts open at once: the first charge pays, the second is money to look at
select reference as pref4 from paystack_begin(:'beta', :'rb', 'bursar@beta.example') \gset
select reference as pref5 from paystack_begin(:'beta', :'rb', 'bursar@beta.example') \gset
select pg_temp.assert(paystack_record_charge(:'pref4', '557', 15000000, 'NGN') = 'applied', 'a correct charge after earlier bad ones is applied');
select pg_temp.assert(paystack_record_charge(:'pref5', '559', 15000000, 'NGN') = 'needs_review', 'a second charge for a paid invoice needs review');
select pg_temp.assert((select note = 'The invoice was paid when the card payment arrived.' from paystack_payments where reference = :'pref5'), 'and the note says why');
select pg_temp.assert((select count(*) from subscriptions where school_id = :'beta' and status = 'paid') = 1, 'the invoice is still paid once');

-- an invoice cancelled while the payer was on the Paystack page
select create_subscription(:'beta', '2027/2028', 300, 0, 15000000, now() + interval '500 days', now() + interval '514 days', '[]', pg_temp.quote(15000000), 'f') as sb2 \gset
select reference as rb2 from subscriptions where id = :'sb2' \gset
select reference as pref6 from paystack_begin(:'beta', :'rb2', 'bursar@beta.example') \gset
update subscriptions set status = 'cancelled' where id = :'sb2';
select pg_temp.assert(paystack_record_charge(:'pref6', '560', 15000000, 'NGN') = 'needs_review', 'a charge for a cancelled invoice needs review');
select pg_temp.assert((select status = 'cancelled' from subscriptions where id = :'sb2'), 'and the invoice stays cancelled');

-- a school suspended for a lapse is lifted by a card payment
select create_subscription(:'alpha', '2027/2028', 300, 0, 15000000, now() + interval '500 days', now() + interval '514 days', '[]', pg_temp.quote(15000000), 'f') as sa2 \gset
select reference as ra2 from subscriptions where id = :'sa2' \gset
select reference as pref7 from paystack_begin(:'alpha', :'ra2', 'bursar@alpha.example') \gset
update schools set status = 'suspended', suspended_reason = 'lapsed', suspended_at = now() where id = :'alpha';
select paystack_record_charge(:'pref7', '561', 15000000, 'NGN');
select pg_temp.assert((select status = 'active' and suspended_reason is null from schools where id = :'alpha'), 'a card payment lifts an automatic suspension');

-- ---------------------------------------------------------------- resolving
select id as review from paystack_payments where reference = :'pref2' \gset
select pg_temp.assert(pg_temp.fails(format($q$select resolve_paystack_review(%L, 'o', '')$q$, :'review')), 'resolving needs a note');
select pg_temp.assert(pg_temp.fails(format($q$select resolve_paystack_review(%L, 'o', 'x')$q$, (select id from paystack_payments where reference = :'pref4'))), 'a payment that was applied cannot be resolved');
select resolve_paystack_review(:'review', 'owner@example.com', 'refunded the difference from the Paystack dashboard');
select pg_temp.assert((select status = 'resolved' and resolved_by = 'owner@example.com' and resolution like 'refunded%' and resolved_at is not null from paystack_payments where id = :'review'), 'resolving records who and what');
select pg_temp.assert(pg_temp.fails(format($q$select resolve_paystack_review(%L, 'o', 'again')$q$, :'review')), 'and only once');
select pg_temp.assert(paystack_record_charge(:'pref2', '555', 14999999, 'NGN') = 'duplicate', 'a resolved payment stays a duplicate');

-- -------------------------------------------------------------- permissions
reset role;
set local role authenticated;
select pg_temp.assert(pg_temp.fails($q$select * from paystack_begin(gen_random_uuid(), 'SUB-00000000', 'a@b.co')$q$), 'a signed-in user cannot start a checkout');
select pg_temp.assert(pg_temp.fails($q$select paystack_record_charge('PSK-FFFFFFFFFFFFFFFF', '1', 1, 'NGN')$q$), 'nor record a charge');
select pg_temp.assert(pg_temp.fails($q$select resolve_paystack_review(gen_random_uuid(), 'x', 'x')$q$), 'nor resolve one');
select pg_temp.assert(pg_temp.fails($q$select submit_claim(gen_random_uuid(), 'SUB-00000000', 'x', 1, current_date, 'x', null, null, 'x')$q$), 'nor submit a claim');
select pg_temp.assert(pg_temp.fails($q$select kobo_as_naira(100)$q$), 'nor call the money helper');
reset role;
set local role anon;
select pg_temp.assert(pg_temp.fails($q$select count(*) from paystack_payments$q$), 'anon cannot read card payments');
reset role;

rollback;
\echo ALL M6 SQL TESTS PASSED
