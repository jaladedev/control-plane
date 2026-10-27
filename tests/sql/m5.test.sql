-- M5 billing follow-ups: rate limiting, automatic suspension, top-ups, refunds.
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
create or replace function pg_temp.topup_line(unit bigint) returns jsonb language sql as $$
  select jsonb_build_object('item', 'extra_student', 'unit_kobo', unit)
$$;

begin;
set local role service_role;

-- --------------------------------------------------------------- rate limits
select pg_temp.assert(rate_limit_hit('t:a', 60, 3), 'the first hit is allowed');
select pg_temp.assert(rate_limit_hit('t:a', 60, 3), 'the second is allowed');
select pg_temp.assert(rate_limit_hit('t:a', 60, 3), 'the third is allowed');
select pg_temp.assert(not rate_limit_hit('t:a', 60, 3), 'the fourth is refused');
select pg_temp.assert(not rate_limit_hit('t:a', 60, 3), 'and so is the fifth');
select pg_temp.assert(rate_limit_hit('t:b', 60, 3), 'another bucket has its own count');
select pg_temp.assert(pg_temp.fails($q$select rate_limit_hit('t:c', 0, 3)$q$), 'a zero window is refused');
select pg_temp.assert(pg_temp.fails($q$select rate_limit_hit('t:c', 60, 0)$q$), 'a zero maximum is refused');
select pg_temp.assert(pg_temp.fails($q$select rate_limit_hit('t:c', 90000, 5)$q$), 'a window over a day is refused');

-- ------------------------------------------------------------ test schools
insert into schools (slug, name, status, hostnames, supabase_project_ref) values
  ('alpha', 'Alpha', 'active', '{alpha.example.com}', 'refalpha'),
  ('beta', 'Beta', 'active', '{beta.example.com}', 'refbeta'),
  ('gamma', 'Gamma', 'active', '{gamma.example.com}', 'refgamma'),
  ('delta', 'Delta', 'active', '{delta.example.com}', 'refdelta'),
  ('epsilon', 'Epsilon', 'active', '{epsilon.example.com}', 'refepsilon'),
  ('manual', 'Manual', 'suspended', '{manual.example.com}', 'refmanual'),
  ('nolicence', 'No licence', 'active', '{nl.example.com}', 'refnl');
select id as alpha from schools where slug = 'alpha' \gset
select id as beta from schools where slug = 'beta' \gset
select id as gamma from schools where slug = 'gamma' \gset
select id as delta from schools where slug = 'delta' \gset
select id as epsilon from schools where slug = 'epsilon' \gset
select id as manual from schools where slug = 'manual' \gset
select id as nolicence from schools where slug = 'nolicence' \gset

-- ------------------------------------------------------------ auto-suspend
update schools set license_valid_until = now() - interval '200 days', license_grace_until = now() - interval '100 days'
 where id in (:'gamma', :'delta', :'manual');
update schools set license_valid_until = now() - interval '30 days', license_grace_until = now() - interval '10 days'
 where id = :'epsilon';
-- delta has money in flight: an open invoice
insert into subscriptions (school_id, session, reference, included_students, amount_kobo, valid_until, grace_until, quote, created_by)
values (:'delta', '2026/2027', 'SUB-DEAD0001', 300, 1000, now() + interval '100 days', now() + interval '114 days', '{}', 'x');

select pg_temp.assert(pg_temp.fails($q$select * from suspend_lapsed_schools(3)$q$), 'a window under a week is refused');
select pg_temp.assert(pg_temp.fails($q$select * from suspend_lapsed_schools(400)$q$), 'a window over a year is refused');
select pg_temp.assert((select count(*) from suspend_lapsed_schools(30)) = 1, 'exactly one school is suspended');
select pg_temp.assert((select status = 'suspended' and suspended_reason = 'lapsed' and suspended_at is not null from schools where id = :'gamma'), 'the long-lapsed school is suspended by the lapse rule');
select pg_temp.assert((select status from schools where id = :'delta') = 'active', 'a school with an open invoice is left alone');
select pg_temp.assert((select status from schools where id = :'epsilon') = 'active', 'a school lapsed for less than the window is left alone');
select pg_temp.assert((select status from schools where id = :'nolicence') = 'active', 'a school with no licence is left alone');
select pg_temp.assert((select suspended_reason is null from schools where id = :'manual'), 'a manual suspension is untouched');
select pg_temp.assert((select count(*) from audit_log where action = 'school.auto_suspend' and school_id = :'gamma') = 1, 'the suspension is audited');
select pg_temp.assert((select count(*) from suspend_lapsed_schools(30)) = 0, 'running it again changes nothing');

-- a payment lifts a lapse suspension, not a manual one
update schools set status = 'suspended', suspended_reason = 'lapsed', suspended_at = now() where id = :'delta';
select id as sd from subscriptions where school_id = :'delta' \gset
select mark_subscription_paid(:'sd', 'NIP1', 'finance@example.com', 'seen on statement');
select pg_temp.assert((select status = 'active' and suspended_reason is null and suspended_at is null from schools where id = :'delta'), 'paying lifts an automatic suspension');
select pg_temp.assert((select count(*) from audit_log where action = 'school.auto_resume' and school_id = :'delta') = 1, 'and the resume is audited');
insert into subscriptions (school_id, session, reference, included_students, amount_kobo, valid_until, grace_until, quote, created_by)
values (:'manual', '2026/2027', 'SUB-DEAD0002', 300, 1000, now() + interval '100 days', now() + interval '114 days', '{}', 'x');
select id as sm from subscriptions where school_id = :'manual' \gset
select mark_subscription_paid(:'sm', 'NIP2', 'finance@example.com', 'seen on statement');
select pg_temp.assert((select status = 'suspended' from schools where id = :'manual'), 'paying does not lift a suspension an owner made by hand');

-- ------------------------------------------------------------------ top-ups
select create_subscription(:'alpha', '2026/2027', 300, 0, 15000000, now() + interval '200 days', now() + interval '214 days', '[]', pg_temp.quote(15000000), 'finance@example.com') as sa \gset
select pg_temp.assert(pg_temp.err(format($q$select create_topup(%L, 5, 500000, pg_temp.topup_line(100000), 'f')$q$, :'sa')) like '%needs a paid invoice%', 'a top-up needs a paid invoice');
select mark_subscription_paid(:'sa', 'NIP3', 'finance@example.com', 'seen on statement');
select license_version as v0 from schools where id = :'alpha' \gset
select pg_temp.assert(pg_temp.err(format($q$select create_topup(%L, 5, 123, pg_temp.topup_line(100000), 'f')$q$, :'sa')) like '%does not match its price line%', 'a total that is not quantity times price is refused');
select pg_temp.assert(pg_temp.fails(format($q$select create_topup(%L, 0, 0, pg_temp.topup_line(100000), 'f')$q$, :'sa')), 'zero students is refused');
select create_topup(:'sa', 5, 500000, pg_temp.topup_line(100000), 'finance@example.com') as t1 \gset
select pg_temp.assert((select reference ~ '^TOP-[0-9A-F]{8}$' and status = 'pending' and extra_students = 5 and amount_kobo = 500000 from subscription_topups where id = :'t1'), 'a top-up is created pending with its own reference');
select pg_temp.assert(pg_temp.err(format($q$select create_topup(%L, 2, 200000, pg_temp.topup_line(100000), 'f')$q$, :'sa')) like '%already has a top-up waiting%', 'one open top-up per invoice');
select pg_temp.assert((select extra_students from subscriptions where id = :'sa') = 0, 'nothing changes until it is paid');
select pg_temp.assert(pg_temp.fails(format($q$select mark_topup_paid(%L, 500000, 'x', 'f', '')$q$, :'t1')), 'paying needs a reason');
select pg_temp.assert(pg_temp.err(format($q$select mark_topup_paid(%L, 400000, 'x', 'f', 'seen')$q$, :'t1')) like '%does not match%', 'the amount received must equal the top-up');
select mark_topup_paid(:'t1', 500000, 'NIP4', 'finance@example.com', 'seen on statement');
select pg_temp.assert((select status = 'paid' and paid_by = 'finance@example.com' and payment_ref = 'NIP4' from subscription_topups where id = :'t1'), 'a paid top-up records who and the payment reference');
select pg_temp.assert((select extra_students = 5 and topup_kobo = 500000 from subscriptions where id = :'sa'), 'the invoice carries the extra students and the amount');
select pg_temp.assert((select included_students = 305 and license_version = :v0 + 1 from schools where id = :'alpha'), 'the school allowance goes up and a higher licence version is made');
select pg_temp.assert((select count(*) from jobs where type = 'license_push' and school_id = :'alpha') = 2, 'and a licence push is queued');
select pg_temp.assert(pg_temp.fails(format($q$select mark_topup_paid(%L, 500000, 'x', 'f', 'again')$q$, :'t1')), 'a paid top-up cannot be paid again');
select create_topup(:'sa', 3, 300000, pg_temp.topup_line(100000), 'finance@example.com') as t2 \gset
select pg_temp.assert(pg_temp.fails(format($q$select cancel_topup(%L, 'o', '')$q$, :'t2')), 'cancelling needs a reason');
select cancel_topup(:'t2', 'owner@example.com', 'asked in error');
select pg_temp.assert((select status = 'cancelled' from subscription_topups where id = :'t2'), 'a waiting top-up can be cancelled');
select pg_temp.assert(pg_temp.fails(format($q$select cancel_topup(%L, 'o', 'again')$q$, :'t1')), 'a paid top-up cannot be cancelled');

-- ------------------------------------------------------------------ refunds
select pg_temp.assert(pg_temp.err(format($q$select refund_subscription(%L, 'o', 'x')$q$, :'beta')) like '%does not exist%', 'refunding something that is not an invoice is refused');
select create_subscription(:'beta', '2026/2027', 300, 0, 15000000, now() + interval '200 days', now() + interval '214 days', '[]', pg_temp.quote(15000000), 'f') as sb \gset
select pg_temp.assert(pg_temp.err(format($q$select refund_subscription(%L, 'o', 'x')$q$, :'sb')) like '%Only a paid invoice%', 'an unpaid invoice cannot be refunded');
select mark_subscription_paid(:'sb', 'NIP5', 'finance@example.com', 'seen on statement');
select create_topup(:'sb', 2, 200000, pg_temp.topup_line(100000), 'f') as tb \gset
select pg_temp.assert(pg_temp.err(format($q$select refund_subscription(%L, 'o', 'x')$q$, :'sb')) like '%top-up is waiting%', 'a waiting top-up blocks a refund');
select mark_topup_paid(:'tb', 200000, null, 'f', 'seen');
select pg_temp.assert(pg_temp.fails(format($q$select refund_subscription(%L, 'o', '')$q$, :'sb')), 'a refund needs a reason');
update subscriptions set paid_at = now() - interval '20 days' where id = :'sb';
select pg_temp.assert(pg_temp.err(format($q$select refund_subscription(%L, 'o', 'x')$q$, :'sb')) like '%outside the refund window%', 'outside the window is refused');
update subscriptions set paid_at = now() - interval '3 days' where id = :'sb';
select license_version as vb from schools where id = :'beta' \gset
select pg_temp.assert(refund_subscription(:'sb', 'owner@example.com', 'school closed', 14) = 15200000, 'the refund covers the invoice and its paid top-ups');
select pg_temp.assert((select status = 'refunded' and refund_kobo = 15200000 and refunded_by = 'owner@example.com' and refund_reason = 'school closed' from subscriptions where id = :'sb'), 'the refund is recorded with who, why and how much');
select pg_temp.assert((select status = 'refunded' from subscription_topups where id = :'tb'), 'its paid top-ups are marked refunded');
select pg_temp.assert((select license_version = :vb + 1 and license_valid_until <= now() and license_grace_until <= now() from schools where id = :'beta'), 'the licence ends at once with a higher version');
select pg_temp.assert((select count(*) from jobs where type = 'license_push' and school_id = :'beta' and payload ->> 'refund' = 'true') = 1, 'and the push is queued');
select pg_temp.assert(pg_temp.fails(format($q$select refund_subscription(%L, 'o', 'again')$q$, :'sb')), 'a refunded invoice cannot be refunded again');
select pg_temp.assert(not pg_temp.fails(format($q$select create_subscription(%L, '2026/2027', 300, 0, 15000000, now() + interval '200 days', now() + interval '214 days', '[]', pg_temp.quote(15000000), 'f')$q$, :'beta')), 'a refund frees the session for a new invoice');

-- refunding an older session does not switch off the session the school runs on
select create_subscription(:'alpha', '2027/2028', 300, 0, 15000000, now() + interval '500 days', now() + interval '514 days', '[]', pg_temp.quote(15000000), 'f') as sa2 \gset
select mark_subscription_paid(:'sa2', 'NIP6', 'finance@example.com', 'seen on statement');
select license_version as va from schools where id = :'alpha' \gset
select refund_subscription(:'sa', 'owner@example.com', 'billed twice');
select pg_temp.assert((select license_version = :va and license_session = '2027/2028' and license_valid_until > now() from schools where id = :'alpha'), 'refunding an older session leaves the current licence alone');

-- -------------------------------------------------------------- permissions
reset role;
set local role authenticated;
select pg_temp.assert(pg_temp.fails($q$select rate_limit_hit('x', 60, 5)$q$), 'a signed-in user cannot call the rate limiter');
select pg_temp.assert(pg_temp.fails($q$select * from suspend_lapsed_schools(30)$q$), 'nor suspend schools');
select pg_temp.assert(pg_temp.fails($q$select refund_subscription(gen_random_uuid(), 'x', 'x')$q$), 'nor refund');
select pg_temp.assert(pg_temp.fails($q$select create_topup(gen_random_uuid(), 1, 1, '{}', 'x')$q$), 'nor create a top-up');
select pg_temp.assert(pg_temp.fails($q$select * from rate_limit_hits$q$), 'nor read the rate limit table');
reset role;
set local role anon;
select pg_temp.assert(pg_temp.fails($q$select count(*) from subscription_topups$q$), 'anon cannot read top-ups');
select pg_temp.assert(pg_temp.fails($q$select mark_topup_paid(gen_random_uuid(), 1, 'x', 'x', 'x')$q$), 'anon cannot pay a top-up');
reset role;

rollback;
\echo ALL M5 SQL TESTS PASSED
