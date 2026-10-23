import { randomUUID } from "node:crypto";
import { z } from "zod";
import { env } from "@/lib/env";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireActor } from "@/lib/auth/guards";
import { withAudit } from "@/lib/audit";
import { normalizeHostname } from "@/lib/schools";
import { signImpersonationToken } from "@/lib/impersonation";

// Read-only support sessions. A support person (or an owner) asks for a link;
// the control plane signs it with THAT school's own IMPERSONATION_SIGNING_SECRET
// and returns a URL on the school's first hostname. The school checks the
// signature, the slug and the expiry, and accepts each link once.
//
// The audit row is written first and names the link (link_id = the token's
// jti), which is the same id the school records, so the two logs can be
// matched. The token itself is never logged or stored; it only goes back to
// the person who asked, once, in the response.

const SUPPORT_ROLES = ["owner", "support"] as const;
export const SUPPORT_LINK_TTL_SECONDS = 5 * 60;
const MIN_SECRET_LENGTH = 32;

const secretsSchema = z.record(z.string(), z.string().min(MIN_SECRET_LENGTH));

function signingSecretFor(slug: string): string {
  if (!env.SCHOOL_SIGNING_SECRETS) {
    throw new Error("SCHOOL_SIGNING_SECRETS is not set in the control plane's environment.");
  }
  let secrets: Record<string, string>;
  try {
    secrets = secretsSchema.parse(JSON.parse(env.SCHOOL_SIGNING_SECRETS));
  } catch {
    throw new Error(
      `SCHOOL_SIGNING_SECRETS must be JSON like {"slug":"secret"}, each secret at least ${MIN_SECRET_LENGTH} characters.`
    );
  }
  const secret = secrets[slug];
  if (!secret) throw new Error(`No signing secret for "${slug}" in SCHOOL_SIGNING_SECRETS.`);
  return secret;
}

export async function createSupportLink(
  schoolId: string,
  now: Date = new Date()
): Promise<{ url: string; expiresAt: string }> {
  const actor = await requireActor(SUPPORT_ROLES);
  if (!actor.email) throw new Error("Your account has no email to record on the link.");

  const id = z.string().uuid().parse(schoolId);
  const { data, error } = await createAdminClient()
    .from("schools")
    .select("id, slug, status, hostnames")
    .eq("id", id)
    .single();
  if (error || !data) throw new Error("That school does not exist.");
  const school = data as { id: string; slug: string; status: string; hostnames: string[] };
  if (school.status === "archived") throw new Error("This school is archived.");
  if (!school.hostnames?.length) throw new Error("Add the school's hostname first.");

  // Everything that can fail on configuration fails here, before the audit row.
  const host = normalizeHostname(school.hostnames[0]);
  const secret = signingSecretFor(school.slug);
  const jti = randomUUID();

  return withAudit(
    actor,
    {
      action: "support.link",
      schoolId: school.id,
      details: {
        slug: school.slug,
        hostname: host,
        link_id: jti,
        ttl_seconds: SUPPORT_LINK_TTL_SECONDS,
      },
    },
    async () => {
      const token = signImpersonationToken({
        secret,
        school: school.slug,
        by: actor.email,
        ttlSeconds: SUPPORT_LINK_TTL_SECONDS,
        now,
        jti,
      });
      return {
        url: `https://${host}/api/impersonate?token=${token}`,
        expiresAt: new Date(now.getTime() + SUPPORT_LINK_TTL_SECONDS * 1000).toISOString(),
      };
    }
  );
}
