"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { ZodError } from "zod";
import { createSchool, setSchoolStatus, updateSchool } from "@/lib/actions/schools";

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
