import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { env } from "@/lib/env";
import { createAdminClient } from "@/lib/supabase/admin";
import { runHealthChecks } from "@/lib/health-run";

// Called on a schedule by .github/workflows/health.yml with
// "Authorization: Bearer <CRON_SECRET>". It is public to the login rules
// (lib/access.ts) because a scheduler has no session; the secret is the only
// way in. Without CRON_SECRET configured it refuses everything.
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const digest = (value: string) => createHash("sha256").update(value).digest();

function authorised(request: NextRequest): boolean {
  const secret = env.CRON_SECRET;
  if (!secret) return false;
  const header = request.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  return timingSafeEqual(digest(token), digest(secret));
}

export async function POST(request: NextRequest) {
  if (!env.CRON_SECRET) {
    return NextResponse.json({ ok: false, error: "CRON_SECRET is not set." }, { status: 503 });
  }
  if (!authorised(request)) {
    return NextResponse.json({ ok: false, error: "Unauthorised." }, { status: 401 });
  }
  try {
    const summary = await runHealthChecks(createAdminClient());
    return NextResponse.json({ ok: true, ...summary });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Health run failed." },
      { status: 500 }
    );
  }
}
