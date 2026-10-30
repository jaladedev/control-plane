# Billing and transfer claims

How a school pays by bank transfer, and how that becomes a licence.

```
Prices ──► Quote ──► Invoice ──► (school pays by transfer) ──► Claim ──► Confirm ──► Licence pushed
 owner      preview    SUB-xxxx     school sends a signed         queue     a person     worker, into the
            frozen                  "I have sent it"                        checked the   school's own
                                                                            bank          database
```

A claim **pays nothing by itself**. Only **Confirm**, done by an owner or finance user
who has seen the money in the bank statement, marks an invoice paid, and that is also
what updates the school's licence.

## Prices (owner sets, owner and finance can read)

The **Prices** screen holds the catalog: base fee, the student allowance, the price of
each extra student, pro hosting, and each add-on. Nothing is hard-coded and nothing is
pre-filled: until the base fee and the allowance are set, no invoice can be made.

- Prices are **never edited**. A change is a new entry with a start date and a reason.
  It applies to new quotes only; an invoice keeps the prices it was made with.
- A change of more than 25% (up or down) needs the word `CHANGE` typed.
- A school can have an **override** for one item and one session: a fixed price or a
  percentage off. The quote shows it as its own marked line, with the list price beside it.
- All money is whole kobo. Naira typed into a form is parsed exactly, never as a float.

## Invoices and the Billing screen (owner and finance)

**New invoice** previews the quote (every line, the price used, any override), then
creates the invoice with that exact quote. The school pays against the invoice's
reference, `SUB-` and eight characters, which it writes in the bank narration.

One open invoice per school and session; one paid invoice per school and session.

On **Billing**:

- **Claims waiting** come first, oldest first, in red after 48 hours. **Confirm** asks for
  the amount your bank shows (which must equal the invoice exactly) and what you checked.
  **Reject** asks why, and the invoice opens again for a new claim. Both are audited.
- **Mark paid** is for a payment you saw with no claim (cash, or a transfer the school
  never reported). It refuses while a claim is waiting for that invoice.
- **Extend** moves a paid invoice's end dates later (never earlier) and pushes the licence.
- **Cancel** is for an invoice that was wrong and has no claim waiting.

Partial payments are not supported: reject the claim and issue a new invoice.

## How the licence follows payment

Confirm, Mark paid and Extend write the school's licence onto its registry row (next
version, student cap, add-ons, dates) and queue a `license_push` job. The worker pushes it
into the school's own database with `set_license()` over its direct connection, so the
web app needs no school key for this. A failed push is retried, the error shows on the
school's page, and a version the school already has is ignored, so repeating is safe.

The manual **Licence** form on a school's page still works. Whichever change is newest wins.

## Telegram

New claims (and a reminder after 48 hours) are announced by the control plane's own bot,
sent by the worker. Create a bot with @BotFather, send it a message, then set on the worker:
`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, and optionally `APP_URL` for the link. Without
them a notice fails visibly in the job list; **the claim still waits in the queue**. The
notice contains only school, amount, invoice, session and date.

## The claim request (what a school's server sends)

```
POST {CONTROL_PLANE_URL}/api/claims
content-type: application/json
x-school-slug:       greenfield
x-claim-timestamp:   1792749600                       (unix seconds, within 5 minutes)
x-claim-signature:   <base64url Ed25519 signature>

{ "subscription_reference": "SUB-0A1B2C3D",
  "client_ref": "claim-0001",             // the school's own id; a retry with the same one is harmless
  "amount_kobo": 15600000,
  "sent_on": "2026-10-24",
  "sender_name": "A. Bursar",
  "payer_reference": "NIP123",            // optional, the bank's reference
  "proof_path": "proofs/a.jpg",           // optional, where the proof is kept
  "claimed_by": "bursar@school.example" }
```

The signature covers the purpose (`claim-v1` here), the school slug, the timestamp and the SHA-256 of the exact
body bytes (see `lib/billing/claim-signature.ts`; school_app has an identical
`lib/controlPlaneClaim.ts`, and both repos assert the same literal signature).

| Status | Meaning                                                                       |
| ------ | ----------------------------------------------------------------------------- |
| 201    | Recorded (or already recorded: `{ ok: true, claim_id }`)                      |
| 400    | The body is not valid; the message says which field                           |
| 401    | Rejected. Always the same answer, whatever was wrong with the authentication  |
| 403    | The school is archived                                                        |
| 409    | A rule was broken (invoice already paid, a claim already waiting, wrong date) |
| 413    | Body over 8 KB                                                                |
| 429    | Too many requests (see "Rate limits"); `Retry-After` says how many seconds    |

### Keys

Each school signs with its own Ed25519 key. The control plane stores **only the public
key**, so nothing it holds can forge a claim.

1. On the school's server: `npm run claim-key` (in school_app). Put the private key in
   that school's env file as `CLAIM_SIGNING_KEY`. It never leaves that server.
2. Send the public key to the control plane's owner, who pastes it under **Payment claim
   keys** on the school's page.
3. To rotate: add the new public key, switch the school's env file, then **Revoke** the old one.

### Rate limits

Two fixed-window counters in the database (`rate_limit_hit`), so every instance of the web
app shares them:

- **Per client address, 30 a minute**, counted before anything is looked up. The address is
  the first entry of `x-forwarded-for`, so it only protects against a flood, not a determined
  forger (the signature does that).
- **Per school, 10 every 10 minutes**, counted once the signature has proved the school. A
  request that fails authentication never spends a school's allowance.

If the counter itself fails, the request goes through: a broken limiter must not stop a school
from paying. Limits are `CLAIM_LIMITS` in `lib/billing/claim-endpoint.ts`.

## Top-ups (extra students mid-session)

On a **paid** invoice, **Top up students** invoices extra students at today's extra-student
price (and the school's override for that session, shown on the line). The top-up has its own
reference, `TOP-` and eight characters, and waits under **Top-ups waiting for payment**.
Nothing changes for the school until a person marks it paid, with the amount the bank shows
(which must equal the top-up) and what they checked. Then the invoice's extra students and
`topup_kobo` go up, the school's allowance is raised, and a higher licence version is pushed.

- One waiting top-up per invoice. **Cancel** needs a reason.
- A top-up is marked paid by a person; the claim endpoint only takes `SUB-` references, so a
  school cannot claim a top-up yet.
- A top-up never changes the end dates.

## Refunds

An **owner** can refund a paid invoice within **14 days of payment** (`REFUND_WINDOW_DAYS`). The
word `REFUND` must be typed, and a reason is required.

- The whole invoice, paid top-ups included. There are no partial refunds, as with payments.
- This records the refund and **ends the licence at once** (a higher version, valid and grace
  both ending now). It does **not** move money: send it back from your bank yourself.
- The licence is only ended if the refunded invoice is the one the school is running on.
  Refunding an older session leaves a newer session's licence alone.
- A refunded invoice frees its session, so a new invoice can be made.

## Automatic suspension

The worker checks hourly (`AUTO_SUSPEND_AFTER_DAYS`, default 90, `0` turns it off). An active
school is suspended when its licence, **grace included**, ended more than that many days ago.
Schools are left alone if they have an open invoice or a claim waiting, or no licence at all.

- Each suspension writes an audit row (`school.auto_suspend`, by `system:auto-suspend`) and, when
  Telegram is set up, sends a notice.
- A suspension made by this rule is lifted by the payment that follows it: Confirm, Mark paid
  and Extend call the same licence step, which resumes the school (`school.auto_resume`).
- A suspension an owner made by hand is never lifted by a payment, only by an owner.
- What "suspended" does is unchanged: the registry status. It stops new invoices and pushes
  nothing to the school.

## Invoice and receipt PDFs

**Invoice (PDF)** is on every invoice waiting for payment; **Receipt (PDF)** on paid and
refunded ones. A receipt lists the quote's lines as they were issued, any paid top-ups, how and
when it was paid, and a refund notice if it was refunded. Receipts are numbered `RCT-` plus the
invoice reference's characters. Each download is audited.

Set `BILLING_ISSUER_NAME` and `BILLING_ISSUER_LINES` (lines separated by `|`: your address, the
bank details a school should pay into) on the web app so the PDFs carry them; without a name
the heading is left out. The PDF uses a built-in font, so only Latin-1 text shows (anything
else prints as `?`) and the naira sign is written `NGN`. An invoice whose lines do not add up
to its total is not printed.

## Open invoices (for the school's renewal screen)

`POST /api/invoices`, signed with purpose **`invoices-v1`**, body `{}`. Read-only. The answer
lists the school's own open invoices (`pending`, or `pending_confirmation` while a transfer
claim is checked) with their lines, who to pay (`pay_to`: `BILLING_ISSUER_NAME` and
`BILLING_ISSUER_LINES`) and whether card payments (`card_enabled`) and proof uploads
(`proof_enabled`) are switched on. This is what lets a school's screen show what is owed and
offer to pay it, instead of asking someone to copy a reference from a PDF.

## Receipts for the school

`POST /api/receipts` (signed, purpose **`receipts-v1`**, body `{}`) lists the school's paid and
refunded invoices, newest first (up to 50). `POST /api/receipts/pdf` (same purpose, body
`{ "reference": "SUB-0A1B2C3D" }`) answers with that invoice's receipt as a PDF, the same
document staff download from the Billing screen. A school only ever gets its own, only for an
invoice that was paid, and every download is audited (`receipt.school_download`). An invoice
whose lines do not add up to its total is not printed.

## Proofs of payment

A school can attach a photo or PDF of its transfer receipt. The file lives in the control
plane's **own** bucket (`PROOF_R2_*` on the web app), never a school's, and a school never holds
a credential for it:

1. The school's server sends `POST /api/claims/proof`, signed with purpose **`proof-v1`**, with
   `{ "content_type": "image/jpeg", "size_bytes": 250000 }`. JPEG, PNG, WebP or PDF, up to 5 MB.
2. The answer has `proof_path` (`proofs/<slug>/<uuid>.<ext>`), an `upload_url` good for five
   minutes and the `upload_headers` to send. The type and exact length are signed into the link,
   so the bucket refuses any other file.
3. The school `PUT`s the file to `upload_url` with those headers, then names `proof_path` in its
   claim. The claim endpoint and the database both refuse a path that is not that school's own.
4. Staff click **View proof** on the claim. That route (owner and finance) writes an audit row
   (`claim.proof_view`) and redirects to a link that works for two minutes.

Without the `PROOF_R2_*` settings the upload endpoint answers 503 and claims go without a proof.
Set all four or none; the app will not start with a partial set. Give the token Object Read &
Write on that bucket only, and add a lifecycle rule that deletes objects after, say, 400 days
(an upload that is never claimed otherwise stays). The proof is a photo of a bank receipt:
treat the bucket as private and never make it public.

## Card payments (Paystack)

One Paystack account, yours, receives every school's card payments.

1. The school's server sends `POST /api/paystack/checkout`, signed with purpose
   **`checkout-v1`**: `{ "subscription_reference": "SUB-0A1B2C3D", "payer_email": "...",
"return_url": "https://school.example/renewal" }`. The amount is **never** sent: it is the
   invoice's, read from the database.
2. The control plane records the checkout (`PSK-` and 16 characters is the reference) and asks
   Paystack for a payment page. The answer is `{ ok, authorization_url, reference }`; the
   school redirects the payer there. The reply is refused unless it is an https page on
   `paystack.com` for that reference.
3. When the payer pays, Paystack calls `POST /api/paystack/webhook`. The body's HMAC-SHA512
   signature (`x-paystack-signature`, your secret key) is checked before anything is read.
4. A database function matches the charge to its checkout and checks the amount and currency
   (NGN) against the invoice. If they match and the invoice is open, the invoice is paid
   (`method = paystack`, `payment_ref` = our reference) and the licence is pushed, exactly as
   for a confirmed transfer. A school suspended by the lapse rule is lifted.

Everything else is recorded as **needing review**, changes nothing for the school, shows under
**Card payments needing review** on the Billing screen and sends a Telegram notice: a charge of
the wrong amount or currency, a second charge for an invoice that is already paid, a charge for a
cancelled or refunded invoice. A person decides (usually: refund it from the Paystack dashboard)
and records what they did. The control plane does not move money.

- If the school also sent a transfer claim for the same invoice, a matching card payment closes
  that claim with the reason "paid by card" and pays the invoice.
- Paystack is told 200 for anything it should not resend, and 500 only when we could not write
  the payment down, so that it retries. A repeated webhook changes nothing.
- A card payment is for the invoice only. Top-ups are not paid by card yet.

Setup: put your **secret** key in `PAYSTACK_SECRET_KEY` on the web app, and set the webhook URL
in the Paystack dashboard to `https://<the dashboard>/api/paystack/webhook`. Paystack's webhook
source addresses are published and could be allowed at your host; the signature is what is
checked here. Try it with a `sk_test_` key first. Without the key, checkout answers "not
available" and schools pay by transfer.

## School side

school_app has the screen that uses all of this: **Bursary > School licence** (for an admin or
the bursar). It lists the school's open invoices (`/api/invoices`), offers **Pay by card**
(`/api/paystack/checkout`) and an **I have paid by transfer** form with an optional proof
(`/api/claims/proof`, then `/api/claims`). It works when the licence has lapsed. Each school
needs `CONTROL_PLANE_URL` and `CLAIM_SIGNING_KEY` in its env file, and its public key added on
the control plane (see school_app's `npm run claim-key`).

## What is not built yet

- A school **claiming or paying by card for a top-up** (top-ups are paid by finance for now).
- Refunding a card payment from here: refund it in the Paystack dashboard, then record it.
- Paying an invoice **partly**: a claim or card payment must equal the invoice.
