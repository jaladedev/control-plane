# VPS deploy script

`school-deploy` is the one program the control plane's deploy worker may run on
the VPS (plan section 3.2). It runs as the **forced command** of a restricted
SSH key, so the key cannot do anything else.

```
create <slug> <tag> <hostname>...   env file on stdin; pulls, starts, waits for health, adds the proxy route
deploy <slug> <tag>                 pulls, swaps, waits for health; goes back to the old tag if it is not healthy
reconfigure <slug>                  new env file on stdin; restarts on the same tag
rollback <slug>                     back to the previous tag (same health check)
remove <slug>                       stops the container, removes its route and env file
status <slug>                       current and previous tag, and whether the container runs
```

`<tag>` must be a full 40-character commit hash (what CI tags images with).
`<slug>` and hostnames are lowercase and checked against strict patterns. The last
line of output is always `RESULT {"slug":…,"action":…,"status":…,"tag":…}`.

| Exit | Meaning                                                                                                                                                |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0    | Done                                                                                                                                                   |
| 2    | Bad command, slug, tag, hostname or env file                                                                                                           |
| 3    | Unknown or already-existing school, or no previous version                                                                                             |
| 10   | New version unhealthy; **rolled back** to the old one (deploy failed). For `reconfigure`: unhealthy on the new settings; the old env file was put back |
| 11   | New version unhealthy and the rollback failed too: look at the server                                                                                  |
| 12   | Another operation is running for that school                                                                                                           |
| 13   | The proxy would not load the route                                                                                                                     |
| 14   | `create` failed and everything it made was removed                                                                                                     |
| 15   | The image could not be pulled; nothing changed                                                                                                         |

**Healthy** means the container runs and `/api/health` answers `ok` with this tag as
its `version` and this school's `slug`. It is the shallow check on purpose, so a
database blip never fails or rolls back a deploy.

## Server setup (once)

1. Install Docker and run Caddy **in Docker** on a network the schools share:
   `docker network create schools`, and start the Caddy container named `caddy` on it.
   Add `import /etc/caddy/schools.d/*.caddy` to the Caddyfile and mount that folder.
2. `install -m 755 -o root -g root deploy/school-deploy /usr/local/bin/school-deploy`
3. `mkdir -p /etc/school-apps/env /etc/caddy/schools.d /var/lib/school-apps`, all root-only
   (`chmod 700 /etc/school-apps /etc/school-apps/env /var/lib/school-apps`).
4. `docker login ghcr.io` once as root with a **read-only** pull token.
5. Optional `/etc/school-apps/deploy.conf` (root-owned, shell syntax) to override
   `IMAGE_REPO`, `MEMORY`, `CPUS`, `NETWORK`, `HEALTH_TIMEOUT`, and so on.
6. In root's `~/.ssh/authorized_keys`, for the worker's key only:

   ```
   restrict,command="/usr/local/bin/school-deploy" ssh-ed25519 AAAA… control-plane-deploy
   ```

   with `PermitRootLogin prohibit-password`. `restrict` turns off forwarding, a
   terminal and any client-supplied environment.

## What is and is not verified

Tested (`tests/deploy-script.test.ts`, 49 cases, against a fake `docker` and `curl`):
input checking, injection attempts staying inert, the env-file rules, the
health-gated swap, automatic rollback, `rollback`, cleanup after a failed `create`,
`remove`, `reconfigure` (new settings applied, old ones put back when unhealthy), and per-school locking.

**Not verified:** anything on a real server. The real `docker run` flags (memory and
CPU limits, `--cap-drop ALL`, `no-new-privileges`) have never started the real image,
so confirm the app runs under them. The same goes for Caddy loading the route file
and reaching the container by name, the registry pull, and the restricted SSH
key itself. Run the plan's staging-container drill first. A deploy briefly stops the
school while the container swaps (the plan's "restart"), so there is a short gap.
