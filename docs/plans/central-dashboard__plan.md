# Central dashboard — project plan

Status: planning, decisions locked 14 Oct 2026. Nothing built. This is the control plane for the hosted school_app product: one place to see and run every school, where each school runs as its own container on a VPS with its own database in its own Supabase account that you create and control.

Related: `notes-delivery__full-plan.md` (billing, licensing, hosting and the overall flow).

## 1. Goals and non-goals

**Goals**
1. See every school's status, license, schema version and health on one screen.
2. Run the business from it: quotes, payments, license changes, suspend/resume.
3. Run releases from it: roll migrations and deployments across all schools safely, one school at a time.
4. Onboard a school without manual SQL.
5. Leave an audit trail of everything done to any school.

**Non-goals (v1)**
- Reading or editing school content (notes, students, grades). Aggregates only; audited impersonation is the one door in.
- A raw SQL console.
- Replacing Supabase's or Cloudflare's own dashboards for plans, billing cards and account settings.
- A self-service portal for schools (they only use the school app).
- Multi-user team features beyond three fixed roles.

## 2. Users and roles

| Role | Can do |
|------|--------|
| **owner** (you) | Everything, including provisioning, migrations, key rotation, restore, user management |
| **finance** | Quotes, payments, mark paid, extend license, fee and threshold, top-ups, per-school price overrides. Cannot change list prices. No migrations, no keys |
| **support** | Read-only on schools and health, audited impersonation of a school admin. No writes |

Build the roles from day one even if you're the only user. Adding them later means re-auditing every action.

## 3. Architecture

- **App**: Next.js (App Router), deployed separately from the school app, on its own domain behind Cloudflare Access (or an IP allowlist).
- **Database**: its own Supabase project in a dedicated account, never shared with a school.
- **Auth**: its own login with mandatory 2FA. Not connected to any school's auth.
- **Secrets**: Infisical holds each school's connection string, service role key, Supabase access token and the school's R2 bucket and key (its own Cloudflare account), one folder per school, plus the restricted SSH deploy key for the VPS in `/control-plane/`. The dashboard web app reads none of them: it only queues jobs. Each worker has its own machine identity and fetches only the secrets it needs at the moment a job runs. Nothing is stored in the control-plane database or sent to the browser. See section 9.1 of `notes-delivery__full-plan.md` for the access matrix.
- **Background jobs**: a job queue plus worker (Cloudflare Queues/Workers or a Node worker) for provisioning, migrations, backups and health checks. The UI never runs a long operation inside a request.
- **School app hosting**: one container per school on one VPS, behind a reverse proxy. The dashboard's deploy job writes the school's env file, starts its container, adds its proxy route and starts each deployment through a restricted SSH script. CI builds the image; git pushes deploy nothing (full plan, 3.2).
- **Paystack**: webhook endpoint in this app (signature verified, deduped by reference).
- **Email**: transactional provider for quotes, receipts and reminders (you already use Resend elsewhere).

```
Browser ─▶ Dashboard (Next.js) ─▶ Control-plane DB
                │                       ▲
                ├─▶ Job queue ─▶ Workers ┘
                │        │
                │        ├─▶ Infisical (secrets)
                │        ├─▶ Deploy script on the VPS (over SSH: create, deploy, roll back)
                │        ├─▶ Supabase Management API (per-account token)
                │        └─▶ Each school's database (service role / read-only role)
                └◀── Paystack webhook
```

## 4. Data model (control-plane DB)

| Table | Key columns |
|-------|-------------|
| `schools` | id, slug, name, hostnames[], included_students, status, billing_contact_name, billing_contact_email, supabase_account_email, supabase_project_ref, cloudflare_account_email, r2_bucket, container_name, app_version, image_tag, region, schema_version, credentials_status, hosting_plan (free / pro), features[], created_at |
| `subscriptions` | id, school_id, session, included_students, amount_kobo, extra_students, topup_kobo, status (trial / pending / pending_confirmation / paid / refunded), method (paystack / transfer), payment_ref, paid_at, valid_until, grace_until |
| `subscription_items` | id, subscription_id, feature, amount_kobo, added_at, removed_at (one row per add-on line on a quote or invoice) |
| `price_catalog` | id, item (base_fee / included_students / extra_student / feature key / pro_hosting), amount_kobo or count, effective_from, reason, set_by, created_at. Append-only: a change is a new row |
| `payment_claims` | id, school_id, subscription_id, claimed_by (school user), amount_kobo, sent_on, sender_name, reference, proof_path (private R2 bucket), status (pending / confirmed / rejected), decided_by, decided_at, reject_reason, notified_at, reminded_at. Created by a signed request from the school's app (section 5.7 of the full plan) |
| `school_price_overrides` | id, school_id, item, amount_kobo or percent_off, session, reason, set_by, created_at |
| `licenses_pushed` | school_id, session, valid_until, grace_until, student_cap, features, pushed_at, push_status |
| `invoices` | id, subscription_id, number, issued_at, pdf_path |
| `migrations` | id, name, checksum, kind (expand / contract), min_app_version |
| `migration_runs` | id, school_id, migration_id, status, started_at, finished_at, error |
| `health_checks` | id, school_id, checked_at, ok, schema_version, license_state, student_count, db_size_bytes, storage_bytes (R2, daily bucket listing), error |
| `jobs` | id, type, school_id, status, progress, started_by, started_at, finished_at, log |
| `backups` | id, school_id, taken_at, location, size_bytes, verified_at |
| `audit_log` | id, at, actor_id, role, action, school_id, details (jsonb), ip. Append-only (no update/delete policy) |
| `dashboard_users` | id, email, role, 2fa_enrolled |

Secrets are not columns anywhere above; `credentials_status` (ok / auth_failed / paused / unreachable) is a status only.

## 5. Screens

1. **Schools list**: name, hostname, included students, status, license state and `valid_until`, schema version, app version, last health, student count, open alerts. Filters: status, license state, behind on migrations or app version, renewals due, over student cap.
2. **School detail**: registry data, subscriptions and payments, license, migration history, recent health checks, backups, audit trail for this school, action buttons (permission-gated).
3. **New school wizard**: name, flat fee, included students, billing contact, session, Supabase access token, R2 bucket and key. Shows per-step progress while the provisioning job runs: database, R2 check, env file, container, proxy route and domain, first health check.
4. **Migrations**: pending list, per-school version matrix (database and app version), run controls (test school, pilot, next batch, all), live results, stop.
5. **Billing**: quotes, Paystack payments, **transfer claims awaiting confirmation (oldest first, with the school's "I've sent it" details, reference, and proof photo)** with Confirm and Reject buttons, renewals due in 30 days, receipts. Your bank details for the school's payment screen are edited here.
6. **Health**: all schools sorted by problem; paused/unreachable first.
7. **Audit log**: filter by actor, school, action, date.
8. **Prices**: the price catalog (base fee, included students, extra-student rate, each add-on, Pro hosting), change history, and per-school overrides, with a quote preview.

## 6. Actions and how each is guarded

| Action | Role | Guard |
|--------|------|-------|
| Suspend / resume | owner, finance | Typed school name |
| Mark transfer paid / extend / change fee or threshold / invoice top-up | owner, finance | Reason field required, audit entry |
| Confirm or reject a transfer claim | owner, finance | Amount and reference checked against the bank statement; reject needs a reason; confirm = mark paid, then `push_license`; audit entry |
| Provision school | owner | Idempotent job; resumable after failure |
| Run migration on one school | owner | Shows migration name and school |
| Run migration on batch / all | owner | Typed "ALL", canary order enforced, stops on first failure |
| Deploy app to one school | owner | Shows image tag and school; a health check runs after, and a failed check rolls back |
| Deploy app to batch / all | owner | Typed "ALL", canary order enforced, stops on first failed deployment or health check |
| Roll back a school's deployment | owner | Typed school name; redeploys that school's previous deployment; logged |
| Rotate keys | owner | Typed school name, secrets manager updated before old key is dropped; the school's env file rewritten and its container restarted |
| Backup / restore to scratch | owner | Restore never targets the live project directly |
| Restore paused project | owner | Shows school name; logged; runs through the Management API |
| Mark school upgraded to Pro | owner | Reason field required; sets `schools.hosting_plan` |
| Add / remove a feature | owner, finance | Reason field required. Adding takes effect at once (pro-rated line added, new license version pushed); removing takes effect at renewal |
| Change a list price | owner | Reason required; new catalog entry with an effective date; over 25% change needs typed confirmation; applies to new quotes and renewals only |
| Set a per-school price override | owner, finance | Reason required; one session; shown as its own line on the quote |
| Impersonate school admin (read-only) | owner, support | Time-limited session, banner, every page view logged |

**Rule: no write action ships before it writes an `audit_log` row.**

## 7. Key technical decisions to lock

1. **Job runner**: Cloudflare Queues + Workers vs a small Node worker. Migrations need long-running connections to Postgres, which favors a plain Node worker (or a container). Recommend Node worker for migrations and provisioning, Workers for webhooks and reminders.
2. **How to connect to school databases**: use the pooler for health/count reads with a read-only role; use the direct connection for migrations only.
3. **Secrets manager**: decided: Infisical (one folder per school, a machine identity per worker, offline encrypted export). Set it up in M0, before the first school credential is stored.
4. **License push**: dashboard writes the school's `school_license` row. Record every push in `licenses_pushed`; reconcile on every health check and re-push if the school's row differs from what it should be.
5. **Migration runner contract**: each migration declares `kind` (expand / contract) and `min_app_version`; the runner refuses a contract migration for any school whose deployment is below that version.
6. **Impersonation mechanism**: short-lived signed link to the school app that creates a read-only session; the school app must support a read-only mode. Needs a small change in the school app. The link is signed with that school's own impersonation secret, set in that school's env file.
7. **Migration order for school_app**: its migrations use two filename styles that do not sort in date order. Normalize to one timestamp style before the runner is built (full plan, 3.1).
8. **Secrets for the school app**: each school's container gets only its own secrets in a root-only env file, written by the deploy worker. The app has no Infisical identity (full plan, 9.1).
9. **School app hosting**: one container per school on one VPS (full plan, 3.2). Releases are deployed by the dashboard, not by git pushes.

## 8. Milestones with exit criteria

| # | Milestone | Size | Done when |
|---|-----------|------|-----------|
| M0 | Foundations: repo, auth + 2FA, roles, audit log table, Infisical set up, Cloudflare Access, VPS and restricted deploy key | M | You can log in, roles enforced, an action writes an audit row |
| M1 | Registry + read-only dashboard: schools list/detail, health cron, status | M | Every school appears with live health and schema version |
| M2 | Billing and license controls: subscriptions, price catalog and overrides, mark paid, extend, suspend/resume, license push and reconcile | M | A transfer marked paid changes that school's license row and the school app reflects it |
| M2b | Transfer claims and Telegram: `payment_claims`, signed claim endpoint, Billing queue with Confirm/Reject, Telegram notifier, 48-hour reminder | M | A claim posted from a school reaches Telegram, and confirming it pushes the license |
| M3 | Paystack: checkout link, webhook, receipts, reminders | M | A test payment creates a paid subscription and pushes the license without manual steps |
| M4 | Migration runner, deploy step and Migrations screen | L | A release (migrations plus deployment) rolls through test, pilot and batches with per-school results; a failure halts the rollout |
| M5 | Provisioning wizard | M | A new test school is live from the wizard, including its container and domain, with no manual SQL |
| M6 | Backups, restore rehearsal, key rotation | M | A school restored from a dump into scratch matches the source |
| M7 | Impersonation (read-only) and audit log UI | M | Support can view a school admin's pages, and every view is in the audit log |

Sizes are relative: S, M, L. Build M0–M2b before school #2, M4 before school #3, M5 before school #5.

## 9. Testing

- **Unit tests** for: license calculation (trial / active / grace / lapsed, boundaries), fee, threshold and top-up calculation, price catalog versioning and overrides, Paystack webhook (bad signature, duplicate reference, wrong amount), role checks on every action.
- **Migration runner tests** against throwaway Postgres databases: ordering, stop-on-first-failure, idempotent re-run, contract-migration refusal.
- **A staging school**: a real Supabase project in a test account that the dashboard treats like any other school. Every release is exercised there first.
- **Deploy job** against a staging container on the VPS: create, write the env file, add the proxy route, deploy, roll back; a failed health check rolls back automatically and halts a rollout.
- **Fire drill** before school #3: provision, migrate, suspend, resume, restore. Time each step.

## 10. Observability

- Health cron every 15 minutes per school runs a real query and writes `health_checks` (this is also the keep-alive that prevents the 7-day Free pause); alert on two consecutive failures.
- Alerts (email only in v1) for: unreachable or paused project, auth failure (credentials changed), schema version behind, school over its included-student threshold, database over 400 MB, school nearing an upgrade trigger (about 700 students), app version behind, failed deployment, server disk or memory high, container down, license push mismatch, failed job, Paystack webhook errors.
- Error tracking tagged with school slug and job id.

## 11. Risks

| Risk | Mitigation |
|------|-----------|
| Dashboard compromise exposes every school | Cloudflare Access, 2FA, secrets never in DB or browser, roles, audit log, no SQL console |
| Bad migration hits all schools | Canary order, stop on first failure, expand/contract only |
| You lose access to accounts (single point of failure) | Second owner per Supabase account, recovery codes offline, takeover runbook |
| Control plane down during renewal | License lives in each school's DB, so schools keep working; payments queue in Paystack and reconcile |
| Manual account creation slows onboarding | Checklist, and revisit one-organization-per-school if it hurts |
| Supabase API or limits change | Keep the runner on plain connection strings; wrap the Management API in one module |
| Free-tier project pauses or hits limits | Health cron as keep-alive, size alert at 400 MB, restore-paused-project action, upgrade triggers (see full plan 4.2), nightly dumps |
| Cloudflare account lost or compromised | Each school has its own account, so one loss affects one school; your own account (backups bucket) has 2FA, a second owner and offline recovery codes (see full plan 4.5) |
| The VPS fails or is compromised (it serves every school's app and holds every school's env files) | Provider snapshots, rebuild runbook, SSH keys only, firewall, root-only env files, restricted deploy key, outside uptime monitor; databases and files live on Supabase and R2, so an outage loses no data (see full plan 3.2) |
| A bad app version reaches many schools | Per-school deploys in canary order, stop on first failure, a health check after each, one-click rollback |

## 12. Decisions closed (14 Oct 2026)

1. **Support:** only you for the first schools. The three roles are still built from M0.
2. **Alerts:** email for health and billing reminders. **Telegram** (the control plane's own bot) for new transfer claims, with a reminder after 48 hours unconfirmed (20 Oct 2026). The bot token lives in `/control-plane/` in Infisical. Telegram is a notification only; confirming happens in the dashboard. Other alerts stay on email.
7. **Manual bank transfer (20 Oct 2026):** schools can pay by transfer; the school presses "I've sent it", which creates a `payment_claims` row and moves the subscription to `pending_confirmation`. The license never extends on a claim, only on a confirmation (full plan section 5.7).
3. **Impersonation:** acceptable, and the contract states it explicitly.
4. **School app read-only mode:** yes, added before M7 (impersonation).
5. **Hosting:** one free Supabase account per school with the upgrade triggers in `notes-delivery__full-plan.md` section 4.2.
6. **App hosting:** one container per school on a VPS (19 Oct 2026), replacing first the shared app resolved by hostname and then one Vercel project per school (Vercel's Hobby plan cannot carry paid, payment-taking sites).
8. **School-side licensing already built (20 Oct 2026):** school_app now has `school_license`, `license_status()`, `license_has()` and `set_license(school_id, version, session, valid_until, grace_until, student_cap, features, is_trial)`. The license push job calls exactly that, including `is_trial`; M2 only needs the control-plane side and a reconcile against `license_info()`.
