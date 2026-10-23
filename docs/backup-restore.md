# Control-plane backups and restore

`.github/workflows/backup.yml` runs `scripts/backup.sh` daily at 03:23 UTC: `pg_dump` of
schemas `public` and `auth` (so dashboard logins and their 2FA factors come back), a check
that the dump lists the tables that matter, `age` encryption, upload to R2 as
`control-plane/<UTC timestamp>.dump.age`, and pruning to the newest 30.

## What is and is not verified

- Verified on a scratch Postgres: dump, encryption, refusal with the wrong key, no plaintext
  left behind, restore into a fresh database, matching row counts
  (`scripts/backup-test.sh`), and the prune rule (against a fake `aws`).
- **Not verified:** the workflow on GitHub, the upload to a real R2 bucket, a dump from the
  real Supabase project through the session pooler, and a restore into a Supabase project.
  Run the workflow once by hand (Actions, Run workflow), then do the restore drill below
  into a scratch Supabase project before relying on any of it.

## Keys

The age private key is the only way to read a backup. Keep it offline and in at least two
places that are not this repository or the R2 bucket. Losing it makes every backup useless;
leaking it exposes every backup.

## Restore

1. `age -d -i key.txt -o restore.dump control-plane/<timestamp>.dump.age`
2. Into a **scratch** Postgres (any plain Postgres 15+): create a database, then
   `pg_restore --clean --if-exists --no-owner --dbname=<url> restore.dump`. This recreates
   `public` and `auth` exactly as dumped.
3. Into a **Supabase project** (intended path, not yet tried): apply the migrations, then
   load only the data from the dump (`pg_restore --data-only --no-owner` for the tables in
   `public`, and for `auth.users`, `auth.identities`, `auth.mfa_factors` and
   `auth.mfa_challenges`), because Supabase already owns the `auth` schema. If a data-only
   load of `auth` is refused for permissions, restore into a scratch Postgres as in step 2
   and copy those rows across with `\copy`.
4. Check that you can sign in (password and 2FA), then point the app's `SUPABASE_URL` and
   keys at the new project.

The audit log and school registry are in `public`; nothing in either is a secret.
`SCHOOL_SERVICE_KEYS` is not in the database and is not backed up here.
