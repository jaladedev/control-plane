-- M2 billing core and M2b transfer claims.
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

begin;
set local role service_role;

insert into schools (slug, name, status, hostnames, supabase_project_ref) values
  ('alpha', 'Alpha', 'active', '{alpha.example.com}', 'refalpha'),
  ('beta', 'Beta', 'active', '{beta.example.com}', 'refbeta'),
  ('paused', 'Paused', 'suspended', '{p.example.com}', 'refp');
select id as alpha from schools where slug = 'alpha' \gset
select id as beta from schools where slug = 'beta' \gset
select id as paused from schools where slug = 'paused' \gset

-- ------------------------------------------------------------ price catalog
select pg_temp.assert(not pg_temp.fails($q$select set_price('base_fee', 15000000, null, null, 'launch price', 'o')$q$), 'a price can be set');
select pg_temp.assert(not pg_temp.fails($q$select set_price('included_students', null, 300, null, 'launch', 'o')$q$), 'included_students is a count');
select pg_temp.assert(not pg_temp.fails($q$select set_price('feature:sms_alerts', 500000, null, null, 'launch', 'o')$q$), 'a feature price is allowed');
select pg_temp.assert(pg_temp.fails($q$select set_price('base_fee', null, 5, null, 'x', 'o')$q$), 'an amount item cannot be a count');
select pg_temp.assert(pg_temp.fails($q$select set_price('included_students', 100, null, null, 'x', 'o')$q$), 'the count item cannot be an amount');
select pg_temp.assert(pg_temp.fails($q$select set_price('base_fee', -1, null, null, 'x', 'o')$q$), 'prices are not negative');
select pg_temp.assert(pg_temp.fails($q$select set_price('coffee', 100, null, null, 'x', 'o')$q$), 'unknown items are refused');
select pg_temp.assert(pg_temp.fails($q$select set_price('feature:Bad Name', 100, null, null, 'x', 'o')$q$), 'feature keys are checked');
select pg_temp.assert(pg_temp.fails($q$select set_price('base_fee', 100, null, null, '  ', 'o')$q$), 'a reason is required');
select pg_temp.assert(pg_temp.fails($q$update price_catalog set amount_kobo = 1$q$), 'prices cannot be edited');
select pg_temp.assert(pg_temp.fails($q$delete from price_catalog$q$), 'prices cannot be deleted');

-- ----------------------------------------------------------------- overrides
select pg_temp.assert(not pg_temp.fails(format($q$select set_price_override(%L, 'base_fee', '2026/2027', null, 20, 'sister school', 'o')$q$, :'alpha')), 'a percentage override is allowed');
select pg_temp.assert(not pg_temp.fails(format($q$select set_price_override(%L, 'base_fee', '2026/2027', 12000000, null, 'negotiated', 'o')$q$, :'alpha')), 'a fixed-price override is allowed');
select pg_temp.assert(pg_temp.fails(format($q$select set_price_override(%L, 'base_fee', '2026/2027', 100, 10, 'x', 'o')$q$, :'alpha')), 'an override is either an amount or a percentage');
select pg_temp.assert(pg_temp.fails(format($q$select set_price_override(%L, 'base_fee', '2026/2027', null, null, 'x', 'o')$q$, :'alpha')), 'an override needs one of them');
select pg_temp.assert(pg_temp.fails(format($q$select set_price_override(%L, 'included_students', '2026/2027', 100, null, 'x', 'o')$q$, :'alpha')), 'the student allowance has no override');
select pg_temp.assert(pg_temp.fails(format($q$select set_price_override(%L, 'base_fee', '2026/2027', null, 101, 'x', 'o')$q$, :'alpha')), 'over 100 percent is refused');
select pg_temp.assert(pg_temp.fails($q$update school_price_overrides set percent_off = 1$q$), 'overrides cannot be edited');

-- --------------------------------------------------------------- invoices
create or replace function pg_temp.quote(total bigint) returns jsonb language sql as $$
  select jsonb_build_object('lines', jsonb_build_array(
    jsonb_build_object('item', 'base_fee', 'total_kobo', total - 500000),
    jsonb_build_object('item', 'feature:sms_alerts', 'total_kobo', 500000)))
$$;
select create_subscription(:'alpha', '2026/2027', 300, 20, 15000000,
  now() + interval '200 days', now() + interval '214 days',
  '[{"feature":"sms_alerts","amount_kobo":500000}]'::jsonb, pg_temp.quote(15000000), 'finance@example.com') as s1 \gset
select pg_temp.assert((select reference ~ '^SUB-[0-9A-F]{8}$' and status = 'pending' and amount_kobo = 15000000 and extra_students = 20 from subscriptions where id = :'s1'), 'an invoice is created pending with a reference');
select pg_temp.assert((select count(*) from subscription_items where subscription_id = :'s1') = 1, 'its add-on lines are kept');
select reference as ref1 from subscriptions where id = :'s1' \gset

select pg_temp.assert(pg_temp.err(format($q$select create_subscription(%L, '2026/2027', 300, 0, 1, now() + interval '10 days', now() + interval '20 days', '[]', pg_temp.quote(1), 'x')$q$, :'alpha')) like '%already has an open invoice%', 'one open invoice per school and session');
select pg_temp.assert(pg_temp.err(format($q$select create_subscription(%L, '2026/2027', 300, 0, 999, now() + interval '10 days', now() + interval '20 days', '[]', pg_temp.quote(15000000), 'x')$q$, :'beta')) like '%does not match its lines%', 'a total that does not match its lines is refused');
select pg_temp.assert(pg_temp.err(format($q$select create_subscription(%L, '2026/2027', 300, 0, 15000000, now() + interval '10 days', now() + interval '20 days', '[]', pg_temp.quote(15000000), 'x')$q$, :'paused')) like '%active school%', 'only an active school is invoiced');
select pg_temp.assert(pg_temp.err(format($q$select create_subscription(%L, '2026/2027', 300, 0, 15000000, now() - interval '1 day', now() + interval '20 days', '[]', pg_temp.quote(15000000), 'x')$q$, :'beta')) like '%in the past%', 'a past valid-until is refused');
select pg_temp.assert(pg_temp.fails(format($q$select create_subscription(%L, '2026/2027', 300, 0, 15000000, now() + interval '20 days', now() + interval '10 days', '[]', pg_temp.quote(15000000), 'x')$q$, :'beta')), 'grace cannot end before the licence');
select pg_temp.assert(pg_temp.err(format($q$select create_subscription(gen_random_uuid(), '2026/2027', 300, 0, 15000000, now() + interval '10 days', now() + interval '20 days', '[]', pg_temp.quote(15000000), 'x')$q$)) like '%does not exist%', 'unknown school');

-- cancel
select create_subscription(:'beta', '2026/2027', 300, 0, 15000000, now() + interval '200 days', now() + interval '214 days', '[]', pg_temp.quote(15000000), 'f') as s2 \gset
select pg_temp.assert(pg_temp.fails(format($q$select cancel_subscription(%L, 'o', '')$q$, :'s2')), 'cancelling needs a reason');
select cancel_subscription(:'s2', 'owner@example.com', 'wrong session');
select pg_temp.assert((select status from subscriptions where id = :'s2') = 'cancelled', 'a pending invoice can be cancelled');
select pg_temp.assert(pg_temp.fails(format($q$select cancel_subscription(%L, 'o', 'again')$q$, :'s2')), 'a cancelled invoice cannot be cancelled again');
select pg_temp.assert(not pg_temp.fails(format($q$select create_subscription(%L, '2026/2027', 300, 0, 15000000, now() + interval '200 days', now() + interval '214 days', '[]', pg_temp.quote(15000000), 'f')$q$, :'beta')), 'a cancelled invoice frees the session for a new one');
select id as s3 from subscriptions where school_id = :'beta' and status = 'pending' \gset
select reference as ref3 from subscriptions where id = :'s3' \gset

-- ------------------------------------------------------------------ claims
select submit_claim(:'alpha', :'ref1', 'client-ref-0001', 15000000, current_date, 'Bursar A', 'NIP123', 'proofs/alpha/123e4567-e89b-42d3-a456-426614174000.jpg', 'bursar@alpha.example') as c1 \gset
select pg_temp.assert((select status = 'pending' and amount_kobo = 15000000 and claimed_by = 'bursar@alpha.example' from payment_claims where id = :'c1'), 'a claim is recorded pending');
select pg_temp.assert((select status from subscriptions where id = :'s1') = 'pending_confirmation', 'and the invoice waits for confirmation');
select pg_temp.assert((select count(*) from jobs where type = 'telegram_notify' and payload ->> 'kind' = 'claim' and payload ->> 'claim_id' = :'c1') = 1, 'a Telegram notice is queued');
select pg_temp.assert(submit_claim(:'alpha', :'ref1', 'client-ref-0001', 15000000, current_date, 'Bursar A', null, null, 'x') = :'c1'::uuid, 'the same client_ref returns the same claim (a retry)');
select pg_temp.assert((select count(*) from payment_claims) = 1, 'and creates no second claim');
select pg_temp.assert((select count(*) from jobs where type = 'telegram_notify') = 1, 'nor a second notice');
select pg_temp.assert(pg_temp.err(format($q$select submit_claim(%L, %L, 'client-ref-0002', 15000000, current_date, 'B', null, null, 'x')$q$, :'alpha', :'ref1')) like '%already waiting%', 'a second claim for the same invoice is refused');
select pg_temp.assert(pg_temp.err(format($q$select submit_claim(%L, %L, 'client-ref-0003', 15000000, current_date, 'B', null, null, 'x')$q$, :'alpha', :'ref3')) like '%no invoice with that reference%', 'a school cannot claim another school''s invoice');
select pg_temp.assert(pg_temp.err(format($q$select submit_claim(%L, 'SUB-00000000', 'client-ref-0004', 100, current_date, 'B', null, null, 'x')$q$, :'beta')) like '%no invoice with that reference%', 'an unknown reference is refused');
select pg_temp.assert(pg_temp.err(format($q$select submit_claim(%L, %L, 'client-ref-0005', 100, current_date + 10, 'B', null, null, 'x')$q$, :'beta', :'ref3')) like '%date%', 'a future payment date is refused');
select pg_temp.assert(pg_temp.err(format($q$select submit_claim(%L, %L, 'client-ref-0006', 100, current_date - 200, 'B', null, null, 'x')$q$, :'beta', :'ref3')) like '%date%', 'a very old payment date is refused');
select pg_temp.assert(pg_temp.fails(format($q$select submit_claim(%L, %L, 'client-ref-0007', 0, current_date, 'B', null, null, 'x')$q$, :'beta', :'ref3')), 'a zero amount is refused');
select pg_temp.assert(pg_temp.fails(format($q$select submit_claim(%L, %L, 'short', 100, current_date, 'B', null, null, 'x')$q$, :'beta', :'ref3')), 'a too-short client_ref is refused');

-- reject then claim again
select pg_temp.assert(pg_temp.fails(format($q$select reject_claim(%L, 'o', '')$q$, :'c1')), 'rejecting needs a reason');
select reject_claim(:'c1', 'owner@example.com', 'not on the statement');
select pg_temp.assert((select status = 'rejected' and decided_by = 'owner@example.com' and decision_reason = 'not on the statement' from payment_claims where id = :'c1'), 'a rejected claim keeps who and why');
select pg_temp.assert((select status from subscriptions where id = :'s1') = 'pending', 'and the invoice is open again');
select pg_temp.assert(pg_temp.fails($q$update payment_claims set status = 'confirmed'$q$), 'a decided claim cannot be changed');
select pg_temp.assert(pg_temp.fails($q$delete from payment_claims$q$), 'a claim cannot be deleted');
select pg_temp.assert(pg_temp.fails(format($q$select reject_claim(%L, 'o', 'again')$q$, :'c1')), 'a rejected claim cannot be rejected again');
select submit_claim(:'alpha', :'ref1', 'client-ref-0008', 15000000, current_date, 'Bursar A', 'NIP999', null, 'bursar@alpha.example') as c2 \gset

-- confirm
select pg_temp.assert(pg_temp.fails(format($q$select confirm_claim(%L, 15000000, 'o', '')$q$, :'c2')), 'confirming needs a reason');
select pg_temp.assert(pg_temp.err(format($q$select confirm_claim(%L, 14000000, 'o', 'checked')$q$, :'c2')) like '%does not match the invoice%', 'the amount must equal the invoice');
select pg_temp.assert((select license_version from schools where id = :'alpha') = 0, 'nothing has touched the licence yet');
select confirm_claim(:'c2', 15000000, 'finance@example.com', 'statement line 41');
select pg_temp.assert((select status = 'confirmed' and confirmed_amount_kobo = 15000000 and decided_by = 'finance@example.com' from payment_claims where id = :'c2'), 'the claim is confirmed with who and the amount');
select pg_temp.assert((select status = 'paid' and method = 'transfer' and payment_ref = 'NIP999' and paid_at is not null from subscriptions where id = :'s1'), 'the invoice is paid by transfer, with the payer''s reference');
select pg_temp.assert((select license_version = 1 and license_session = '2026/2027' and not license_is_trial and included_students = 320 and features = array['sms_alerts'] and license_valid_until is not null from schools where id = :'alpha'), 'the registry licence follows the invoice: cap, add-ons, dates, next version');
select pg_temp.assert((select count(*) from jobs where type = 'license_push' and school_id = :'alpha'::uuid and status = 'queued') = 1, 'and a licence push is queued');
select pg_temp.assert(pg_temp.fails(format($q$select confirm_claim(%L, 15000000, 'o', 'twice')$q$, :'c2')), 'a confirmed claim cannot be confirmed again');
select pg_temp.assert(pg_temp.err(format($q$select create_subscription(%L, '2026/2027', 300, 0, 15000000, now() + interval '200 days', now() + interval '214 days', '[]', pg_temp.quote(15000000), 'f')$q$, :'alpha')) like '%already paid%', 'a school cannot be invoiced twice for a paid session');

-- mark paid without a claim
select pg_temp.assert(not pg_temp.fails(format($q$select submit_claim(%L, %L, 'client-ref-0009', 15000000, current_date, 'B', null, null, 'x')$q$, :'beta', :'ref3')), 'beta claims its invoice');
select pg_temp.assert(pg_temp.err(format($q$select mark_subscription_paid(%L, 'REF', 'o', 'seen in bank')$q$, :'s3')) like '%claim is waiting%', 'a waiting claim must be decided, not bypassed');
select reject_claim(id, 'o', 'wrong amount') from payment_claims where school_id = :'beta';
select pg_temp.assert(pg_temp.fails(format($q$select mark_subscription_paid(%L, 'REF', 'o', ' ')$q$, :'s3')), 'marking paid needs a reason');
select mark_subscription_paid(:'s3', '', 'owner@example.com', 'cash at the office');
select pg_temp.assert((select status = 'paid' and payment_ref = reference from subscriptions where id = :'s3'), 'with no payer reference it falls back to the invoice reference');
select pg_temp.assert((select license_version from schools where id = :'beta') = 1, 'and the licence follows');
select pg_temp.assert(pg_temp.fails(format($q$select mark_subscription_paid(%L, 'x', 'o', 'again')$q$, :'s3')), 'a paid invoice cannot be marked paid again');

-- extend
select pg_temp.assert(pg_temp.fails(format($q$select extend_subscription(%L, now() + interval '300 days', now() + interval '314 days', 'o', '')$q$, :'s1')), 'extending needs a reason');
select pg_temp.assert(pg_temp.err(format($q$select extend_subscription(%L, now() + interval '100 days', now() + interval '120 days', 'o', 'x')$q$, :'s1')) like '%later than the current%', 'extending only moves the date later');
select pg_temp.assert(pg_temp.err(format($q$select extend_subscription(%L, now() + interval '300 days', now() + interval '200 days', 'o', 'x')$q$, :'s1')) like '%Grace cannot end before%', 'grace cannot end before the licence');
select extend_subscription(:'s1', now() + interval '300 days', now() + interval '314 days', 'owner@example.com', 'goodwill while the transfer clears');
select pg_temp.assert((select license_version = 2 from schools where id = :'alpha'), 'an extension makes the next licence version');
select pg_temp.assert((select count(*) from jobs where type = 'license_push' and school_id = :'alpha'::uuid) = 2, 'and queues another push');
select pg_temp.assert(pg_temp.fails(format($q$select extend_subscription(%L, now() + interval '400 days', now() + interval '414 days', 'o', 'x')$q$, :'s2')), 'a cancelled invoice cannot be extended');

-- licence push outcome
select record_license_push(:'alpha', 1, true, null);
select pg_temp.assert((select license_pushed_version = 1 and license_push_error is null from schools where id = :'alpha'), 'a successful push records the version the school accepted');
select record_license_push(:'alpha', 99, true, null);
select pg_temp.assert((select license_pushed_version = 2 from schools where id = :'alpha'), 'the pushed version never passes the saved one');
select record_license_push(:'alpha', 2, false, 'school unreachable');
select pg_temp.assert((select license_push_error = 'school unreachable' from schools where id = :'alpha'), 'a failed push records why');

-- reminders
select pg_temp.assert(enqueue_claim_reminders() = 0, 'a claim under 48 hours old gets no reminder');
reset role;
-- an old pending claim (age it directly: the trigger only guards decided claims)
update schools set status = 'active' where slug = 'paused';
set local role service_role;
select create_subscription(:'paused', '2026/2027', 100, 0, 7000000, now() + interval '90 days', now() + interval '104 days', '[]', pg_temp.quote(7000000), 'f') as s4 \gset
select reference as ref4 from subscriptions where id = :'s4' \gset
select submit_claim(:'paused', :'ref4', 'client-ref-0010', 7000000, current_date, 'B', null, null, 'x') as c4 \gset
update payment_claims set created_at = now() - interval '50 hours' where id = :'c4';
select pg_temp.assert(enqueue_claim_reminders() = 1, 'a claim waiting over 48 hours gets a reminder');
select pg_temp.assert(enqueue_claim_reminders() = 0, 'only one reminder is queued');
select mark_claim_notified(:'c4', 'reminder');
update jobs set status = 'succeeded' where payload ->> 'kind' = 'reminder';
select pg_temp.assert(enqueue_claim_reminders() = 0, 'and none once it has been sent');
select pg_temp.assert((select reminded_at is not null and notified_at is null from payment_claims where id = :'c4'), 'the reminder is stamped');
select pg_temp.assert((select school_name = 'Paused' and reference = :'ref4' and amount_kobo = 7000000 and status = 'pending' from claim_for_notice(:'c4')), 'claim_for_notice gives the notice its facts in one row');
select pg_temp.assert((select count(*) from claim_for_notice(gen_random_uuid())) = 0, 'and nothing for an unknown claim');
select mark_claim_notified(:'c4', 'claim');
select pg_temp.assert((select notified_at is not null from payment_claims where id = :'c4'), 'the first notice is stamped');
select pg_temp.assert(pg_temp.fails(format($q$select mark_claim_notified(%L, 'sms')$q$, :'c4')), 'unknown notice kinds are refused');

-- signing keys
select add_school_signing_key(:'alpha', repeat('A', 43), 'owner@example.com') as k1 \gset
select pg_temp.assert(pg_temp.err(format($q$select add_school_signing_key(%L, %L, 'o')$q$, :'alpha', repeat('A', 43))) like '%already registered%', 'the same key cannot be added twice');
select pg_temp.assert(pg_temp.fails(format($q$select add_school_signing_key(%L, 'tooshort', 'o')$q$, :'alpha')), 'a key must be 32 bytes in base64url');
select add_school_signing_key(:'alpha', repeat('B', 43), 'owner@example.com');
select revoke_school_signing_key(:'k1');
select pg_temp.assert((select count(*) from school_signing_keys where school_id = :'alpha' and revoked_at is null) = 1, 'a revoked key stops counting, the new one stays');
select pg_temp.assert(pg_temp.fails(format($q$select revoke_school_signing_key(%L)$q$, :'k1')), 'a key cannot be revoked twice');

-- ----------------------------------------------------- who can see billing
reset role;
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'owner@t'), ('00000000-0000-0000-0000-0000000000a2', 'finance@t'), ('00000000-0000-0000-0000-0000000000a3', 'support@t');
insert into dashboard_users (id, email, role) values
  ('00000000-0000-0000-0000-0000000000a1', 'owner@t', 'owner'), ('00000000-0000-0000-0000-0000000000a2', 'finance@t', 'finance'), ('00000000-0000-0000-0000-0000000000a3', 'support@t', 'support');
select set_config('test.jwt', '{"aal":"aal2"}', true);

select set_config('test.uid', '00000000-0000-0000-0000-0000000000a3', true);
set local role authenticated;
select pg_temp.assert((select count(*) from subscriptions) = 0 and (select count(*) from payment_claims) = 0 and (select count(*) from price_catalog) = 0 and (select count(*) from school_price_overrides) = 0 and (select count(*) from subscription_items) = 0, 'support sees no billing data');
reset role;

select set_config('test.uid', '00000000-0000-0000-0000-0000000000a2', true);
set local role authenticated;
select pg_temp.assert((select count(*) from subscriptions) > 0 and (select count(*) from payment_claims) > 0 and (select count(*) from price_catalog) > 0, 'finance sees billing data');
select pg_temp.assert((select count(*) from school_signing_keys) = 0, 'finance does not see signing keys');
reset role;

select set_config('test.uid', '00000000-0000-0000-0000-0000000000a1', true);
set local role authenticated;
select pg_temp.assert((select count(*) from school_signing_keys) = 2, 'the owner sees signing keys');
select pg_temp.assert(pg_temp.fails($q$select confirm_claim(gen_random_uuid(), 1, 'x', 'x')$q$), 'even the owner cannot call confirm_claim directly');
select pg_temp.assert(pg_temp.fails($q$select * from claim_for_notice(gen_random_uuid())$q$), 'nor read claims through the worker function');
select pg_temp.assert(pg_temp.fails($q$select set_price('base_fee', 1, null, null, 'x', 'x')$q$), 'nor set a price directly');
select pg_temp.assert(pg_temp.fails($q$insert into subscriptions (school_id, session, reference, included_students, amount_kobo, valid_until, grace_until, quote, created_by) values (gen_random_uuid(), 's', 'SUB-AAAAAAAA', 1, 1, now(), now(), '{}', 'x')$q$), 'nor write a table directly');
reset role;

set local role anon;
select pg_temp.assert(pg_temp.fails($q$select count(*) from subscriptions$q$), 'anon cannot read invoices');
select pg_temp.assert(pg_temp.fails($q$select submit_claim(gen_random_uuid(), 'SUB-AAAAAAAA', 'client-ref-xxxx', 1, current_date, 'x', null, null, 'x')$q$), 'anon cannot submit a claim');
reset role;

rollback;
\echo ALL M2B SQL TESTS PASSED
