"use server";

import { redirect } from "next/navigation";
import {
  signInWithPassword,
  signOutCurrent,
  verifyChallenge,
  verifyEnrolment,
} from "@/lib/actions/auth";

// Form actions for the sign-in pages. They redirect with a short error code,
// which the pages turn into a message.

export async function signInAction(formData: FormData) {
  const email = String(formData.get("email") ?? "")
    .trim()
    .toLowerCase();
  const password = String(formData.get("password") ?? "");
  if (!email || !password) redirect("/login?error=invalid");

  const result = await signInWithPassword(email, password);
  if (!result.ok) redirect(`/login?error=${result.reason}`);
  redirect(result.next);
}

export async function verifyMfaAction(formData: FormData) {
  const factorId = String(formData.get("factorId") ?? "");
  const mode = String(formData.get("mode") ?? "");
  const code = String(formData.get("code") ?? "").replace(/\s/g, "");
  if (!factorId || !/^\d{6}$/.test(code)) redirect("/mfa?error=code");

  const ok =
    mode === "enrol"
      ? await verifyEnrolment(factorId, code)
      : await verifyChallenge(factorId, code);
  if (!ok) redirect("/mfa?error=code");
  redirect("/");
}

export async function signOutAction() {
  await signOutCurrent();
  redirect("/login");
}
