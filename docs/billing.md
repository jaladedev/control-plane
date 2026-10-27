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

The signature covers `claim-v1`, the school slug, the timestamp and the SHA-256 of the exact
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

### Keys

Each school signs with its own Ed25519 key. The control plane stores **only the public
key**, so nothing it holds can forge a claim.

1. On the school's server: `npm run claim-key` (in school_app). Put the private key in
   that school's env file as `CLAIM_SIGNING_KEY`. It never leaves that server.
2. Send the public key to the control plane's owner, who pastes it under **Payment claim
   keys** on the school's page.
3. To rotate: add the new public key, switch the school's env file, then **Revoke** the old one.

## What is not built yet

- **Paystack** (plan M3): card payments, webhooks, receipts.
- The **renewal screen in school_app** that builds and sends this request. The signing
  module, key generator and contract test are in school_app; the screen is not.
- **Viewing proof of payment** (the claim carries a path; nothing fetches or shows it yet).
- Mid-session **top-ups**, **refunds**, PDF **invoices and receipts**, and automatic suspension.
- **Rate limiting** on the claim endpoint (the signature already stops everyone but the school).
