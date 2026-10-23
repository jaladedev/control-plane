import { createClient } from "@supabase/supabase-js";
import { env } from "@/lib/env";

// Service-role client: bypasses row-level security. Server-only, and only for
// code that has already checked who is asking (lib/auth/guards.ts) and writes
// an audit row (lib/audit.ts). ESLint restricts who may import this.
export function createAdminClient() {
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
