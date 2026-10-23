# Control plane

Dashboard for running the hosted school product: a registry of schools and, in
later milestones, health, licences, deploys, billing and audited support access.
This is **M0 (foundations), M1 (schools registry and health) and M2 (licences)** from the project plan. It is its own app with its
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

## What M2 adds

- **Set a licence** on a school (owner or finance): trial or paid, academic
  session, valid-until date (end of that day, UTC), grace days, student cap
  (blank means none) and add-ons. Each save is a new, higher version. It is
  stored on the school's registry row first, then pushed to the school's own
  database with `set_license()`. The form prefills a 30-day trial with 14 days
  of grace for a school with no licence.
- **Delivery is tracked.** If the school rejects or cannot be reached, the
  saved version stays, the error is shown, the list says "not delivered", and
  **Retry push** re-sends the same version (a repeat is a harmless no-op on the
  school's side). A push that the school ignores because it already has that
  version or newer is reported as a conflict, not a success.
- **Revoke** (owner only, needs a ticked box) ends validity and grace now, so
  the school becomes read-only for everyone. Nothing is deleted. Setting a new
  licence undoes it.
- Every set, push and revoke writes its audit row first.

### Licence pushes need each school's service key

Pushing calls `set_license()`, which only the service role may run, so the
control plane needs each school's service-role key. Until a secrets manager
exists these live in the `SCHOOL_SERVICE_KEYS` environment variable as JSON,
`{"greenfield":"<service-role-key>"}`, and the school's Supabase project ref
(on its page here) gives the URL. **This makes the control plane's environment
the most sensitive thing in the system**: whoever can read it can write to every
school. Keep it out of logs and screenshots, and replace it with real secret
storage before you host many schools. Without the variable, pushes are refused
before anything is saved.

### Read-only support sessions

On a school's page, owners and support can press **Create support link**. The
control plane signs a link with that school's own `IMPERSONATION_SIGNING_SECRET`
(the value in the school's env file) and shows it once. The link opens the
school's dashboard as its read-only support account; it works once and expires
after 5 minutes. The request is audited here before the link is made, and the
audit row's `link_id` matches the id the school records, so the two logs line
up. The token itself is never logged or stored. Finance cannot create links;
archived schools are refused.

Secrets live in the `SCHOOL_SIGNING_SECRETS` environment variable as JSON,
`{"greenfield":"<signing secret, 32+ characters>"}`. This is the same interim
design as `SCHOOL_SERVICE_KEYS` and adds to the same weak point: whoever can
read this app's environment can open a support session on any school. Replace
both with real secret storage before hosting many schools. `lib/impersonation.ts`
is an exact copy of school_app's file of the same name; both repos' tests assert
the same literal token, so a change to the format on either side fails a test.

### Deploying to the VPS

`deploy/school-deploy` is the script the deploy worker will run over a restricted
SSH key (create, deploy, roll back, remove, with a health check and automatic
rollback). Setup, exit codes and what is still unverified are in
`deploy/README.md`. Nothing in the dashboard calls it yet.

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

Not in M0, M1 or M2: the job queue, secrets-manager access, anything that talks to a
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
- I have not confirmed what backups the Free plan includes. Treat the control-plane
  database as unbacked-up until the daily encrypted dump to R2 (`backup.yml`,
  `scripts/backup.sh`) has run once and you have done the restore drill in
  `docs/backup-restore.md`. School databases are not covered yet.

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
