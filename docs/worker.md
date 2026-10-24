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

## If something goes wrong

| Symptom                                                   | Meaning and fix                                                                                                                                                                                               |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "A job has been waiting N minutes" on the screen          | The worker is not running, or cannot reach the control plane. Start it and read its log.                                                                                                                      |
| A step failed with a migration error                      | That migration was rolled back completely; earlier ones in the step stay applied. Fix the SQL with a **new** migration, register a new release, plan a new rollout. Retry only helps for a transient failure. |
| "has migrations the control plane does not know"          | Someone applied SQL to that school outside the control plane. Find out what, and register it or reconcile the school.                                                                                         |
| "Another migration run holds this school's database lock" | A run (or the Supabase CLI) is using that database. Wait, then Retry.                                                                                                                                         |
| "contract migration that needs app version..."            | The school's app is older than that migration requires. Deploy the newer app first (a rollout of the release the migration names), then roll the contract release.                                            |
| Deploy: "rolled back to the old one"                      | The new image was not healthy on that school; the server restored the old one. Read the school's container log on the VPS.                                                                                    |
| Deploy: "rollback failed"                                 | The school may be down. Go to the VPS now; `deploy/README.md` has the recovery steps.                                                                                                                         |
| credentials show `auth_failed` / `unreachable`            | The database password changed, the project is paused, or the network is blocked. Fix the URL in `SCHOOL_DB_URLS`, restart, Refresh versions.                                                                  |
