import type { createAdminClient } from "@/lib/supabase/admin";
import type { SchoolAuthDeps } from "@/lib/billing/school-request";

type Admin = ReturnType<typeof createAdminClient>;

/** The database lookups every signed school request needs, in one place. */
export function schoolAuthDeps(admin: Admin): SchoolAuthDeps {
  return {
    findSchool: async (slug) => {
      const { data } = await admin
        .from("schools")
        .select("id, status")
        .eq("slug", slug)
        .maybeSingle();
      return data ? { id: data.id as string, status: data.status as string } : null;
    },
    publicKeys: async (schoolId) => {
      const { data } = await admin
        .from("school_signing_keys")
        .select("public_key")
        .eq("school_id", schoolId)
        .is("revoked_at", null);
      return (data ?? []).map((k) => k.public_key as string);
    },
    rateLimit: async (bucket, windowSeconds, max) => {
      const { data, error } = await admin.rpc("rate_limit_hit", {
        p_bucket: bucket,
        p_window_seconds: windowSeconds,
        p_max: max,
      });
      if (error) throw new Error(error.message);
      // Only an explicit "no" blocks; anything unexpected lets the school through.
      return data !== false;
    },
  };
}
