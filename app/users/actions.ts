"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import {
  createDashboardUser,
  setDashboardUserActive,
  setDashboardUserRole,
} from "@/lib/actions/users";

// Form actions for the Users page. Each one does its work through the guarded
// functions in lib/actions/users.ts and comes back with ?ok or ?error=<text>.

function fail(error: unknown): never {
  const message = error instanceof Error ? error.message : "Something went wrong.";
  redirect(`/users?error=${encodeURIComponent(message)}`);
}

export async function createUserAction(formData: FormData) {
  try {
    await createDashboardUser({
      email: String(formData.get("email") ?? ""),
      role: String(formData.get("role") ?? ""),
      temporaryPassword: String(formData.get("password") ?? ""),
    });
  } catch (error) {
    fail(error);
  }
  revalidatePath("/users");
  redirect("/users?ok=created");
}

export async function setRoleAction(formData: FormData) {
  try {
    await setDashboardUserRole({
      userId: String(formData.get("userId") ?? ""),
      role: String(formData.get("role") ?? ""),
    });
  } catch (error) {
    fail(error);
  }
  revalidatePath("/users");
  redirect("/users?ok=role");
}

export async function setActiveAction(formData: FormData) {
  try {
    await setDashboardUserActive({
      userId: String(formData.get("userId") ?? ""),
      active: formData.get("active") === "true",
    });
  } catch (error) {
    fail(error);
  }
  revalidatePath("/users");
  redirect("/users?ok=active");
}
