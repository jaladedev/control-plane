# School app, hosted for multiple schools — full plan

Status: planning, decisions locked 14 Oct 2026; app hosting revised 19 Oct 2026 to one container per school on a VPS. Nothing built. The product is school_app (github.com/jaladedev/school_app); this file keeps its original name. This consolidates and replaces the earlier plan files; where they disagree, this document wins. Detail docs that still apply: `central-dashboard__plan.md` (dashboard project plan) and `central-dashboard__license-push.md` (license push mechanism).

## 1. Locked decisions

| Area | Decision |
|------|----------|
| Product | **school_app** (github.com/jaladedev/school_app): a full school management system with admin, teacher, student and parent roles, covering classes, timetable, attendance, assessments, report cards, fees and Paystack payments, messaging, transport, hostel, library, and curriculum notes with an editor and present mode. Productized as a hosted multi-school service. Notes are one module of it, not the whole product |
| Content | Each school builds its own library independently from scratch. No shared central content pack service |
| Editing | Each teacher can edit notes to taste without affecting another school's copy |
| Timetable | school_app already has `timetable_entries`, a bell timer and timetable copy. Confirm it covers a bell schedule plus a class weekly grid before building anything |
| Data isolation | One database per school |
| Accounts | One **free-plan** Supabase account per school, **created and controlled by you**. Schools never hold database credentials. Each school also gets its own Cloudflare account for its R2 file storage (section 4.5). A school moves to Pro on the upgrade triggers in section 4.2 |
| Hosting | You host everything. **One container per school** on a VPS you rent (same image, its own env file and domain), behind one reverse proxy (section 3.2). There is no shared app and no tenant lookup in the code |
| Payer | The school pays, per academic session (not parents or students) |
| Pricing | One flat fee of **₦300,000 per session** covering up to **300 included students**, plus **₦1,000 per extra student** per session (section 4.1), plus optional per-feature add-ons (section 4.3) |
| Prices are settings | Every price (base fee, included students, extra-student rate, each add-on, Pro hosting) lives in a versioned price catalog you edit from the dashboard, with per-school overrides (section 4.4) |
| Enforcement | License row in each school's database, written only by your control plane |
| Secrets | Infisical holds per-school machine secrets (one folder per school). Each school's container receives only its own secrets, in a root-only env file on the server. Human logins and recovery codes live in a password manager |
| Trial | 30 days, full features |
| Lapsed | The app becomes read-only for all roles; parent fee payment, receipts, report cards and all exports keep working; nothing is deleted |
| Files | Uploads are stored in **Cloudflare R2**, in each school's own Cloudflare account (one private bucket), replacing Supabase Storage (section 4.5) |
| Current school_app database | Becomes the staging school (switch it to school #1 if it already holds a real school's data) |
| Billing contact | A separate field on the school record, defaulting to the school admin |
| Alerts | Email for health and billing reminders. **Telegram** for payment submissions (section 5.7) |
| Payment methods | Parents' fees (inside school_app) and school renewals (to you) both offer Paystack **and** manual bank transfer: account details shown, payer presses "I've sent it", a human confirms (section 5.7) |
| Impersonation | Read-only, time-limited, every page view logged; the contract states it; the school app gets a read-only mode |
| Support | Only you at first; the three dashboard roles are built from day one |

## 2. Decisions closed and what is still open

**Closed (14 Oct 2026):** pricing (₦300,000 per session for up to 300 students plus ₦1,000 per extra student), Free Supabase plan per school with upgrade triggers, uploads stored in Cloudflare R2, in each school's own Cloudflare account, app hosting as one container per school on a VPS (section 3), lapsed behaviour (read-only for all roles, with fee payment, receipts, report cards and exports still working), the existing school_app database becoming the staging school, 30-day trial, billing contact, email-only alerts, read-only impersonation, solo support, and the definition of an active student (enrolled and not archived; graduated and archived accounts do not count).

**Still open, outside this document:**
1. VAT and tax treatment: ask an accountant.
2. Nigeria data protection obligations and the contract wording: ask a lawyer.
3. Supabase checks before school #1 (section 4.2): the active-project limit across organizations, terms on many free accounts for a commercial service, and the Free to Pro transfer rules.
4. Load test result (section 12): the 300-simultaneous-user test on the staging school.
5. **Per-feature add-on prices (section 4.3, proposed):** which features are add-ons and what each costs. Confirm or change.
6. **R2 checks and file backup approach (section 4.5):** whether R2 needs a payment method on each account, Cloudflare's terms on many accounts, and how deleted files are recovered.
7. **VPS checks before school #1 (section 3.2):** current server price and provider terms, measured memory per container, latency from Lagos, and the deploy tooling choice (own script or Coolify).

## 3. Architecture

```
School users ─▶ reverse proxy on the VPS ─▶ the school's own container (same image, own env file)
                    ├─▶ School DB (own Supabase account)
                    ├─▶ School files (own Cloudflare R2 account)
                    └─▶ School's own Paystack account

You ─▶ Control-plane dashboard ─▶ Control-plane DB (own Supabase account)
                    │
                    ├─▶ Secrets manager (per-school keys and tokens)
                    ├─▶ Job queue ─▶ Workers: provisioning, deploys, migrations, license push, backups, health
                    ├─▶ Deploy script on the VPS (over SSH: create, deploy, roll back)
                    ├─▶ Supabase Management API (per-account token)
                    └◀─ Paystack webhook
```

- **One codebase, one container per school.** Every school runs the same school_app image as its own container on one VPS, with its own env file, its own domain, and its own Supabase, R2 and Paystack. The app has no tenant lookup, so a bug cannot show one school's data to another. A reverse proxy routes each hostname to the right container.
- One VPS holds all the school containers. Schools never hold server access.
- **Releases are deployed per school** by the dashboard, in canary order (section 8). Git pushes do not auto-deploy anything: CI only builds and publishes the image.
- **Service role keys** are in that school's env file only, used by its server code and by the control plane's workers.
- **Control plane** is a separate app with its own database and login. It is never connected to any school's auth.

### 3.1 What school_app needs to change (found by reading the repo, 14 Oct 2026; revised 19 Oct 2026)

school_app already builds as a standalone Next.js server and reads one set of environment variables, which fits a container per school. There is no tenant lookup in the code. What is needed:

1. **A Dockerfile and an image build.** `next.config.mjs` already sets `output: "standalone"`, but the repo has no Dockerfile. Add a multi-stage Dockerfile (non-root user, health endpoint) and a CI job that builds the image once per release and pushes it to a private registry (for example GitHub Container Registry).
2. **One image for every school: runtime config.** Next.js inlines `NEXT_PUBLIC_*` values into the build, so one image cannot serve many schools as the code stands (Next.js docs, checked 19 Oct 2026). The fix is small: server code reads non-public names at runtime (for example `SUPABASE_URL` and `SUPABASE_ANON_KEY` in `lib/env.server.ts`, `lib/env.edge.ts` and the middleware), and the root layout hands the browser its school's public values (Supabase URL, anon key, Paystack public key) through a small provider. The browser reads those values in only two files, `lib/supabase/client.ts` and `components/PaystackPayButton.tsx`; the other 28 files that use the browser client call the same factory. The alternative is one image per school built with build arguments, which needs no code change but means N builds per release.
3. **A per-school environment template.** A documented list of what each school's env file needs: the school's Telegram bot token (section 5.7), Supabase URL, anon key and service role key; the school's Paystack public and secret keys (school_app collects the school's fees from parents; this is separate from the control plane's Paystack, where schools pay you); R2 endpoint, bucket and key; email settings; an impersonation signing secret; the school slug. Add the new keys to the zod schemas in `lib/env.*` so a missing value stops the container from starting.
4. **Licensing across the whole app. Built upstream (19-20 Oct 2026, commits b5f3ac0, 8c3b1d2).** school_app now has `school_license`, `license_status()`, `license_active()`, `license_has(feature)`, `license_require()`, per-feature gates on tables and RPCs, a license banner, and `set_license(school_id, version, session, valid_until, grace_until, student_cap, features, is_trial)`; tests are in `tests/sql/`. Still to verify against the plan: the whole app goes read-only when lapsed while parent fee payment, receipts, report cards and exports keep working, and the dashboard's `push_license` passes `is_trial`.
5. **Read-only mode** for audited impersonation. The dashboard signs a short-lived link with that school's impersonation secret, and the school's container verifies it.
6. **Migration cleanup. Done upstream (18 Oct 2026).** Migrations were renamed to one 14-digit timestamp style and a schema-parity migration brings them level with the live database, so a runner applies them in order. Remaining: the runner itself, and replaying all migrations on a scratch database (`tests/sql/run.sh` already does this for the SQL tests).
7. **Storage and Realtime.** The four Storage buckets (homework submissions, topic resources, student photos, library assets) move to Cloudflare R2 (4.5); not started. All access goes through the server-side admin client, so this is a contained change in about 8 files. If files are shown through `next/image`, add R2's host to `images.remotePatterns` in `next.config.mjs` (today it allows only `*.supabase.co`). **Realtime: messaging was moved to polling upstream (17 Oct 2026)**: the sidebar badge polls every 30 s, the inbox every 10 s, an open conversation every 4 s (`lib/messagePolling.ts`, `lib/hooks/usePolling.ts`, only while the tab is visible), and `messages` was dropped from the Realtime publication. The only Realtime left is live transport (`TransportStatusBadge`, `RouteMap`), which holds a connection only while a parent or student has the transport page open, so the 200-connection Free limit (4.2) no longer scales with open tabs. The cost moves to polling load on the server and the school's database.
8. **The current database.** The existing school_app database becomes the staging school (section 2).
9. **Feature gating per add-on (section 4.3).** The license carries a list of enabled features. The app hides a gated feature in the navigation, rejects it in server actions and routes, and blocks writes to its tables in RLS. When messaging is off, the sidebar badge must not mount, so no Realtime connection is opened.
10. **Release metadata.** Each container reports its image tag (the git commit) so the health check can record `app_version` per school.
11. **Manual bank transfer for fees (section 5.7).** Bank details and a methods switch in school settings, a `payment_claims` table with RLS, an "I've sent it" form on the parent and student fees pages, a bursar confirmation queue that calls `recordPayment`, a renewal-payment screen that posts a signed claim to the control plane, and a small Telegram notifier (bot token and chat id from the env file and settings). Allowed while lapsed.

### 3.2 App hosting: one container per school on a VPS (locked 19 Oct 2026)

**Why a VPS.** Vercel's Hobby plan is restricted to non-commercial personal use, and its fair use guidelines count taking payments or being paid to host a site as commercial, so it cannot carry paying schools. Vercel Pro is about $20 a month per seat, a fixed cost that is heavy for the first one or two schools. One VPS runs every school's container for a low fixed cost.

**Server and cost** (prices from the aggregator getdeploying.com on 19 Oct 2026; Hetzner is reported to have repriced its cloud in June 2026, so confirm on Hetzner's own pricing page). A 4 vCPU, 8 GB server is about $10 a month (about ₦13,500 at about ₦1,332 per dollar), and 8 vCPU, 16 GB is about $19 (about ₦24,700). A school's Next.js container probably needs roughly 150-300 MB of memory when idle (an estimate to measure in the load test), so an 8 GB server could hold roughly 15-20 schools at under ₦1,000 per school a month. Turn on provider snapshots and budget a little for them.

**Location.** Supabase has no Africa region; its European regions are Frankfurt, Ireland, London, Paris, Zurich and Stockholm (checked 19 Oct 2026). The app talks to its database on every page, so put the server next to the databases: a German data center (Falkenstein or Nuremberg) with every new school's Supabase project in Frankfurt (`eu-central-1`). Today `school_note` is in Frankfurt and `royal` is in Ireland. Lagos users reach the server across the internet either way, so measure page times from Nigeria in the load test.

**Layout on the server**
- Docker with one container per school, `school-<slug>`, all from the same image. Each has its own env file (root-only, written by the deploy worker from the school's Infisical folder), its own memory and CPU limits, a restart policy, and no published ports.
- One reverse proxy (Caddy) in front, with automatic certificates, routing each hostname to the right container. This is routing in the infrastructure, not tenant logic in the app: each container only knows its own school.
- Domains are `<slug>.<your domain>` with a wildcard DNS record pointing at the server, optionally proxied through Cloudflare for DDoS protection (check Cloudflare's terms and TLS mode). A school that wants its own domain adds a DNS record to the server, and Caddy issues the certificate. If you onboard many schools at once, use a wildcard certificate (DNS challenge) to stay under certificate rate limits.
- The image is built once per release in CI and pushed to a private registry. The server holds a read-only pull token.

**Deploy mechanics**
- The deploy worker connects over SSH with a restricted key that can run only one script on the server. The script offers `create <slug>` (write the env file, start the container, add the proxy route), `deploy <slug> <image tag>` (pull, restart that school's container, wait for its health endpoint, roll back to the previous tag if it does not come up), `rollback <slug>` and `remove <slug>`.
- Coolify and Dokploy give a web UI and an API for the same job. Check them before writing your own script; either way the dashboard drives it.
- Key rotation: rewrite the school's env file and restart its container.

**Server hardening and operations:** firewall with only 80 and 443 open and SSH limited to your IPs, SSH keys only, automatic security updates, fail2ban, provider snapshots on, container logs tagged with the school slug, disk and memory alerts, and an outside uptime monitor on every school's health URL.

**Single point of failure.** One server serves every school's app at once, and its disk holds every school's env files. An outage takes all the apps down together, but the databases and files stay on Supabase and R2, so no data is lost. Mitigations: provider snapshots, a written rebuild runbook (a new server from a snapshot, or from the deploy script and Infisical, in about an hour), root-only env files with no password logins, and a plan to add a second server (a warm standby, or splitting schools across two) once you pass about 10 schools or promise an uptime commitment.

**Checks before school #1:** current server prices and the provider's terms for this use; a dollar-capable payment method for the provider; measured memory per container and server CPU under load; page times from Lagos; whether to write your own deploy script or use Coolify; and the certificate approach.

## 4. Business model

| Item | Plan |
|------|------|
| Billing unit | Per academic session. Optional per-term pricing later, only if schools ask |
| Price basis | **One flat fee per session up to a threshold of included students.** Same price whether the school has 20 students or the threshold, so quoting is trivial and small schools aren't penalised |
| Above the threshold | ₦1,000 per extra student for the session, invoiced as a top-up at the second-term true-up. Never block access over the cap |
| What counts as a student | Active student accounts on the snapshot date: enrolled and not archived. Graduated and archived accounts do not count |
| When it's counted | At quote time (30 days before the session) to set the invoice, with one true-up at the start of the second term for students added since. Avoid continuous metering: it creates disputes and extra invoices |
| Over the threshold mid-session | Soft warning in the school admin banner at 100% of the threshold; the dashboard flags the school as over cap; the top-up is invoiced at the next true-up. Access is never blocked |
| Payment methods | Paystack (card/transfer) and direct bank transfer: details shown, payer presses "I've sent it", you confirm (section 5.7), with a Telegram notice |
| Trial | 30 days, full features |
| Grace | 21 days after `valid_until` |
| Mid-session signup | Full price, with optional pro-rating for terms 2 and 3 |
| Refunds | A defined window (e.g. 14 days); revocation is immediate because you write the license row |
| Receipts | Official invoice and receipt PDF per session |
| Tax | Check with an accountant whether VAT applies. Not decided here |

### 4.1 Pricing (locked)

| Item | Price |
|------|-------|
| Flat fee per session | **₦300,000** (about ₦100,000 a term), up to **300 included students** |
| Per extra student | **₦1,000 per session**, invoiced as a top-up at the true-up |
| Pilot schools (first 2-3) | 30-40% off the first session only; never a free session (the trial covers evaluation) |

| Students | Session price |
|----------|---------------|
| 200 | ₦300,000 |
| 300 | ₦300,000 |
| 500 | ₦500,000 |
| 1,000 | ₦1,000,000 |

**Why these numbers.** school_app is a full school suite, so the comparison is full suites (October 2026; check each before quoting): SchoolKit about ₦45,000 a term for up to 200 students and ₦90,000 a term for up to 600; SchoolOS about ₦180,000 a term flat; per-student models at ₦300-₦1,000 per student per 120-day cycle. ₦300,000 a session is mid-range for a suite, and schools at or under 300 students cost little to host (Free Supabase and R2, plus a share of one VPS, under ₦1,000 a month each at 15 schools), so the flat fee is nearly all margin.

**Pro cost.** Supabase Pro is $25 a month, about $300 a year, or about ₦400,000 at about ₦1,332 per dollar (early October 2026). A school at 700 students pays about ₦700,000 a session, so its revenue covers the upgrade comfortably. That sets the student-count trigger in 4.2.

**Other pricing rules:**
- Quote in naira, but hosting upgrades are paid in dollars: the contract includes an annual price review, and you re-quote each session.
- Pause or archive projects for schools that have not renewed after the grace period plus a retention window, so no hosting is wasted on lapsed schools.

### 4.2 Hosting: Free Supabase plan, one account per school (locked)

**Free plan limits** (checked early October 2026; confirm on supabase.com/pricing): 2 active projects, 500 MB database per project (uploads are on Cloudflare R2, section 4.5), 5 GB egress, 50,000 monthly active users, shared CPU and 500 MB RAM, no daily backups, and projects pause after 7 days of inactivity. Realtime allows 200 concurrent connections and 100 channel joins per second (Pro: 500 and 500), per Supabase's docs (15 Oct 2026).

**Operating rules that make Free workable:**
1. **Keep-alive.** The 15-minute health cron runs a real query on every school, which prevents the 7-day pause. A plain ping is not enough.
2. **Backups.** Nightly dump per school to a separate private R2 bucket for backups (4.5). The restore rehearsal is mandatory before school #1.
3. **Files.** Uploads are stored in Cloudflare R2, not Supabase Storage (4.5), so Free's 1 GB storage limit and 5 GB egress no longer apply to files.
4. **Size monitoring.** Each health check records database size; alert at 400 MB (80%). R2 usage is recorded once a day for cost visibility (4.5).
5. **Unreachable or paused.** The school app uses the cached license until grace ends and never locks the school. The dashboard has a "restore paused project" action through the Management API.
6. **Load test.** Before school #1, run the load test in `load-test/load-test__plan.md` on the staging school. Messaging now polls (badge every 30 s per open tab), so the Realtime limit is no longer the expected first bottleneck; the test now measures polling and page load on the container and the Free database, plus a Realtime ramp that models only parents watching a bus.
7. **Contract.** Hosting is best-effort with no uptime guarantee unless the school buys the Pro hosting add-on (4.3).

**Data volume.** school_app stores attendance, grades, invoices, messages and notes, far more than notes alone, so a large school may approach 500 MB within a few years. The database trigger can come sooner than the student-count trigger. Measure growth on the first school.

**Upgrade to Pro when any one is true:**
- database over 400 MB;
- more than about 700 students (revenue then covers the cost);
- the school buys the Pro hosting add-on (uptime commitment and platform backups);
- peak concurrent logged-in sessions above the figure set by the load test (Realtime connections are used only by live transport tracking, because messaging now polls);
- the load test fails or class-time slowdowns appear;
- the school asks for an uptime commitment or platform backups.

Upgrade in place in that school's account, or transfer the project into a Pro organization if Supabase allows it. Record the change in `schools.hosting_plan`.

**To verify before school #1:** whether the 2 active-project limit applies across organizations (if it does, one account per school is required, which is the locked design), Supabase's terms on many free accounts for a commercial service, and the current Free to Pro transfer rules.

**Trials and staging** use the same Free setup. A trial school converts to a paying school in place.

**What locks when a school lapses:** the app becomes read-only for all roles; parent fee payments, receipts, report cards and all exports keep working. Never hold a school's data hostage; nothing is deleted on lapse.

### 4.3 Per-feature add-ons (proposed, needs confirmation)

Every school pays the base fee (4.1) for the core product. Each extra feature is priced on its own, per session, and added to the quote.

**Core (in the base fee, never gated):** students, staff and parents; classes, subjects, timetable; attendance; assessments, grades and report cards; curriculum notes and present mode; homework and quizzes; fees, invoices, receipts and Paystack payments; announcements; ID cards; exports.

| Add-on | What it covers | Price per session (proposed) |
|--------|----------------|------------------------------|
| Messaging | Inbox and one-to-one messages between staff, parents and students | ₦60,000 |
| Transport | Routes, stops, vehicles, student assignments and live tracking | ₦80,000 |
| Hostel | Hostels, rooms, waitlist and visitor log | ₦50,000 |
| Library | Book catalogue and loans | ₦40,000 |
| Bulk email | Announcements and fee reminders sent by email | ₦40,000 |
| Inventory | Assets register | ₦30,000 |
| Pro hosting (optional) | Platform backups, no pause risk and higher limits, for schools that want an uptime commitment | ₦500,000 (cost to you about ₦400,000) |

| Example school (up to 300 students) | Session price |
|-------------------------------------|---------------|
| Base only | ₦300,000 |
| Base + messaging + bulk email | ₦400,000 |
| Base + every feature add-on | ₦600,000 |
| Base + every feature add-on + Pro hosting | ₦1,100,000 |

**Why these numbers.** The feature add-ons total ₦300,000, so a school that takes everything pays ₦600,000 a session (about ₦200,000 a term), close to the SchoolOS figure in 4.1. Each add-on is priced by value to the school. Pro hosting is priced separately because it is the only add-on with a real cost to you.

**Hosting does not depend on features.** Messaging polls for new messages instead of using Realtime (done upstream, 17 Oct 2026), so it runs on Free hosting. Live transport tracking is the only Realtime feature, and it opens connections only while parents watch a bus. A school moves to Pro on the upgrade triggers in 4.2 or when it buys the Pro hosting add-on, not because of a feature.

**Rules:**
- Never gate core records.
- Turning a feature off never deletes its data. Messages, for example, stay in the database and reappear when the add-on returns.
- **Adding a feature mid-session** takes effect at once. The price is pro-rated: full price in term 1, two thirds in term 2, one third in term 3.
- **Removing a feature** takes effect at the next renewal only, with no refund mid-session.
- **Lapsed:** a lapsed school is read-only, as in 4.2, and add-ons stay off.
- The quote and invoice list each add-on as its own line.

**How it is enforced:**
- `set_license` takes a `features` list and stores it in the `school_license` row. A function `license_has(feature)` returns whether the school may use that feature.
- The app checks it in three places: the navigation (hide the feature), server actions and routes (reject the call), and RLS on the feature's tables (block direct API writes, for example inserts into `messages`).
- The health check reads the row back and re-pushes on drift, as for the license dates.
- The school admin's settings page lists which features the school has.

### 4.4 Price catalog: setting and changing prices

The figures in 4.1 and 4.3 are the starting values. They are data in the control plane, not code, so you can change any of them from the dashboard without a release.

**What is configurable:** base fee, included-student threshold, per-extra-student rate, the price of each add-on (messaging, transport, hostel, library, bulk email, inventory), the Pro hosting price, and the pilot discount. All amounts are stored in kobo.

**Versioning:**
- A change never edits a price in place. It adds a new catalog entry with an effective date and a reason, so the full history stays visible.
- The current price of an item is the latest entry whose effective date has passed.

**When a change applies:**
- New quotes and renewals created on or after the effective date use the new price.
- A quote that is already issued, a paid subscription, and the current session's invoice keep the prices they were created at. Prices are copied onto the subscription items when the quote is made.
- A feature added mid-session is priced from the catalog on the day it is added (pro-rated as in 4.3), unless the school has an override.

**Per-school overrides:** a custom price or a percentage discount on any item, for one session, with a reason. The pilot discount in 4.1 is an override. An override appears on that school's quote as its own line, so the school sees what they are getting.

**Who can do what:**
- Only the owner changes list prices.
- The owner and finance can set a per-school override.
- Every change is written to the audit log with the old value, the new value and the reason.

**Guardrails:**
- A list-price change of more than 25% up or down needs a typed confirmation.
- Prices cannot be negative, and an override cannot take an item below zero.
- The quote preview shows the total before it is sent.

### 4.5 File storage: Cloudflare R2, one account per school (locked 16 Oct 2026)

**Prices** (checked 16 Oct 2026; confirm on developers.cloudflare.com/r2/pricing): the free tier is 10 GB-month of storage, 1 million Class A operations (writes and lists) and 10 million Class B operations (reads) a month. Beyond that: $0.015 per GB-month, $4.50 per million Class A, $0.36 per million Class B. **Egress is free.** The free tier is per Cloudflare account, so with one account per school, **every school gets its own 10 GB free**.

**Cost example:** most schools stay inside the free tier and pay nothing. A school using 25 GB pays (25 − 10) × $0.015 = $0.225 a month, about ₦300 (about ₦3,600 a year) at about ₦1,332 per dollar. The bill goes to the card on that account, which is yours, so you absorb it or pass it through in the session price. Storage is not a pricing driver.

**Why R2:** it removes Free Supabase's 1 GB file limit and 5 GB egress limit for files, file downloads stop counting against Supabase egress, and file storage no longer pushes a school toward Pro.

**Why one account per school (same reasoning as Supabase):** a leaked key or a closed account affects one school, each school has its own free tier and its own bill, and the account can be handed over with the school.

**Layout:**
- One **Cloudflare account per school**, created and controlled by you: a dedicated address on your domain, 2FA, and a second owner or recovery contact. Schools never hold credentials.
- In each account: one private bucket with a folder per kind of file (`homework-submissions/`, `topic-resources/`, `student-photos/`, `library-assets/`), and one R2 access key limited to that bucket. Both are created in the manual onboarding step (5.2).
- The account id, bucket name, endpoint and access key live in that school's Infisical folder (9.1).
- No public access and no public domain. Every file is served through a signed link.
- **Backups:** your own Cloudflare account holds a separate private backups bucket for the nightly database dumps, so backups never sit in the same account as the data they protect.

**How the app changes** (about 8 files; school_app uses the server-side admin client for all storage today):
- A new `lib/storage.ts` is the only code that talks to R2, through its S3-compatible API with the AWS SDK. It offers upload, remove, and signed links for one or many files, with the same expiry as today (1 hour and 6 hours). It reads the school's R2 settings (endpoint, bucket, key) from that school's environment variables (3.1).
- The `admin.storage` calls are replaced in: `lib/actions/admin.ts` (student photos), `lib/actions/teacher.ts` (topic resources), `lib/actions/homeworkSubmissions.ts`, `lib/actions/topicResources.ts`, and the pages for admin ID cards print, admin student detail, teacher notes topic and teacher homework.
- Uploads stay server-side as they are today, so no browser CORS setup is needed.
- Access control does not change. Pages read rows through the RLS-scoped client first, and only paths the user can already see are signed.
- R2 has no bucket-level size or type limits, so the existing limits (for example `MAX_TOPIC_RESOURCE_BYTES` and the allowed type lists) are checked in code before every upload, instead of by `createBucket`.
- Creating the bucket moves from the upload actions to the onboarding checklist (5.2). The provisioning worker only checks access.
- The database does not change: `file_url` columns store the object path, and `lib/storage.ts` adds the folder prefix.
- When a school is lapsed, uploads are blocked as writes; downloads keep working.
- `LIBRARY_BUCKET` is declared in `lib/storageBuckets.ts` but has no call sites today.

**Moving the existing school_app files** (the staging school): copy the objects from the four Supabase buckets into the new R2 bucket, using the old bucket name as the folder (for example with rclone), compare counts and sizes, and keep the Supabase buckets until the copy is verified. Check that Supabase's S3-compatible endpoint is enabled for the project.

**Operations:**
- **Usage:** once a day the health cron lists each school's bucket and records `storage_bytes` in `health_checks`. A school with 100,000 files needs about 100 list calls a day, a few thousand a month, well inside the free tier. Usage is shown on the school detail screen for cost visibility; it is not an upgrade trigger.
- **Recovery of deleted files:** R2 does not bring back files that were deleted or overwritten on its own. Decide before school #1 between a weekly copy of each school bucket into the backups bucket in your account, and accepting the risk in the contract. Check R2's current versioning and replication features first.
- **Account loss:** because each school has its own account, one loss affects one school. Your own Cloudflare account (backups bucket, dashboard hosting) gets 2FA, a second owner and offline recovery codes.
- **Offboarding and handover:** export the school's bucket, then delete the bucket and archive the account after the retention period; or hand over the Cloudflare account together with the Supabase account (5.6).
- **Fallback:** if two accounts per school slows onboarding too much, use one bucket per school in a single Cloudflare account of yours. The app change is identical; only where the keys come from differs.

**Checks before school #1:** current R2 prices and free tier; whether R2 needs a payment method on each new Cloudflare account (I believe it does) and whose card goes on it; Cloudflare's terms on many accounts for a commercial service; the exact steps to create an R2 key limited to one bucket; and the file backup decision above.

## 5. Lifecycle and flow

### 5.1 One-time setup (before school #1)
Infisical (folders and machine identities), password manager, mailbox domain for per-school account addresses; control-plane tables, Paystack webhook, admin console; the VPS (Docker, Caddy, firewall, snapshots) and the restricted deploy key, DNS for school subdomains, the Docker image build, the per-school environment template; migration runner, provisioning script, health cron.

### 5.2 Onboarding a school
1. Sign-off on the flat fee, included-student threshold and terms. Create the school record (`provisioning`).
2. **Manual**: create its Supabase account (dedicated address on your domain, email and password, 2FA, second owner or recovery contact), generate an access token. Also create its Cloudflare account (same address pattern, 2FA, second owner or recovery contact), enable R2, create the school's private bucket, and create an R2 access key limited to that bucket.
3. Store credentials in the secrets manager keyed by school id; registry gets `account_id`.
4. Run the **provisioning script**: create the Supabase project (Management API), wait until healthy, check R2 access with a test file (write, read, delete), apply migrations through the runner, seed settings, the `school_license` row (trial), first admin; store connection string and keys; then write the school's env file from its secrets, start its container on the VPS, add its proxy route and domain, and run the first health check.
5. Create the school's Telegram bot (BotFather), store its token in the school's Infisical folder, and send a test message to the bursar's chat.
6. Smoke test: log in as admin, create a note, read it as a student, trial banner shows; submit a test "I've sent it" claim and confirm the Telegram message arrives.
7. Registry status `active`; send admin their login, trial end date and quote.

### 5.3 Operation
A request arrives at the proxy, which routes it by hostname to that school's own container. The container already holds that school's keys and is served from that school's database. Edits stay inside that school's database. A health check every 15 minutes per school records reachability, schema version, app version, license state and student count.

### 5.4 Payment and renewal (per session)
1. Quote emailed 30 days before the session ends (or 14 days before the trial ends).
2. School pays by Paystack or bank transfer.
3. Paystack path: webhook verifies signature, dedupes by reference, checks amount against the quote, marks the subscription `paid`. Transfer path (section 5.7): the school's billing page shows your account details and a reference; the school presses "I've sent it"; you get a Telegram message; you check your bank and press "mark paid".
4. Control plane queues `push_license(school_id)` (section 6). Access continues or resumes immediately.
5. Receipt emailed. Reminders at 30, 14, 7 days before expiry and on expiry.

### 5.5 Lapse and recovery
`valid_until` passes: grace (warning banner, everything still works). Grace ends: lapsed (read-only for all roles, with fee payment, receipts, report cards and exports still working, plus a lapsed screen). Payment: push runs and access returns at once. A long lapse (e.g. a full term): mark `suspended`; nothing is deleted.

### 5.6 Offboarding or handover
School leaves: export (dump plus the school's R2 bucket), suspend, retain for the agreed period, then delete the Supabase project, the school's R2 bucket and keys, and its container and env file, and archive both accounts. School wants its own database: transfer the project to their organization or hand over the account (check Supabase's current transfer rules), hand over its Cloudflare account the same way, give them the image and its env values (or run their container on their own server), remove its keys from your secrets manager, mark `archived`.


### 5.7 Manual bank transfer with "I've sent it" (added 20 Oct 2026)

One flow, used twice: parents paying a school, and a school paying you. Paystack stays as the other option. A claim never pays anything by itself; only a human confirmation does.

**Steps (both cases)**
1. The payer picks "Pay by bank transfer". The page shows bank, account name, account number, the amount, and a **reference code** to put in the transfer narration (for example `INV-1042` for a fee invoice, `LIC-<school>-<session>` for a renewal).
2. The payer sends the transfer in their own bank app, then presses **"I've sent it"** and fills in amount, date sent, sender name, and an optional photo of the receipt (stored in the school's R2 bucket; in the control plane, its own R2 bucket).
3. This creates a claim with status `pending`. The invoice or subscription stays unpaid and no access changes.
4. A **Telegram message** goes to the person who confirms (below).
5. They check the bank statement, then **Confirm** or **Reject** (a reason is required, and the payer is told by email and an in-app notice).
6. Confirm records the payment, issues the receipt, and for a renewal queues `push_license`. Claims still `pending` after 48 hours get a Telegram reminder and show at the top of the queue.

**A. Parents paying school fees (inside school_app)**
- Settings (admin): bank name, account name, account number, and a switch for which methods show: Paystack, bank transfer, or both. Per school; the details are the school's own account, not yours.
- New table `payment_claims` (invoice_id, student_id, claimed_by, amount_kobo, sent_on, sender_name, reference, proof_path, status pending/confirmed/rejected, decided_by, decided_at, reject_reason, payment_id). RLS: the payer sees their own claims; bursar and admin see and decide all.
- Confirm calls the existing `recordPayment` (method `transfer`), which already has the overpayment guard and receipts. Confirming a claim larger than the balance is blocked.
- One open claim per invoice at a time, to stop duplicates. The bursar can confirm a different amount than claimed (recorded in the claim).
- Works when the license is lapsed, like Paystack payment (fee payment stays allowed).
- Telegram: the school has its own bot. Bot token and chat id are in the school's env file (secrets folder) and the bursar's chat is set in settings. Message text carries only: student name, class, amount, invoice reference, and a link to the confirmation queue. No account details, no proof image.

**B. School paying you (control plane)**
- Your bank details and the quote live in control-plane settings, shown on the school's billing page in school_app (the license screen shown during trial, grace and lapse).
- The school's claim is sent to the control plane (signed request, school id and quote reference, the same signature check as other school-to-control-plane calls), creating a `payment_claims` row with status `pending` and moving the subscription to `pending_confirmation`.
- Telegram goes to you through the control plane's own bot. Confirm = the existing "mark paid" action (owner or finance, reason field, audit entry), then `push_license`.
- The license does **not** extend on the claim. If you want to be generous while checking, use the existing "extend" action, which is audited.

**Guards against fake claims**
- Nothing is credited on a claim alone; a confirmation needs a human who has checked the bank statement for that amount and reference.
- The reference code is unique per invoice or quote, so a bursar can match it quickly.
- Duplicate claims blocked; rejected claims are kept, with reasons.
- Every claim, confirmation and rejection writes an audit row (the school's `audit_log`, or the control plane's).
- Proof photos are private (signed URLs, short expiry), images and PDFs only, size-capped.
- Telegram messages are notifications only: confirming happens in the app after login, never by replying to the bot.

**Telegram setup and limits**
- Each school's bot is created once during onboarding (a step added to 5.2), token stored in that school's Infisical folder. Your own bot token goes in `/control-plane/`.
- Sending is an outbound call to the Telegram Bot API from the school's container (and the control plane), so it needs outbound HTTPS from the VPS and a retry on failure. A failed send never blocks the claim; the queue and the 48-hour reminder still work, and email is the fallback.
- Telegram is for payment submissions only. Other alerts stay on email.
- **To verify:** Telegram reachability from the VPS and from Nigerian phones, and that parents' data (names, amounts) in a third-party messenger is acceptable under the data protection advice (open item: lawyer). Keep message text minimal either way.

## 6. Licensing mechanism

The dashboard's worker fetches the school's URL and service role key and calls one database function, `set_license(school_id, version, session, valid_until, grace_until, student_cap, features, is_trial)`, in that school's database (the function exists upstream with this signature). Full SQL sketch and failure table are in `central-dashboard__license-push.md`.

- **School side:** a single-row `school_license` table with no RLS policies for `anon`/`authenticated`; `license_status()` returns active / grace / expired / none, `license_active()` is used in the RLS policies for whatever the lapsed behaviour locks, so direct API calls are blocked too (in school_app that is the whole app, read-only for all roles, with fee payment, receipts, report cards and exports left working).
- **`student_cap` is the included-student threshold** from the school's flat fee. The app only uses it to show the warning banner; it never blocks access. A top-up for extra students raises or removes the cap in a new, higher-version push.
- **`school_id` check** inside `set_license` rejects a push to the wrong school's database.
- **Version number** makes stale, duplicate or late pushes no-ops; a revoke is simply a higher version.
- **Read-back and reconcile:** every health check compares the school's row with what it should be and re-pushes on drift (this also corrects hand edits).
- **If the control plane is down**, schools keep working until `grace_until`; Paystack retries the webhook and the push runs when you're back.
- **Keep the Paystack webhook separate from the workers that hold school keys.** The webhook only records the payment and queues a job.
- Optional later: a custom Postgres role per school that can only execute `set_license` (check how Supabase's pooler handles custom roles first).

## 7. Control-plane dashboard

Full detail in `central-dashboard__plan.md`. Summary:

**Roles:** owner (everything), finance (billing and license only), support (read-only plus audited impersonation).

**Tables:** `schools`, `subscriptions`, `subscription_items`, `price_catalog`, `school_price_overrides`, `licenses_pushed`, `invoices`, `migrations`, `migration_runs`, `health_checks`, `jobs`, `backups`, `audit_log` (append-only), `dashboard_users`.

**Screens:** schools list; school detail; new-school wizard; migrations; billing; prices; health; audit log.

**Actions and guards:** suspend/resume, mark paid/extend/change fee or threshold (reason required), change list prices (owner only) and per-school price overrides, provision, run migrations (one, batch, all; typed "ALL" for all; canary order; stop on first failure), rotate keys, backup/restore to scratch, read-only impersonation (time-limited, every view logged). **No write action ships before it writes an `audit_log` row.**

**Cannot control:** creating the Supabase account itself, billing cards and plans inside each Supabase account, anything outside the Management API's scope (check current docs).

## 8. Migrations and releases

- One migrations folder in one repo; a runner applies them to every school.
- school_app's existing migrations mix two filename styles that do not sort in date order (see 3.1). Normalize them to one timestamp style before the runner exists, and treat the current schema as the baseline for new schools.
- `migration_runs` (central) is the source of truth for "which school is on which version"; each school DB also keeps its own applied-migrations table.
- **Rollout order:** your test school, then one pilot school, then batches of 5–10. For each school the runner applies its migrations, deploys that school's container, waits for a healthy check, then moves on. Stop on the first failure; one lock prevents concurrent runs.
- **Expand/contract only.** A school's database and app still cannot change in the same instant, so every migration works with both the old and new app. With a project per school the exposure is one school at a time, and `min_app_version` is checked per school: the runner refuses a contract migration for any school whose deployment is below that version.
- **Release flow:** merge → CI builds and publishes the image → for each school in canary order: apply expand migrations → deploy that school's container on the new image tag → verify its health check (a failed check rolls back automatically) → next school → a later release drops old columns. The dashboard starts each deployment through the deploy script; git pushes deploy nothing.
- **Version tracking:** `schools.app_version` and `schools.image_tag` record what each school runs. The Migrations screen shows the version matrix for both the database and the app. A school is rolled back by restarting its container on the previous image tag.
- **Tooling:** the runner needs only a connection string (Supabase CLI `db push --db-url`, or dbmate / Atlas / node-pg-migrate), which keeps you portable.
- **Job runner:** long migrations and provisioning need long Postgres connections, which favors a plain Node worker; use Cloudflare Workers for webhooks and reminders. Deploy steps run on the Node worker, since they use SSH to the server.

## 9. Security

- The dashboard can touch every school: put it behind Cloudflare Access (or IP allowlist or VPN) plus its own login, mandatory 2FA for every user.
- School secrets are kept in Infisical (section 9.1) and, for the running app, in that school's root-only env file on the server. They are fetched at the moment an action runs, never stored in the control-plane DB and never sent to the browser.
- No raw SQL console and no "view all notes" screen. Aggregates only; impersonation is the only way into school content, and it is logged.
- Read-only database role per school for routine health and count reads.
- **You are the single point of failure** (mailbox domain, password manager, 2FA device): a second trusted owner or recovery contact on each Supabase and Cloudflare account and on the VPS provider account, recovery codes stored offline, written takeover runbook.
- Separate Paystack webhook (internet-facing) from key-holding workers.
- Destructive actions need typed confirmation of the school name or "ALL".
- Check with a lawyer how Nigeria's data protection rules apply to your role and the contract. Not decided here.

### 9.1 Secrets: Infisical

**Why a managed service:** you're solo, and a hand-built encrypted-env scheme means writing versioning, audit and rotation yourself. Infisical is open source, so you can start on its cloud and self-host later if cost or control demands it. Alternatives considered: Doppler (closest), AWS Secrets Manager (billed per secret, so cost grows with every school). Before committing, check Infisical's current plan limits for number of secrets, machine identities and audit-log retention.

**Layout:** one folder per school, `/schools/<slug>/`, holding:
- Supabase project URL
- Service role key
- Database connection string
- The account's Management API access token
- The school's Cloudflare account id, R2 bucket name, endpoint and its bucket-scoped access key
- The school's container name and its impersonation signing secret

Plus a `/control-plane/` folder for the dashboard's own credentials (its Supabase keys, Paystack secret key, email provider key, the restricted SSH deploy key for the VPS, and the R2 credentials for the backups bucket in your own Cloudflare account).

**Access matrix** (each worker has its own machine identity and reads only what it needs):

| Worker | Reads |
|--------|-------|
| License worker | URL, service role key |
| Migration worker | Connection string |
| Provisioning and deploy worker | Management API access token, that school's R2 key (only to check access), the restricted SSH deploy key, and that school's secrets (to write its env file); writes the new school's secrets back |
| Health cron | Connection string for the read-only role |
| Backup worker | Connection string, and R2 credentials for the backups bucket |
| School app (its own container) | Its own env file only. It has no Infisical identity, so it cannot read any other school's secrets |
| Paystack webhook | **Nothing** (records the payment and queues a job only) |
| Dashboard web app | **No school secrets** (it only queues jobs and shows results) |

**Human credentials stay out of it.** Supabase account logins, 2FA recovery codes and mailbox passwords go in a password manager (1Password or Bitwarden) shared with your second owner. Infisical holds only what software uses at runtime.

**Protections from day one:**
- Each worker needs one credential to reach Infisical, which is effectively that worker's master key. Keep it only in that worker's environment, scope it to that worker's paths, and document how to rotate it.
- Keep an encrypted offline export of all secrets, so an Infisical outage or lockout doesn't strand you. Refresh it whenever a school is added or a key rotates.
- Rotating a school's keys: rotate in that school's Supabase account, update the folder in Infisical, rewrite the school's env file and restart its container, confirm the next health check passes, then mark the old key retired. Never overwrite before the new key works.
- Turn on Infisical's audit log and review who or what read which secret; alert on a read from an unexpected identity.

## 10. Backups, operations, observability

- Nightly dump per school to the R2 backups bucket in your own Cloudflare account (never in the school's account) is mandatory, because the Free plan has no platform backups. Rehearse restoring ONE school into a scratch database before school #1.
- Health cron every 15 minutes runs a real query on every school (this is also the keep-alive that prevents the 7-day Free pause), and records reachability, schema version, license state, student count and database size. Alert after two consecutive failures. Alerts for: unreachable or paused project, auth failure (credentials changed), schema version behind, database over 400 MB, school nearing an upgrade trigger, app version behind, failed deployment, server disk or memory high, container down, license push mismatch, failed job, Paystack webhook errors.
- Errors and logs tagged with school slug and job id.
- Support access: read-only role plus audited impersonation. Impersonation needs a small read-only mode in the school app.

## 11. Cost and risk

**Cost:** schools run on Free Supabase accounts and Free-tier R2, and every school's app runs as a container on one VPS (about $10 a month for 4 vCPU and 8 GB, about ₦13,500, which fits roughly 15-20 schools; section 3.2). The real costs are that server, your time, the secrets and tooling, and Pro Supabase upgrades (about ₦400,000 a year each, paid in dollars) once a school passes an upgrade trigger in section 4.2. The escape hatch if per-account management stops scaling: one Postgres server with one database per school behind a pooler; registry, runner, provisioning and health checks stay identical, but you would run authentication and storage yourself. Revisit at roughly 15-20 schools.

| Risk | Mitigation |
|------|-----------|
| Dashboard compromise exposes every school | Cloudflare Access, 2FA, secrets out of DB and browser, roles, audit log, no SQL console |
| Bad migration hits all schools | Canary order, stop on first failure, expand/contract only |
| You lose access to accounts | Second owner per account, offline recovery codes, takeover runbook |
| Control plane down during renewal | License lives in each school's DB; schools run until grace ends; payments reconcile |
| Manual account creation slows onboarding | Checklist (now two accounts per school: Supabase and Cloudflare); consider organization-per-school, or one Cloudflare account with a bucket per school (4.5) |
| Supabase API or limits change | Runner on plain connection strings; one module wraps the Management API |
| Wrong-school license push | `school_id` check inside `set_license`; reconcile on health check |
| Free-tier project pauses or hits limits | Health cron as keep-alive, size alert at 400 MB, restore-paused-project action, upgrade triggers, nightly dumps |
| Cloudflare account lost or compromised | Each school has its own account, so one loss affects one school; your own account (backups bucket, dashboard) has 2FA, a second owner and offline recovery codes; file backup decision (4.5) |
| The VPS fails or is compromised (it serves every school's app and holds every school's env files) | Provider snapshots, a rebuild runbook, SSH keys only, firewall, root-only env files, restricted deploy key, outside uptime monitor, a second server once past about 10 schools; databases and files live on Supabase and R2, so an outage loses no data |
| A bad app version reaches many schools | Per-school deploys in canary order, stop on first failure, a health check after each, one-click redeploy of the previous deployment |
| Schools drift onto different app versions | `app_version` per school, an alert when behind, and a rule to bring every school current within a set number of days |
| Supabase changes or restricts Free | Runner on plain connection strings; upgrade to Pro or move to your own Postgres server; price review clause |

## 12. Roadmap

Sizes are relative: S, M, L.

| Phase | What | Size | Done when |
|-------|------|------|-----------|
| **P0: manual** | Per-school `school_license` row set by a script (school, session, valid_until); bank transfer only; hand-run provisioning | S | First school live and paying |
| **P1: school-side licensing** (largely built upstream, 19-20 Oct 2026) | `school_license` table, `set_license()`, `license_status()`, `license_active()` policies, `license_has(feature)` gating (navigation, server actions, RLS), banner and lapsed screen, read-only mode for all roles | S (remaining checks) | Lapsing a test school makes the app read-only for everyone while fee payment, report cards and exports still work; `set_license` called with the dashboard's argument list including `is_trial` |
| **P1b: per-school deployment** (before school #2) | Dockerfile and CI image build, runtime config so one image serves every school (3.1, items 1-2), per-school environment template validated by the zod env schemas, per-school Paystack and email settings, migration filename cleanup and baseline, file storage moved to R2, the VPS set up (Docker, Caddy, restricted deploy script) and two school containers started by hand (see 3.1, 3.2 and 4.5) | L | Two test schools run as separate containers from one image, with separate data and keys |
| **P2: foundations** (before school #2) | Control-plane repo, auth + 2FA, roles, audit log table, Infisical set up (folders, machine identities, offline export), Cloudflare Access | M | You can log in; roles enforced; an action writes an audit row |
| **P3: registry and read-only dashboard** (before school #2) | Schools list/detail, health cron, status | M | Every school appears with live health and schema version |
| **P4: billing and license controls** (before school #2) | Subscriptions, price catalog and overrides, mark paid, extend, suspend/resume, license push and reconcile | M | A transfer marked paid changes the school's license row and the app reflects it |
| **P4b: manual transfer and Telegram** (with P4, before school #1 if possible) | Section 5.7: `payment_claims` in school_app and the control plane, "I've sent it" screens, confirmation queues, Telegram notifier, 48-hour reminder | M | A test claim from a parent and from a school each reach Telegram, and confirming each records the payment (and, for a renewal, pushes the license) |
| **P5: Paystack** | Checkout link, webhook, receipts, reminders | M | A test payment becomes a paid subscription and pushes the license automatically |
| **P6: migration runner and screen** (before school #3) | Runner, `migration_runs`, canary rollout, per-school deploy step, app version tracking, live results | L | A release (migrations plus deployment) rolls through test, pilot and batches; a failure halts it |
| **P7: provisioning wizard** (before school #5) | Wraps the provisioning script, including the container, env file, proxy route and first start | M | A new test school goes live from the wizard with no manual SQL |
| **P8: backups, restore, key rotation** | Nightly dumps, restore rehearsal, rotate keys | M | A restored school matches the source |
| **P9: impersonation and audit log UI** | Read-only impersonation, searchable audit log | M | Every impersonated page view appears in the audit log |

**Fire drill before school #3:** provision, migrate, suspend, resume, restore; time each step.

**Load test before school #1:** see `load-test/load-test__plan.md`. Its results set the concurrent-session upgrade trigger in 4.2. Run it against a container on the VPS with the planned memory and CPU limits, and record memory per container and server CPU, so you can size the server and work out how many schools fit.

## 13. Testing

- Unit tests: license calculation boundaries (trial / active / grace / lapsed), fee, threshold and top-up calculation, price catalog versioning and per-school overrides, Paystack webhook (bad signature, duplicate reference, wrong amount), role checks on every action.
- `set_license` against throwaway Postgres: stale version, `school_id` mismatch, role without execute permission, duplicate push.
- Migration runner against throwaway Postgres: ordering, stop-on-first-failure, idempotent re-run, contract-migration refusal.
- A **staging school** (real Supabase project in a test account) that the dashboard treats like any other school; every release goes through it first.
- **Deploy job** against a staging container on the VPS: create, write the env file, add the proxy route, deploy, roll back; a failed health check rolls back automatically and halts a rollout.

## 14. What this replaces

- **Signed license tokens and offline verification:** dropped. Because you host everything and control every account, the control plane writes the license row directly.
- **School-owned Supabase accounts ("Case B"):** dropped. If a school ever wants its own database, use the handover process in 5.6.
- **Tiers by student count and "pay per student":** replaced by one flat fee up to an included-student threshold, with a top-up above it.
- **Pro-by-default hosting and per-school Pro accounts:** replaced by Free accounts per school with upgrade triggers (section 4.2).
- **Fresh rebuild as a standalone notes product:** dropped. The product is school_app itself. The repo has no import script (`scripts/` holds only `copy-mathlive-fonts.js`), so there is nothing to remove for that.
- **Supabase Storage for uploads:** replaced by Cloudflare R2, in each school's own Cloudflare account (section 4.5).
- **One shared app deployment resolved by hostname, then one Vercel project per school:** both dropped. One container per school on a VPS replaces them (section 3). Vercel's Hobby plan is barred for paid, payment-taking sites and its Pro seat is a fixed monthly cost, and a hostname tenant layer in the app would be new code that could leak data between schools.
