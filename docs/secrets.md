# Where the worker gets school credentials

The worker needs two kinds of secret for each school: its **database URL** (to run migrations and
read its state) and its **container settings** (its Supabase project and keys, R2 bucket and keys,
signing secrets; applied when a school is provisioned or its settings are applied). The dashboard
holds neither. The worker reads them from **one** of two places, chosen at start-up:

| Source                             | Set                                                                      | Changing a secret                               |
| ---------------------------------- | ------------------------------------------------------------------------ | ----------------------------------------------- |
| The worker's environment           | `SCHOOL_DB_URLS` (and `SCHOOL_APP_ENVS` to provision or apply)           | Edit the env file, restart the worker           |
| [Infisical](https://infisical.com) | `INFISICAL_CLIENT_ID`, `INFISICAL_CLIENT_SECRET`, `INFISICAL_PROJECT_ID` | Edit it in Infisical; picked up within a minute |

Setting both is refused at start-up: with Infisical, `SCHOOL_DB_URLS` and `SCHOOL_APP_ENVS` must not
also be in the worker's environment, or the secrets would live in two places that can disagree.

## Layout in Infisical

One folder per school, named by its slug, under one base folder (`/schools` by default):

```
/schools/greenfield
    DATABASE_URL                 postgresql://postgres:...@db.<ref>.supabase.co:5432/postgres   (direct, not the pooler)
    SUPABASE_URL                 https://<ref>.supabase.co
    SUPABASE_ANON_KEY
    SUPABASE_SERVICE_ROLE_KEY
    R2_ENDPOINT, R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY
    IMPERSONATION_SIGNING_SECRET
    ...                          any other container setting (Paystack, Resend, CONTROL_PLANE_URL, ...)
/schools/hillcrest
    DATABASE_URL
```

- `DATABASE_URL` is the school's database URL. **Every other key** in the folder is a container
  setting, exactly as in `SCHOOL_APP_ENVS` (the same checks run before anything is changed).
- A school with only `DATABASE_URL` can be migrated and backed up but cannot be provisioned or have
  settings applied; the dashboard says its settings are missing.
- Secrets in the base folder itself, in a deeper folder, or in a folder whose name is not a valid slug
  are ignored.

## Setting it up

1. In Infisical, create a project and an environment (default `prod`), and the folders above.
2. Create a **machine identity** with **Universal Auth**, give it **read-only** access to
   `/schools` in that environment, and create a client secret for it.
3. Put these in the worker's environment, and remove `SCHOOL_DB_URLS` and `SCHOOL_APP_ENVS`:

   | Setting                   | Default                     |                                                               |
   | ------------------------- | --------------------------- | ------------------------------------------------------------- |
   | `INFISICAL_CLIENT_ID`     |                             | the identity's client ID                                      |
   | `INFISICAL_CLIENT_SECRET` |                             | the client secret                                             |
   | `INFISICAL_PROJECT_ID`    |                             | the project's ID                                              |
   | `INFISICAL_URL`           | `https://app.infisical.com` | `https://eu.infisical.com` for the EU cloud, or your own host |
   | `INFISICAL_ENVIRONMENT`   | `prod`                      | the environment's slug                                        |
   | `INFISICAL_SECRETS_PATH`  | `/schools`                  | the base folder                                               |
   | `INFISICAL_CACHE_SECONDS` | `60` (10 to 3600)           | how long a read is reused                                     |

4. Start the worker. It signs in and reads every school once **before doing anything else**, so
   wrong credentials stop the start with a plain message (it never prints a secret).

The worker's environment now holds one credential for Infisical, which can only read, instead of
every school's database password and keys. `npm run adopt-school` reads the same settings.

## How it behaves

- **Rotation without a restart.** Reads are cached for `INFISICAL_CACHE_SECONDS`, so a changed secret
  is used by the next job after that. Apply settings still needs the new values to be in Infisical
  first; edit them there instead of in the env file and restart.
- **Infisical unreachable.** The last good read keeps being used for up to 15 minutes, then jobs that
  need a secret fail with "Infisical could not be reached." and are retried like any other failure.
- **Redaction.** Every secret ever read in this process, including one since rotated away, is
  scrubbed from logs and stored errors.
- **Sign-in.** The worker signs in with the client ID and secret and signs in again shortly before
  the access token ends. Redirects are refused, and plain `http` is accepted only for a server on the
  same machine.

## Moving a school over

Moving school by school is not possible: the worker uses one source for all of them. Instead:

1. Create every school's folder in Infisical, copying the values from `SCHOOL_DB_URLS` and
   `SCHOOL_APP_ENVS`.
2. Stop the worker, replace those two settings with the `INFISICAL_*` ones, start it.
3. Check **Billing** and one school's page load, and run **Refresh versions**; a school with a missing
   or wrong `DATABASE_URL` shows as `unreachable`.
4. Delete the old values from the env file and from wherever it was backed up.

Not verified: this has been written against Infisical's published API and tested with a fake server.
It has not been run against a live Infisical, so do step 3 on a quiet day.
