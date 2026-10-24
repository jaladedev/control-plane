# Running the worker

The worker is a plain Node process (`npm run worker`) that does the slow,
risky work the dashboard only queues: connecting to a school's database,
running its migrations, deploying its container, and checking it is healthy.
The dashboard never holds school database URLs or the deploy key; only the
worker does.

## Where to run it

On a machine that stays on and can reach: the control-plane Supabase project,
each school's database (port 5432, direct connection), the VPS over SSH, and
the schools' public hostnames. The VPS is the obvious place. It is a queue
consumer, so it can be stopped and started freely: a job in flight finishes on
SIGTERM, and a job lost to a crash is picked up again after `STALE_MINUTES`.

It also needs, on its PATH: `pg_dump` and `pg_restore` of the **same major
version as the school databases** (a dump from an older client than the server is
refused), `age`, and the AWS CLI (`aws`, v2) for R2. And free disk for one school's
dump plus its encrypted copy (`BACKUP_TMP_DIR`).

## Setup

1. Copy `worker/.env.example` to a file only the worker's user can read
   (`chmod 600`) and fill it in. Use Node 22.
2. Put the deploy key and a `known_hosts` file where `DEPLOY_SSH_*` points.
   Create `known_hosts` by hand from a trusted source (`ssh-keyscan` over a
   connection you trust, then compare the fingerprint). The worker refuses an
   unknown host.
3. A systemd unit, as an example:

   ```ini
   [Unit]
   Description=Control plane worker
   After=network-online.target
   Wants=network-online.target

   [Service]
   User=controlplane
   WorkingDirectory=/opt/control-plane
   EnvironmentFile=/etc/control-plane/worker.env
   ExecStart=/usr/bin/npm run worker
   Restart=always
   RestartSec=5
   TimeoutStopSec=900

   [Install]
   WantedBy=multi-user.target
   ```

   `TimeoutStopSec` is generous on purpose: stopping waits for a running
   migration or deploy to finish rather than killing it half way.

4. Watch it: `journalctl -u control-plane-worker -f`. Every line is prefixed
   with a timestamp, and database URLs and passwords are redacted.

## Backups

Before the worker applies a school's migrations it takes a backup of that school's
database: `pg_dump` of the `public`, `auth` and `supabase_migrations` schemas, encrypted
with the age public key, uploaded to R2 under `<prefix>/<slug>/<time>-<id>.dump.age`. The
step records it (the Backup column on the Migrations screen; the `backups` table keeps
the object key, size and SHA-256).

- **It fails closed.** If the backup cannot be made, uploaded, checked or recorded, the
  step fails and **no migration is run** on that school. The rollout halts like any other
  failure. Fix the cause and Retry.
- **When none is taken.** Nothing is pending, or the owner ticked "Skip the backup..."
  when planning and every pending migration for that school is `expand`. A school with
  any `contract` migration pending is always backed up. A school that is going to be
  refused (unknown migrations, out of order, contract before its app) is not backed up
  first, because nothing would be applied.
- **What is not in it.** Uploaded files (Supabase Storage) are not in the database and are
  not backed up. A change made to the database between the backup and the first
  migration is not in it either; the window is seconds, and the runner's lock keeps other
  migrators out, but ordinary app writes continue.
- **Handling.** The database URL reaches `pg_dump` through environment variables, never
  the command line. Each tool gets only the variables it needs, so a backup never sees
  the other schools' URLs. The plaintext dump lives in a private temporary directory and
  is deleted as soon as it is encrypted. A backup counts only after R2 reports the size
  that was uploaded.
- **Retention.** After a successful backup the worker deletes that school's objects beyond
  the newest `BACKUP_KEEP`, except backups belonging to a rollout that is running or halted.
  The record stays, marked pruned. A failure to prune never fails a step.
- **Restoring** is manual on purpose: `docs/backup-restore.md`.

## If something goes wrong

| Symptom                                                          | Meaning and fix                                                                                                                                                                                                                                         |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "A job has been waiting N minutes" on the screen                 | The worker is not running, or cannot reach the control plane. Start it and read its log.                                                                                                                                                                |
| A step failed with a migration error                             | That migration was rolled back completely; earlier ones in the step stay applied. Fix the SQL with a **new** migration, register a new release, plan a new rollout. Retry only helps for a transient failure.                                           |
| "has migrations the control plane does not know"                 | Someone applied SQL to that school outside the control plane. Find out what, and register it or reconcile the school.                                                                                                                                   |
| "Another migration run holds this school's database lock"        | A run (or the Supabase CLI) is using that database. Wait, then Retry.                                                                                                                                                                                   |
| "contract migration that needs app version..."                   | The school's app is older than that migration requires. Deploy the newer app first (a rollout of the release the migration names), then roll the contract release.                                                                                      |
| Deploy: "rolled back to the old one"                             | The new image was not healthy on that school; the server restored the old one. Read the school's container log on the VPS.                                                                                                                              |
| Deploy: "rollback failed"                                        | The school may be down. Go to the VPS now; `deploy/README.md` has the recovery steps.                                                                                                                                                                   |
| credentials show `auth_failed` / `unreachable`                   | The database password changed, the project is paused, or the network is blocked. Fix the URL in `SCHOOL_DB_URLS`, restart, Refresh versions.                                                                                                            |
| "The backup failed, so no migration was run: pg_dump failed..."  | Read the tool's message. Usual causes: a `pg_dump` older than the school's Postgres, a wrong URL or password, the project paused, or a lock wait (`--lock-wait-timeout`) while the app was changing the schema. Nothing was migrated; Retry once fixed. |
| "...upload to R2 failed" / "check of the uploaded backup failed" | The R2 endpoint, bucket or token is wrong, or the token lacks write access to that bucket. Nothing was migrated.                                                                                                                                        |
| "A backup was uploaded (...) but could not be recorded"          | The control plane could not be reached right after the upload. The object is in R2 under the key shown; nothing was migrated. Retry takes a fresh backup.                                                                                               |
| "pg_dump timed out after N minutes"                              | A large database. Raise `BACKUP_TIMEOUT_MINUTES`. The job's heartbeat keeps running meanwhile, so it is not requeued.                                                                                                                                   |
| The worker will not start: "BACKUP_AGE_RECIPIENT ..."            | A backup setting is missing or wrong. `BACKUP_AGE_RECIPIENT` must be the **public** key (`age1...`), never the private one.                                                                                                                             |
