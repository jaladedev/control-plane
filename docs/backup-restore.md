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

## School database backups

The worker takes one of these before it migrates a school (see `docs/worker.md`, "Backups").
They are separate from the control-plane backup above: their own age key pair, their own R2
bucket and token (`BACKUP_AGE_RECIPIENT`, `R2_*` in `worker/.env.example`). Objects are
`<prefix>/<school slug>/<UTC time>-<id>.dump.age`. The `backups` table (visible to the
dashboard) has each one's object key, size and SHA-256, and which rollout step it protects.

What a backup holds: the school's `public`, `auth` and `supabase_migrations` schemas, in
`pg_dump` custom format. It does **not** hold Supabase Storage files, and it is only as new
as the moment before that school's migrations ran.

### What is and is not verified (school backups)

- Verified against a scratch Postgres and a local S3-compatible server, with the real
  `pg_dump`, `pg_restore`, `age` and `aws` programs: dump, encrypt, upload, size check,
  download, decrypt with the right key (and refusal with another), restore into a fresh
  database with matching data, delete, no plaintext left behind, no object left after a
  failure.
- **Not verified:** a dump from a real Supabase project (direct connection, TLS), the upload
  to a real R2 bucket with a scoped token, and a restore into a Supabase project. Do the
  drill below before the first real rollout, on the test school.

### Restore (manual)

1. Find the backup: the school's step on the Migrations screen, or
   `select object_key, size_bytes, sha256, started_at from backups where school_id = ...`.
2. Download it (`aws s3 cp --endpoint-url <R2_ENDPOINT> s3://<bucket>/<object_key> .`) and
   check it: `sha256sum` must equal the recorded value.
3. Decrypt with the **offline** private key: `age -d -i school-backups-key.txt -o school.dump <file>`.
   Delete `school.dump` when you are done; it is plaintext student data.
4. Look before restoring: `pg_restore --list school.dump`.
5. Restore into a **scratch** database first:
   `pg_restore --clean --if-exists --no-owner --dbname=<url> school.dump`. `--clean --if-exists`
   matters: without it a fresh database fails on `CREATE SCHEMA public` because `public`
   already exists.
6. Into the school's real project: the app has been rolled back to the old version, or the
   restored data is the old shape. Do this only with the school stopped, from a rehearsed
   procedure, and only after deciding whether to restore everything or copy specific tables
   across from the scratch database. Supabase owns the `auth` schema, so load `auth` data
   the way "Restore" step 3 above describes.
7. After restoring, check the `supabase_migrations.schema_migrations` table: the control
   plane reads it as the truth about which migrations the school has, so Refresh versions on
   the Migrations screen and confirm it matches before any further rollout.

Rehearse steps 1 to 5 once, on a school you can afford to lose, before you need them.
