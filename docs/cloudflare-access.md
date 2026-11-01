# Cloudflare Access in front of the dashboard

The dashboard sits behind [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/access-controls/):
a person signs in with your identity provider (or a one-time PIN) **before** the app's own login
(Supabase password and 2FA) is even reachable. The app then checks Cloudflare's signed token itself, so
a request that reaches the server some other way, for example by its IP address, gets a plain 403.

```
browser ──► Cloudflare Access (who may even see the app) ──► the app: Access token check ──► login + 2FA
school servers, Paystack, GitHub cron ──► Bypass paths only ──► the app: each checks its own signature
```

## 1. In Cloudflare (Zero Trust)

1. **Access controls → Applications → Add an application → Self-hosted.** Use the dashboard's
   hostname, and add a policy that **allows** only the people who should see it (your email addresses).
2. Open the application and copy its **Application Audience (AUD) tag**
   (_Additional settings_). It never changes unless the application is deleted and recreated.
3. Note your **team domain**, `<team>.cloudflareaccess.com` (Zero Trust → Settings → Custom pages,
   or the address you sign in at).
4. **Bypass the machine endpoints.** These are called by servers that cannot sign in to Access, and each
   one checks its own signature or secret. Add them as separate applications on the same hostname, each
   with a single policy whose action is **Bypass** and whose rule includes **Everyone**:

   | Path                                                  | Called by           | Checks                 |
   | ----------------------------------------------------- | ------------------- | ---------------------- |
   | `/api/claims`, `/api/claims/proof`                    | a school's server   | the school's signature |
   | `/api/invoices`, `/api/receipts`, `/api/receipts/pdf` | a school's server   | the school's signature |
   | `/api/paystack/checkout`                              | a school's server   | the school's signature |
   | `/api/paystack/webhook`                               | Paystack            | Paystack's signature   |
   | `/api/cron/health`                                    | the GitHub schedule | `CRON_SECRET`          |
   | `/api/health`                                         | uptime monitors     | nothing (no data)      |

   The app's own list is `ALWAYS_PUBLIC` in `lib/access.ts`; the app skips the token check for exactly
   those paths, so the two lists must match. Without these bypasses, school payment claims, card
   payments, Paystack's webhook and the health check all stop working, because Access answers them with
   a login page.

## 2. In the app's environment

| Setting                 | Value                            |
| ----------------------- | -------------------------------- |
| `CF_ACCESS_TEAM_DOMAIN` | `your-team.cloudflareaccess.com` |
| `CF_ACCESS_AUD`         | the application's AUD tag        |

Set both or neither; with neither, the app does not check Access (it behaves as before). Only
`*.cloudflareaccess.com` team domains are accepted, so the signing keys cannot be fetched from anywhere
else. A half-set or malformed value makes every request answer 500 and logs why, rather than running
without the check.

## What the app checks

For every request except the bypass paths and Next's static files, the `Cf-Access-Jwt-Assertion` header
must hold a token that:

- is signed **RS256** by one of the keys published at `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`
  (any other algorithm, including `none`, is refused);
- names your team as issuer and your application's AUD tag as audience;
- has not expired (30 seconds of clock difference are allowed).

Answers: **403** for a missing or invalid token (the message never says which check failed);
**503** if Cloudflare's keys cannot be read at all and none are cached. A check that cannot be made is a
refusal. Keys are cached for an hour and read again when a token names a key that is not cached (at most
once a minute), so Cloudflare rotating its key needs no restart.

## What it does not do

- It does not tie the Access identity to the dashboard account: someone allowed through Access still has
  to sign in with their own dashboard account and 2FA, and the two emails need not match.
- Static files under `/_next/static` are not behind the check (they hold no data).
- Revoking someone's Access session does not end their dashboard session; deactivate the dashboard user
  for that (the **Users** page).

## Checking it works

1. From outside Cloudflare, request the origin directly, for example `curl -i http://<server-ip>:3000/`:
   expect **403** "only reachable through Cloudflare Access".
2. Open the dashboard in a private window: expect the Cloudflare login, then the app's own login.
3. `curl -i https://<dashboard>/api/health`: expect **200** with no Access login.
4. In a school, claim a payment or open a card checkout: expect it to work.
5. Run the **Health** workflow by hand in GitHub: expect it to pass.

Not verified: this was tested against a real server with the check on, and against tokens signed with
generated RSA keys, but not against a live Cloudflare account. The exact buttons in Cloudflare's dashboard
may have moved; the settings you need are the application's AUD tag and team domain.
