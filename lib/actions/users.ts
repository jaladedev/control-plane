import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireActor } from "@/lib/auth/guards";
import { withAudit } from "@/lib/audit";
import { ROLES } from "@/lib/roles";

// User management. Owner only. Each function checks the caller, validates the
// input, writes its audit row first (withAudit), and only then changes
// anything. A new person gets a temporary password from the owner and must
// enrol an authenticator app at their first sign-in (the 2FA step is
// mandatory for every account, so there is no way to skip it).

const emailSchema = z.string().trim().toLowerCase().email();
const roleSchema = z.enum(ROLES);

export async function createDashboardUser(input: {
  email: string;
  role: string;
  temporaryPassword: string;
}): Promise<{ id: string }> {
  const actor = await requireActor(["owner"]);
  const email = emailSchema.parse(input.email);
  const role = roleSchema.parse(input.role);
  const password = z.string().min(12, "Use at least 12 characters.").parse(input.temporaryPassword);

  return withAudit(actor, { action: "user.create", details: { email, role } }, async () => {
    const admin = createAdminClient();
    const { data, error } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    if (error || !data.user) throw new Error(error?.message ?? "Could not create the login.");

    const { error: insertError } = await admin
      .from("dashboard_users")
      .insert({ id: data.user.id, email, role, created_by: actor.id });
    if (insertError) {
      await admin.auth.admin.deleteUser(data.user.id); // don't leave a login with no role
      throw new Error(insertError.message);
    }
    return { id: data.user.id };
  });
}

export async function setDashboardUserRole(input: { userId: string; role: string }): Promise<void> {
  const actor = await requireActor(["owner"]);
  const userId = z.string().uuid().parse(input.userId);
  const role = roleSchema.parse(input.role);

  const admin = createAdminClient();
  const { data: before, error: readError } = await admin
    .from("dashboard_users")
    .select("email, role")
    .eq("id", userId)
    .single();
  if (readError || !before) throw new Error("That user does not exist.");

  await withAudit(
    actor,
    {
      action: "user.role_change",
      details: { user_id: userId, email: before.email, from: before.role, to: role },
    },
    async () => {
      // The database refuses to demote the last active owner.
      const { error } = await admin.from("dashboard_users").update({ role }).eq("id", userId);
      if (error) throw new Error(error.message);
    }
  );
}

export async function setDashboardUserActive(input: {
  userId: string;
  active: boolean;
}): Promise<void> {
  const actor = await requireActor(["owner"]);
  const userId = z.string().uuid().parse(input.userId);

  const admin = createAdminClient();
  const { data: before, error: readError } = await admin
    .from("dashboard_users")
    .select("email, role")
    .eq("id", userId)
    .single();
  if (readError || !before) throw new Error("That user does not exist.");

  await withAudit(
    actor,
    {
      action: input.active ? "user.activate" : "user.deactivate",
      details: { user_id: userId, email: before.email, role: before.role },
    },
    async () => {
      // Deactivate in the table first: it refuses to deactivate the last owner,
      // and nothing else has changed yet if it does.
      const { error } = await admin
        .from("dashboard_users")
        .update({ is_active: input.active })
        .eq("id", userId);
      if (error) throw new Error(error.message);

      // Also block the login itself, so a live session cannot be refreshed.
      const { error: banError } = await admin.auth.admin.updateUserById(userId, {
        ban_duration: input.active ? "none" : "876000h",
      });
      if (banError) throw new Error(banError.message);
    }
  );
}
