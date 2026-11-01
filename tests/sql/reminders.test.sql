-- Invoice reminders: which stage a licence is in, who gets queued, once per stage.
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

-- ------------------------------------------------------------ the stages
select pg_temp.assert(invoice_reminder_kind(null, null, now()) is null, 'no dates, no stage');
select pg_temp.assert(invoice_reminder_kind('2026-12-01', null, now()) is null, 'half the dates, no stage');
select pg_temp.assert(invoice_reminder_kind('2026-12-01 23:59:59+00', '2026-12-15 23:59:59+00', '2026-10-01+00') is null, 'long before: nothing yet');
select pg_temp.assert(invoice_reminder_kind('2026-12-01 23:59:59+00', '2026-12-15 23:59:59+00', '2026-11-17 23:59:59+00') is null, 'exactly 14 days out: not yet');
select pg_temp.assert(invoice_reminder_kind('2026-12-01 23:59:59+00', '2026-12-15 23:59:59+00', '2026-11-18+00') = 'before_14', 'inside 14 days');
select pg_temp.assert(invoice_reminder_kind('2026-12-01 23:59:59+00', '2026-12-15 23:59:59+00', '2026-11-28 23:59:59+00') = 'before_14', 'exactly 3 days out: still the 14 day stage');
select pg_temp.assert(invoice_reminder_kind('2026-12-01 23:59:59+00', '2026-12-15 23:59:59+00', '2026-11-29+00') = 'before_3', 'inside 3 days');
select pg_temp.assert(invoice_reminder_kind('2026-12-01 23:59:59+00', '2026-12-15 23:59:59+00', '2026-12-01 23:59:59+00') = 'before_3', 'the last second of the licence');
select pg_temp.assert(invoice_reminder_kind('2026-12-01 23:59:59+00', '2026-12-15 23:59:59+00', '2026-12-02+00') = 'grace', 'after the licence, in grace');
select pg_temp.assert(invoice_reminder_kind('2026-12-01 23:59:59+00', '2026-12-15 23:59:59+00', '2026-12-15 23:59:59+00') = 'grace', 'the last second of grace');
select pg_temp.assert(invoice_reminder_kind('2026-12-01 23:59:59+00', '2026-12-15 23:59:59+00', '2026-12-16+00') = 'lapsed', 'after grace');

-- ------------------------------------------------------------ the queue
insert into schools (slug, name, status, hostnames, billing_contact_name, billing_contact_email,
                     license_valid_until, license_grace_until) values
  ('alpha', 'Alpha', 'active', '{alpha.example.com,www.alpha.example.com}', 'Ada Obi', 'bursar@alpha.example.com',
     now() + interval '10 days', now() + interval '24 days'),
  ('beta', 'Beta', 'active', '{beta.example.com}', null, null, now() + interval '40 days', now() + interval '54 days'),
  ('gamma', 'Gamma', 'active', '{gamma.example.com}', null, null, now() - interval '2 days', now() + interval '12 days'),
  ('delta', 'Delta', 'suspended', '{delta.example.com}', null, null, now() + interval '5 days', now() + interval '19 days'),
  ('eps', 'Eps', 'active', '{eps.example.com}', null, null, now() + interval '5 days', now() + interval '19 days'),
  ('zeta', 'Zeta', 'active', '{zeta.example.com}', null, null, null, null);
select id as alpha from schools where slug = 'alpha' \gset
select id as beta from schools where slug = 'beta' \gset
select id as gamma from schools where slug = 'gamma' \gset
select id as delta from schools where slug = 'delta' \gset
select id as eps from schools where slug = 'eps' \gset
select id as zeta from schools where slug = 'zeta' \gset

create or replace function pg_temp.invoice(p_school uuid, p_ref text, p_status text, p_session text default '2026/2027')
returns uuid language plpgsql as $$
declare v uuid;
begin
  insert into subscriptions (school_id, session, reference, included_students, amount_kobo, status,
                             method, paid_at, valid_until, grace_until, quote, created_by)
  values (p_school, p_session, p_ref, 300, 15600000, p_status,
          case when p_status = 'paid' then 'transfer' end, case when p_status = 'paid' then now() end,
          now() + interval '1 year', now() + interval '1 year 14 days', '{"lines":[]}', 'owner@example.com')
  returning id into v;
  return v;
end $$;

select pg_temp.invoice(:'alpha', 'SUB-AAAAAAA1', 'pending') as ia \gset
select pg_temp.invoice(:'beta', 'SUB-AAAAAAA2', 'pending') as ib \gset
select pg_temp.invoice(:'gamma', 'SUB-AAAAAAA3', 'pending') as ig \gset
select pg_temp.invoice(:'delta', 'SUB-AAAAAAA4', 'pending') as id_ \gset
select pg_temp.invoice(:'eps', 'SUB-AAAAAAA5', 'pending_confirmation') as ie \gset
select pg_temp.invoice(:'zeta', 'SUB-AAAAAAA6', 'pending') as iz \gset
select pg_temp.invoice(:'alpha', 'SUB-AAAAAAA7', 'paid', '2025/2026') as ipaid \gset
select pg_temp.invoice(:'alpha', 'SUB-AAAAAAA8', 'cancelled', '2024/2025') as icancel \gset

select enqueue_invoice_reminders() as queued \gset
select pg_temp.assert(:queued = 2, 'two invoices are due: alpha (inside 14 days) and gamma (in grace)');
select pg_temp.assert((select count(*) = 2 and bool_and(type = 'invoice_reminder' and status = 'queued') from jobs where type = 'invoice_reminder'), 'two reminder jobs are queued');
select pg_temp.assert((select payload = jsonb_build_object('subscription_id', :'ia'::uuid, 'kind', 'before_14') and school_id = :'alpha'::uuid and max_attempts = 3
                         from jobs where payload ->> 'subscription_id' = :'ia'), 'alpha: the 14 day stage, for that invoice and school');
select pg_temp.assert((select payload ->> 'kind' = 'grace' from jobs where payload ->> 'subscription_id' = :'ig'), 'gamma, raised late, gets only the grace stage, not the earlier ones');
select pg_temp.assert((select count(*) = 0 from jobs where payload ->> 'subscription_id' in (:'ib', :'id_', :'ie', :'iz', :'ipaid', :'icancel')),
                      'not queued: licence far off, suspended school, claim waiting, no licence dates, paid, cancelled');

select pg_temp.assert(enqueue_invoice_reminders() = 0, 'a second scan queues nothing while they wait');
update jobs set status = 'running' where type = 'invoice_reminder';
select pg_temp.assert(enqueue_invoice_reminders() = 0, 'nor while they run');
update jobs set status = 'failed' where type = 'invoice_reminder';
select pg_temp.assert(enqueue_invoice_reminders() = 0, 'a failed one is not retried by the very next scan');
update jobs set created_at = now() - interval '25 hours' where type = 'invoice_reminder';
select pg_temp.assert(enqueue_invoice_reminders() = 2, 'a day later a failed stage is queued again');
update jobs set status = 'failed', created_at = now() - interval '25 hours' where type = 'invoice_reminder';

-- ------------------------------------------------------------ one flat row
select pg_temp.assert((select status = 'pending' and reference = 'SUB-AAAAAAA1' and session = '2026/2027' and amount_kobo = 15600000
                              and school_name = 'Alpha' and school_slug = 'alpha' and school_status = 'active'
                              and billing_contact_name = 'Ada Obi' and billing_contact_email = 'bursar@alpha.example.com'
                              and hostname = 'alpha.example.com' and current_kind = 'before_14' and sent_kinds = '{}'
                         from invoice_for_reminder(:'ia')), 'the row has what the email needs, the first hostname and the current stage');
select pg_temp.assert((select count(*) = 0 from invoice_for_reminder(gen_random_uuid())), 'an unknown invoice gives no row');

-- ------------------------------------------------------------ recording
select pg_temp.assert(mark_invoice_reminded(:'ia', 'before_14', 'bursar@alpha.example.com') = true, 'the first record is new');
select pg_temp.assert(mark_invoice_reminded(:'ia', 'before_14', 'someone@else.example.com') = false, 'a repeat is ignored');
select pg_temp.assert((select sent_to = 'bursar@alpha.example.com' from invoice_reminders where subscription_id = :'ia' and kind = 'before_14'), 'the first recipient is kept');
select pg_temp.assert(pg_temp.err(format($q$select mark_invoice_reminded(%L, 'soon', null)$q$, :'ia')) like '%Unknown reminder stage%', 'a made-up stage is refused');
select pg_temp.assert(pg_temp.fails(format($q$select mark_invoice_reminded(%L, 'before_3', null)$q$, gen_random_uuid())), 'an unknown invoice is refused');
select pg_temp.assert(mark_invoice_reminded(:'ib', 'before_14', null) = true, 'no recipient (no billing contact) can be recorded');
select pg_temp.assert((select sent_kinds = '{before_14}' from invoice_for_reminder(:'ia')), 'the row shows what was sent');

select enqueue_invoice_reminders() as q2 \gset
select pg_temp.assert(:q2 = 1, 'only gamma is queued again: its stage was never sent');
select pg_temp.assert(not exists (select 1 from jobs where payload ->> 'subscription_id' = :'ia' and status = 'queued'), 'a stage already sent is never queued again');
update jobs set status = 'failed', created_at = now() - interval '25 hours' where type = 'invoice_reminder';

-- the licence gets nearer: the next stage, not the same one
update schools set license_valid_until = now() + interval '2 days', license_grace_until = now() + interval '16 days' where id = :'alpha';
select enqueue_invoice_reminders();
select pg_temp.assert((select count(*) = 1 from jobs where payload ->> 'subscription_id' = :'ia' and payload ->> 'kind' = 'before_3' and status = 'queued'), 'alpha moves on to the 3 day stage');
select pg_temp.assert((select current_kind = 'before_3' and sent_kinds = '{before_14}' from invoice_for_reminder(:'ia')), 'and the row says so');

-- paying stops them
update subscriptions set status = 'paid', method = 'transfer', paid_at = now() where id = :'ia';
update jobs set status = 'failed', created_at = now() - interval '25 hours' where type = 'invoice_reminder';
delete from jobs where type = 'invoice_reminder';
select enqueue_invoice_reminders();
select pg_temp.assert((select count(*) = 0 from jobs where payload ->> 'subscription_id' = :'ia'), 'a paid invoice gets no further reminders');

-- ------------------------------------------------------------ append only
select pg_temp.assert(pg_temp.err(format($q$update invoice_reminders set sent_to = 'x' where subscription_id = %L$q$, :'ib')) like '%append-only%', 'a record cannot be edited');
select pg_temp.assert(pg_temp.err(format($q$delete from invoice_reminders where subscription_id = %L$q$, :'ib')) like '%append-only%', 'a record cannot be deleted');
select pg_temp.assert(pg_temp.fails(format($q$delete from subscriptions where id = %L$q$, :'ib')), 'an invoice with a reminder record cannot be deleted');
select pg_temp.assert(pg_temp.fails($q$insert into jobs (type) values ('invoice_nag')$q$), 'the job type list is enforced');

-- --------------------------------------------------------------- access
reset role;
set local role authenticated;
select pg_temp.assert(pg_temp.fails($q$select enqueue_invoice_reminders()$q$), 'signed-in users cannot queue reminders');
select pg_temp.assert(pg_temp.fails(format($q$select mark_invoice_reminded(%L, 'grace', null)$q$, :'ig')), 'signed-in users cannot record one');
select pg_temp.assert(pg_temp.fails(format($q$select * from invoice_for_reminder(%L)$q$, :'ig')), 'signed-in users cannot read the flat row');
select pg_temp.assert(pg_temp.fails($q$insert into invoice_reminders (subscription_id, kind) values (gen_random_uuid(), 'grace')$q$), 'signed-in users cannot write records');
select pg_temp.assert((select count(*) = 0 from invoice_reminders), 'a session with no dashboard role sees no records');
reset role;
set local role anon;
select pg_temp.assert(pg_temp.fails($q$select enqueue_invoice_reminders()$q$), 'anon cannot queue reminders');
select pg_temp.assert(pg_temp.fails($q$select count(*) from invoice_reminders$q$), 'anon cannot read records');
reset role;

rollback;
\echo ALL REMINDER SQL TESTS PASSED
