"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { ZodError } from "zod";
import {
  addSigningKey,
  cancelInvoice,
  confirmClaim,
  createInvoice,
  extendInvoice,
  markInvoicePaid,
  rejectClaim,
  revokeSigningKey,
  setPrice,
  setPriceOverride,
} from "@/lib/actions/billing";

// Form actions for Billing, Prices and the school's signing keys. Each calls a
// guarded function in lib/actions/billing.ts and comes back with ?ok=<code> or
// ?error=<text>. redirect() throws, so it is only ever called outside the try.

function message(error: unknown): string {
  if (error instanceof ZodError) return error.issues.map((i) => i.message).join(" ");
  return error instanceof Error ? error.message : "Something went wrong.";
}
const fields = (formData: FormData) => Object.fromEntries(formData.entries());
const text = (formData: FormData, name: string) => String(formData.get(name) ?? "");

async function respond(path: string, run: () => Promise<unknown>, ok: string): Promise<never> {
  let target: string;
  try {
    await run();
    target = `${path}?ok=${ok}`;
  } catch (error) {
    target = `${path}?error=${encodeURIComponent(message(error))}`;
  }
  revalidatePath(path.split("?")[0]);
  redirect(target);
}

export const createInvoiceAction = async (f: FormData) =>
  respond("/billing", () => createInvoice(fields(f)), "invoice_created");

export const cancelInvoiceAction = async (f: FormData) =>
  respond(
    "/billing",
    () => cancelInvoice(text(f, "subscriptionId"), f.get("reason")),
    "invoice_cancelled"
  );

export const markPaidAction = async (f: FormData) =>
  respond(
    "/billing",
    () => markInvoicePaid(text(f, "subscriptionId"), f.get("paymentRef"), f.get("reason")),
    "marked_paid"
  );

export const extendInvoiceAction = async (f: FormData) =>
  respond(
    "/billing",
    () =>
      extendInvoice(
        text(f, "subscriptionId"),
        f.get("validUntil"),
        f.get("graceDays"),
        f.get("reason")
      ),
    "extended"
  );

export const confirmClaimAction = async (f: FormData) =>
  respond(
    "/billing",
    () => confirmClaim(text(f, "claimId"), f.get("amount"), f.get("reason")),
    "claim_confirmed"
  );

export const rejectClaimAction = async (f: FormData) =>
  respond("/billing", () => rejectClaim(text(f, "claimId"), f.get("reason")), "claim_rejected");

export const setPriceAction = async (f: FormData) =>
  respond(
    "/prices",
    () =>
      setPrice({
        item:
          f.get("item") === "feature"
            ? `feature:${text(f, "feature").trim().toLowerCase()}`
            : f.get("item"),
        value: f.get("value"),
        effectiveFrom: f.get("effectiveFrom"),
        reason: f.get("reason"),
        confirm: f.get("confirm"),
      }),
    "price_set"
  );

export const setOverrideAction = async (f: FormData) =>
  respond(
    "/prices",
    () =>
      setPriceOverride({
        schoolId: f.get("schoolId"),
        item:
          f.get("item") === "feature"
            ? `feature:${text(f, "feature").trim().toLowerCase()}`
            : f.get("item"),
        session: f.get("session"),
        kind: f.get("kind"),
        value: f.get("value"),
        reason: f.get("reason"),
      }),
    "override_set"
  );

export const addSigningKeyAction = async (f: FormData) =>
  respond(
    `/schools/${text(f, "schoolId")}`,
    () => addSigningKey(text(f, "schoolId"), f.get("publicKey")),
    "key_added"
  );

export const revokeSigningKeyAction = async (f: FormData) =>
  respond(
    `/schools/${text(f, "schoolId")}`,
    () => revokeSigningKey(text(f, "keyId")),
    "key_revoked"
  );
