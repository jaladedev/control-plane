import { randomUUID } from "node:crypto";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireActor } from "@/lib/auth/guards";
import { withAudit } from "@/lib/audit";
import {
  SCHOOL_STATUSES,
  schoolDetailsSchema,
  slugSchema,
  type SchoolDetails,
} from "@/lib/schools";

// Registry changes. Owner only for now (finance gets the licence screens in
// M2). Each function checks the caller, validates, writes its audit row
// first, and only then changes anything. No secrets go in these fields:
// connection strings and keys live in the secrets manager.

type Admin = ReturnType<typeof createAdminClient>;

// A hostname may belong to one school only.
async function assertHostnamesFree(admin: Admin, hostnames: string[], exceptId?: string) {
  if (hostnames.length === 0) return;
  let query = admin.from("schools").select("slug, hostnames").overlaps("hostnames", hostnames);
  if (exceptId) query = query.neq("id", exceptId);
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  if (data && data.length > 0) {
    throw new Error(`A hostname is already used by the school "${data[0].slug}".`);
  }
}

export async function createSchool(input: Record<string, unknown>): Promise<{ id: string }> {
  const actor = await requireActor(["owner"]);
  const slug = slugSchema.parse(input.slug);
  const details = schoolDetailsSchema.parse(input);
  const id = randomUUID();

  const admin = createAdminClient();
  await assertHostnamesFree(admin, details.hostnames);

  return withAudit(
    actor,
    {
      action: "school.create",
      schoolId: id,
      details: { slug, name: details.name, hostnames: details.hostnames },
    },
    async () => {
      const { error } = await admin.from("schools").insert({ id, slug, ...details });
      if (error) {
        throw new Error(
          error.code === "23505" ? `The slug "${slug}" is already in use.` : error.message
        );
      }
      return { id };
    }
  );
}

export async function updateSchool(
  schoolId: string,
  input: Record<string, unknown>
): Promise<void> {
  const actor = await requireActor(["owner"]);
  const id = z.string().uuid().parse(schoolId);
  const details = schoolDetailsSchema.parse(input);

  const admin = createAdminClient();
  const { data: before, error: readError } = await admin
    .from("schools")
    .select("*")
    .eq("id", id)
    .single();
  if (readError || !before) throw new Error("That school does not exist.");
  await assertHostnamesFree(admin, details.hostnames, id);

  // Record only what changes, old and new.
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const key of Object.keys(details) as (keyof SchoolDetails)[]) {
    if (JSON.stringify(before[key]) !== JSON.stringify(details[key])) {
      changes[key] = { from: before[key], to: details[key] };
    }
  }
  if (Object.keys(changes).length === 0) return;

  await withAudit(
    actor,
    { action: "school.update", schoolId: id, details: { slug: before.slug, changes } },
    async () => {
      const { error } = await admin.from("schools").update(details).eq("id", id);
      if (error) throw new Error(error.message);
    }
  );
}

export async function setSchoolStatus(schoolId: string, status: string): Promise<void> {
  const actor = await requireActor(["owner"]);
  const id = z.string().uuid().parse(schoolId);
  const next = z.enum(SCHOOL_STATUSES).parse(status);

  const admin = createAdminClient();
  const { data: before, error: readError } = await admin
    .from("schools")
    .select("slug, status")
    .eq("id", id)
    .single();
  if (readError || !before) throw new Error("That school does not exist.");
  if (before.status === next) return;

  await withAudit(
    actor,
    {
      action: "school.status_change",
      schoolId: id,
      details: { slug: before.slug, from: before.status, to: next },
    },
    async () => {
      const { error } = await admin.from("schools").update({ status: next }).eq("id", id);
      if (error) throw new Error(error.message);
    }
  );
}
