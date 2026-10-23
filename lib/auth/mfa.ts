import { createClient } from "@/lib/supabase/server";

// TOTP (authenticator app) is the only second factor: it needs no SMS or
// email service and no paid Supabase add-on.

export type MfaState =
  | { mode: "challenge"; factorId: string }
  | { mode: "enrol"; factorId: string; qrCode: string; secret: string };

/**
 * Decides what the 2FA page shows: enter a code (a verified authenticator app
 * exists) or set one up. Setting up starts a fresh enrolment, and first removes
 * any half-finished one from an earlier visit.
 */
export async function loadMfaState(): Promise<MfaState> {
  const supabase = await createClient();
  const { data: factors, error } = await supabase.auth.mfa.listFactors();
  if (error) throw new Error(error.message);

  const verified = factors.totp.find((f) => f.status === "verified");
  if (verified) return { mode: "challenge", factorId: verified.id };

  for (const stale of factors.all.filter(
    (f) => f.factor_type === "totp" && f.status !== "verified"
  )) {
    await supabase.auth.mfa.unenroll({ factorId: stale.id });
  }
  const { data, error: enrolError } = await supabase.auth.mfa.enroll({
    factorType: "totp",
    friendlyName: "Authenticator app",
  });
  if (enrolError || !data) throw new Error(enrolError?.message ?? "Could not start 2FA setup.");
  return { mode: "enrol", factorId: data.id, qrCode: data.totp.qr_code, secret: data.totp.secret };
}
