# Control plane

Dashboard for running the hosted school product: a registry of schools and, in
later milestones, health, licences, deploys, billing and audited support access.
This is **M0 (foundations) plus M1 (schools registry and health)** from the project plan. It is its own app with its
own Supabase project, kept separate from every school.

## What M0 includes

- Sign-in with a password **and** a mandatory authenticator-app code (Supabase
  Auth TOTP; no SMS, no paid add-on). Only people on the `dashboard_users` list
  can continue, whatever else exists in the project's auth users.
- Three fixed roles, `owner`, `finance` and `support`, checked in one place
  (`lib/auth/guards.ts`) and again by row-level security in the database, which
  also requires a 2FA session.
- An **append-only audit log**. Every write action goes through `withAudit()`,
  which writes the audit row first and refuses to continue if it cannot; a
  failed action also leaves a `.failed` row. Update, delete and truncate are
  refused for every role, including the service role.
- User management for owners (add a user with a temporary password, change a
  role, deactivate or reactivate), with the database refusing to remove the last
  active owner.
- The `schools` table and an empty schools list, ready for M1.

## What M1 adds

- A real **schools registry**: owners add a school (slug, name, hostnames, plan,
  included students, billing contact, Supabase project ref, R2 bucket,
  container name) and edit it later. The slug is fixed at creation because it
  must match the school's `SCHOOL_SLUG`. Every change writes an audit row first,
  recording only the fields that changed. Finance and support can view.
- **Health checks.** `POST /api/cron/health` probes the first hostname of every
  non-archived school at `https://<host>/api/health` (healthy means HTTP 200
  with `ok: true`), stores each result in `health_checks` (30 days kept), and
  sets the school's status: one failure is `degraded`, two in a row is `down`,
  a success is `up`. The school's reported image tag becomes its running
  version. Redirects are not followed, and hostnames must be public DNS names
  (no IPs, ports, paths or private suffixes), so the probe cannot be pointed at
  internal addresses.
- **Licence columns** on each school (`license_version`, valid-until,
  grace-until, trial flag) mirroring the school's `school_license`, shown with a
  status derived from the clock. They are read-only for now: setting them and
  pushing with `set_license` is M2.

### Scheduling the health run

`.github/workflows/health.yml` calls the route every 10 minutes. Add repository
secrets `CONTROL_PLANE_URL` (no trailing slash) and `CRON_SECRET`, and set the
same `CRON_SECRET` (32+ characters, `openssl rand -hex 32`) in the app's
environment. Without `CRON_SECRET` the route refuses every call. GitHub's
scheduler can run late or skip runs, so a gap in the history is not by itself an
outage. If the app is behind Cloudflare Access, add a bypass policy for the path
`/api/cron/health`; the route checks its own secret.

The health run is not written to the audit log (it would add a row every ten
minutes); it only writes health data. Anything an actor does still is.

Not in M0 or M1: the job queue, secrets-manager access, anything that talks to a
school's database, Cloudflare Access and the VPS (set up outside this repo).

## Setup

1. Create a Supabase project for the control plane (Free plan is fine; see
   "Free plan notes").
2. In the Supabase dashboard, under Authentication, turn **off** "Allow new
   users to sign up".
3. Apply the migration in `supabase/migrations/` (SQL editor, or the Supabase
   CLI).
4. Copy `.env.example` to `.env.local` and fill in the project's URL, anon key
   and service-role key.
5. Create the first owner, once:
   `npm run create-owner -- you@example.com 'a-long-temporary-password'`
   (the script reads `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` from the
   environment).
6. `npm install`, `npm run dev`, sign in, and set up your authenticator app.

Put the app behind Cloudflare Access in production; the app's own login is a
second layer, not a replacement.

## Free plan notes

- Free projects are paused after about a week without activity.
  `.github/workflows/keepalive.yml` calls `keepalive()` every three days; add the
  repository secrets `SUPABASE_URL` and `SUPABASE_ANON_KEY`. Check on the
  Supabase dashboard that the project stays active after the first week.
- I have not confirmed what backups the Free plan includes. Until you have, treat
  the control-plane database as unbacked-up: the plan's M6 backup work (a scheduled
  dump to R2) should cover it too.

## Checks

```sh
npm run format:check && npm run lint && npm run typecheck && npm test
npm run build && node scripts/smoke.mjs        # front-door checks against a mock Supabase
PSQL="psql -h localhost -U postgres" bash tests/sql/run.sh   # migrations + RLS + audit log
```

`npm install` uses `legacy-peer-deps` (see `.npmrc`); the default resolver
crashes on this dependency set.

## Rules to keep

- Every write action: check the role with `requireActor([...])`, then do the work
  inside `withAudit()`.
- Use `createAdminClient()` only in `lib/actions`, `lib/auth`, `lib/audit.ts` and
  `app/api` (ESLint enforces this).
- No secrets in the database. Credentials live in the secrets manager.
- After adding a table, enable RLS and add select policies that go through
  `dashboard_role()`; browser sessions must never get write access.
