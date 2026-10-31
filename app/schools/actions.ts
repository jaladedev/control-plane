"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { ZodError } from "zod";
import { createSchool, setSchoolStatus, updateSchool } from "@/lib/actions/schools";
import { pushLicense, revokeLicense, setLicense } from "@/lib/actions/license";
import { createSupportLink } from "@/lib/actions/support";
import { startProvisioning } from "@/lib/actions/provision";

// Form actions for the schools screens: each does its work through the guarded
// functions in lib/actions/schools.ts and comes back with ?ok or ?error=<text>.

function message(error: unknown): string {
  if (error instanceof ZodError) return error.issues.map((i) => i.message).join(" ");
  return error instanceof Error ? error.message : "Something went wrong.";
}

const fields = (formData: FormData) => Object.fromEntries(formData.entries());

export async function createSchoolAction(formData: FormData) {
  let id: string;
  try {
    ({ id } = await createSchool(fields(formData)));
  } catch (error) {
    redirect(`/schools/new?error=${encodeURIComponent(message(error))}`);
  }
  revalidatePath("/");
  redirect(`/schools/${id}?ok=created`);
}

export async function updateSchoolAction(formData: FormData) {
  const id = String(formData.get("schoolId") ?? "");
  try {
    await updateSchool(id, fields(formData));
  } catch (error) {
    redirect(`/schools/${encodeURIComponent(id)}?error=${encodeURIComponent(message(error))}`);
  }
  revalidatePath("/");
  revalidatePath(`/schools/${id}`);
  redirect(`/schools/${id}?ok=saved`);
}

export async function setStatusAction(formData: FormData) {
  const id = String(formData.get("schoolId") ?? "");
  try {
    await setSchoolStatus(id, String(formData.get("status") ?? ""));
  } catch (error) {
    redirect(`/schools/${encodeURIComponent(id)}?error=${encodeURIComponent(message(error))}`);
  }
  revalidatePath("/");
  revalidatePath(`/schools/${id}`);
  redirect(`/schools/${id}?ok=status`);
}

export async function setLicenseAction(formData: FormData) {
  const id = String(formData.get("schoolId") ?? "");
  try {
    await setLicense(id, fields(formData));
  } catch (error) {
    redirect(`/schools/${encodeURIComponent(id)}?error=${encodeURIComponent(message(error))}`);
  }
  revalidatePath("/");
  revalidatePath(`/schools/${id}`);
  redirect(`/schools/${id}?ok=licensed`);
}

export async function pushLicenseAction(formData: FormData) {
  const id = String(formData.get("schoolId") ?? "");
  try {
    await pushLicense(id);
  } catch (error) {
    redirect(`/schools/${encodeURIComponent(id)}?error=${encodeURIComponent(message(error))}`);
  }
  revalidatePath("/");
  revalidatePath(`/schools/${id}`);
  redirect(`/schools/${id}?ok=pushed`);
}

export async function revokeLicenseAction(formData: FormData) {
  const id = String(formData.get("schoolId") ?? "");
  try {
    await revokeLicense(id, formData.get("confirm"));
  } catch (error) {
    redirect(`/schools/${encodeURIComponent(id)}?error=${encodeURIComponent(message(error))}`);
  }
  revalidatePath("/");
  revalidatePath(`/schools/${id}`);
  redirect(`/schools/${id}?ok=revoked`);
}

export async function provisionSchoolAction(formData: FormData) {
  const id = String(formData.get("schoolId") ?? "");
  try {
    await startProvisioning(id, fields(formData));
  } catch (error) {
    redirect(`/schools/${encodeURIComponent(id)}?error=${encodeURIComponent(message(error))}`);
  }
  revalidatePath("/");
  revalidatePath(`/schools/${id}`);
  redirect(`/schools/${id}?ok=provisioning`);
}

// Returns the link in the response body instead of redirecting, so the token
// never appears in a URL, a redirect or the page's own address bar.
export async function createSupportLinkAction(
  schoolId: string
): Promise<{ url: string; expiresAt: string } | { error: string }> {
  try {
    return await createSupportLink(schoolId);
  } catch (error) {
    return { error: message(error) };
  }
}
