import { headers } from "next/headers";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Actor } from "@/lib/auth/guards";

// The audit trail. Rule (plan section 6): no write action ships before it
// writes an audit_log row. Actions use withAudit(), which writes the row FIRST
// and refuses to continue if it cannot, so nothing is ever done without a
// record. If the action then fails, a second "<action>.failed" row says so.

export type AuditEntry = {
  action: string;
  schoolId?: string | null;
  details?: Record<string, unknown>;
};

// Anyone who can be named in the log: a full actor, or a partial one such as a
// failed sign-in (only an email) or someone between password and 2FA.
type Who = { id?: string | null; email?: string | null; role?: string | null };

async function requestIp(): Promise<string | null> {
  try {
    const h = await headers();
    return (
      h.get("cf-connecting-ip") ??
      h.get("x-forwarded-for")?.split(",")[0]?.trim() ??
      h.get("x-real-ip") ??
      null
    );
  } catch {
    return null; // not inside a request (scripts, tests)
  }
}

/** Writes one audit row. Throws if it cannot. */
export async function writeAudit(who: Who, entry: AuditEntry): Promise<void> {
  const { error } = await createAdminClient()
    .from("audit_log")
    .insert({
      actor_id: who.id ?? null,
      actor_email: who.email ?? null,
      role: who.role ?? null,
      action: entry.action,
      school_id: entry.schoolId ?? null,
      details: entry.details ?? {},
      ip: await requestIp(),
    });
  if (error) throw new Error(`Could not write the audit log: ${error.message}`);
}

/**
 * Runs `fn` only after its audit row is written. If `fn` throws, records
 * "<action>.failed" (best effort) and rethrows the original error.
 */
export async function withAudit<T>(
  actor: Actor,
  entry: AuditEntry,
  fn: () => Promise<T>
): Promise<T> {
  await writeAudit(actor, entry);
  try {
    return await fn();
  } catch (error) {
    try {
      await writeAudit(actor, {
        ...entry,
        action: `${entry.action}.failed`,
        details: {
          ...entry.details,
          error: error instanceof Error ? error.message : String(error),
        },
      });
    } catch {
      // The original error matters more than a failure to record the failure.
    }
    throw error;
  }
}
