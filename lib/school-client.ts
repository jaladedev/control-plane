import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { env } from "@/lib/env";

// A service-role client for ONE school's Supabase project, used only to call
// set_license(). Interim design: the keys live in the SCHOOL_SERVICE_KEYS
// environment variable (JSON, slug -> key) until the secrets manager exists
// (plan M0 left it out). That makes this app's environment the most sensitive
// thing in the system: anyone who can read it can write to every school.

const keysSchema = z.record(z.string(), z.string().min(1));

export function createSchoolClient(slug: string, projectRef: string | null): SupabaseClient {
  if (!projectRef) throw new Error("Set the school's Supabase project ref first.");
  if (!/^[a-z0-9]{10,40}$/.test(projectRef)) {
    throw new Error(
      "The school's Supabase project ref looks wrong (expected 20 lowercase letters or digits)."
    );
  }
  if (!env.SCHOOL_SERVICE_KEYS) {
    throw new Error("SCHOOL_SERVICE_KEYS is not set in the control plane's environment.");
  }
  let keys: Record<string, string>;
  try {
    keys = keysSchema.parse(JSON.parse(env.SCHOOL_SERVICE_KEYS));
  } catch {
    throw new Error('SCHOOL_SERVICE_KEYS must be JSON like {"slug":"service-role-key"}.');
  }
  const key = keys[slug];
  if (!key) throw new Error(`No service key for "${slug}" in SCHOOL_SERVICE_KEYS.`);
  return createClient(`https://${projectRef}.supabase.co`, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
