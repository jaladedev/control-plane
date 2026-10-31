# Rotating a school's keys

Plan milestone M6. The rule is **new key in, check, old key out**: the old key is revoked at its
source only after the school is healthy on the new one. The dashboard holds none of these values.
They live in the worker's environment (`SCHOOL_DB_URLS`, `SCHOOL_APP_ENVS`; interim, until Infisical),
and **Apply settings** (school page, owner only, type the school's name) tells the worker to put the
current `SCHOOL_APP_ENVS` entry onto the running container.

## What Apply settings does

1. Checks the settings are complete and belong to this school (same checks as provisioning).
2. Proves the **R2 key** can read, write and delete in the bucket. Nothing is restarted if it cannot.
3. Asks the server what it runs and refuses if that is not what the dashboard says.
4. Sends the new env file over SSH (`school-deploy reconfigure`). The server restarts the container on
   the **same image**, waits for health, and keeps the old env file only until the new one is healthy.
   If the school is not healthy, **the old file is put back** and the old container restarted (exit 10).
5. Probes `https://<hostname>/api/health?deep=1` from outside. This reaches the school's database, so a
   service role key that does not work shows up here.
6. Reports on Telegram. A school running its **old** settings again says so and tells you not to revoke.

One attempt only: a failed apply is never retried by itself.

## Per key

| Key                               | Where it lives                                                                          | Steps                                                                                                                                                                                                                                                                                                                   |
| --------------------------------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R2 access key                     | School's R2 account; worker `SCHOOL_APP_ENVS`                                           | Create a **second** key limited to the bucket. Put it in `SCHOOL_APP_ENVS`, restart the worker, **Apply settings**. When it reports success, delete the old key in Cloudflare.                                                                                                                                          |
| Supabase service role / anon keys | School's Supabase project; `SCHOOL_APP_ENVS`                                            | Rotating them means rotating the project's JWT secret, which changes **both** keys and signs everyone out. Do it in a quiet hour: rotate in Supabase, update both values in `SCHOOL_APP_ENVS`, restart the worker, Apply settings. There is no overlap period, so the school is broken between the first and last step. |
| Impersonation signing secret      | School's env **and** the dashboard's `SCHOOL_SIGNING_SECRETS` for this school           | The two must match. Change the dashboard's value and redeploy it, change `SCHOOL_APP_ENVS`, restart the worker, Apply settings. Support links made with the old secret stop working at once.                                                                                                                            |
| Payment claim key                 | School's env (private key); public half under **Payment claim keys** on the school page | Run `npm run claim-key` in school_app. **Add the new public key first**, put the new private key in `SCHOOL_APP_ENVS`, Apply settings, then **revoke the old public key**. Several keys can be active at once, so there is no gap.                                                                                      |
| Database password                 | School's Supabase project; worker `SCHOOL_DB_URLS` only                                 | Not part of the container. Reset it in Supabase, update `SCHOOL_DB_URLS`, restart the worker, then **Refresh versions** on the Migrations screen to prove the connection. No Apply settings.                                                                                                                            |
| Deploy SSH key                    | Worker; `authorized_keys` on the server                                                 | Not per school. Add the new key to `authorized_keys` (same `restrict,command=` line), switch `DEPLOY_SSH_KEY_FILE`, restart the worker, run a status check, then remove the old line.                                                                                                                                   |

## If it goes wrong

- **"The old settings are running again, so do not revoke the old keys."** The new settings were bad.
  The school is on the old ones. Fix the entry in `SCHOOL_APP_ENVS`, restart the worker, apply again.
- **"The new settings are running, but the school does not look right."** The container is healthy on
  the new settings but the outside check failed (usually a service role key that does not work). The old
  settings are **not** restored automatically. Put the previous values back in `SCHOOL_APP_ENVS`,
  restart the worker, apply again, and only then investigate.
- **"Nothing was changed."** The new R2 key was refused before any restart. The school is untouched.

## What is and is not verified

Tested without a server: the `reconfigure` command against a fake docker and curl (new file written and
restarted on the same tag, no image pull, route left alone, old file restored on an unhealthy start,
refused file formats, locking, nothing secret on a command line or in the log), the worker steps and
their order, and the database rules. **Not verified:** a real server, a real container, real Cloudflare
and Supabase key changes. The Supabase JWT rotation steps above are written from how Supabase describes
it and have not been tried. Rehearse every row on the test school first.
