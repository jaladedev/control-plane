# Provisioning a new school

Plan milestone M5. A school that is registered (**Add school**) starts in status
`provisioning`. Its page then shows a **Provision this school** panel (owner
only). Pressing the button queues one `provision_school` job; the worker runs the
seven steps and the page shows each one as it happens.

The dashboard never touches a school's database, the server or any secret. It
saves the school's first licence on its registry row and queues the job. The
worker does everything else, from its own environment.

## Before you press the button

1. **A Supabase project for the school, empty.** Provisioning applies every migration
   to it. A database that already has tables but no migration history is refused:
   that is an existing school, so use `npm run adopt-school` for it.
2. **The worker knows the school.** Add the school to the worker's environment
   (`worker/.env.example`):
   - `SCHOOL_DB_URLS`: its direct Postgres connection string.
   - `SCHOOL_APP_ENVS`: the settings its container starts with (Supabase URL and keys,
     R2 endpoint, bucket and key, `IMPERSONATION_SIGNING_SECRET`; optionally Paystack,
     Resend, Telegram, `CONTROL_PLANE_URL` with `CLAIM_SIGNING_KEY`). Restart the worker.
   - Interim, until the plan's Infisical is built (plan section 3).
3. **The registry row matches.** If **Supabase project ref** or **R2 bucket** is filled in under
   Details, the settings must agree with it. This catches another school's project pasted in.
4. **DNS.** The school's hostname points at the server. The proxy gets its certificate on the
   first request, so the health step may take a few minutes.
5. **A release is registered** (`npm run register-release`). The school starts on the newest one.
6. **The server is set up** per `deploy/README.md`.
7. **Telegram is set up on the worker** (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`), and you have the first
   admin's name and email. The panel asks for both. Without Telegram the admin step refuses.

## The steps

| Step      | What the worker does                                                                                                                                                                                                                           | Fails when                                                                                                                                                   |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| database  | Checks the settings, connects, refuses a database that looks like an existing school, applies every migration up to the newest release (under the same lock and checksum rules as a rollout)                                                   | Settings wrong or missing, password or network wrong, database not empty, a migration fails                                                                  |
| storage   | Finds the R2 bucket and, with the school's own key, writes, reads and deletes a probe object                                                                                                                                                   | Bucket missing, key cannot write                                                                                                                             |
| container | Asks the server what it has; if nothing, runs `school-deploy create` (env file on stdin, container started and health-checked, proxy route added and reloaded)                                                                                 | Server already has the school at another version, image cannot be pulled, container unhealthy, proxy route will not load (cleaned up with `remove`)          |
| license   | Delivers the saved licence with `set_license()` over the worker's connection                                                                                                                                                                   | The school's database refuses it                                                                                                                             |
| admin     | Creates the first admin's login in the school's own Auth (service role key from its settings) and its `profiles` and `profile_contacts` rows, with a forced password change. Sends the temporary password to you on Telegram, and nowhere else | Telegram not set up on the worker, email already belongs to a non-admin, Auth refuses, or the password cannot be delivered (then the login is removed again) |
| health    | Probes `https://<hostname>/api/health?deep=1` up to 8 times, 15 seconds apart, and wants this release                                                                                                                                          | DNS not pointed, certificate not issued, wrong version                                                                                                       |
| activate  | Flips the school to `active` and records the release and schema version, with an audit row `school.provisioned`                                                                                                                                | Another step has not succeeded                                                                                                                               |

A step that already succeeded is never run again. When one fails, the job ends, the
step shows its reason, and **Resume provisioning** continues from there. Nothing is
cleaned up behind a failure except the half-made container after a proxy failure
(exit 13), because the rest is safe to repeat.

## What is and is not verified

Tested without a server (`tests/worker-provision.test.ts`, `tests/provision-env.test.ts`,
`tests/deploy-client-create.test.ts`, `tests/storage-check.test.ts`,
`tests/provision-actions.test.ts`, `tests/sql/provisioning.test.sql`): the order of the
steps, resuming, every failure stopping what follows it, the settings checks, the exact
commands sent, secrets never appearing in results or step records, and the database rules.

**Not verified:** anything against a real server. Also never run against a real school's Auth: the first-admin step
(`auth.admin.createUser`, then the `profiles` rows, which were read from school_app's schema but not run). The `create` command, a real Supabase
project, a real R2 bucket through the `aws` CLI, DNS and certificates have never run. Do the plan's
staging drill first: provision a throwaway school end to end, then `school-deploy remove`
and delete its project.

## What it does not do

- It does not create the Supabase project or the R2 bucket. Those live in the school's own
  accounts (plan section 2); you create them and put their credentials on the worker.
- It creates ONE admin only. Everyone else is added from inside the school, as usual.
- The temporary password is in your Telegram chat. Anyone who can read that chat can sign in as the
  admin until the password is changed at first sign-in, so delete the message once you have passed it on.
- The container settings are plain environment values on the worker, like `SCHOOL_DB_URLS`.
  That is the plan's "interim" state; replace with Infisical before hosting more schools.
