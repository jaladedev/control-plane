import { buildSchoolEnvFile } from "@/lib/provision/env";
import { publicKeyFromClaimSeed } from "@/lib/provision/claim-key";
import type { HandlerDeps, HandlerResult } from "@/worker/handlers";
import type { Job } from "@/worker/store";

// Applies a school's container settings (SCHOOL_APP_ENVS on the worker) to its
// running container: the way to rotate the R2 key, the service role key, the
// impersonation secret or a claim key, or to add a setting after launch.
//
// The order that keeps the school up: the owner creates the new key at its source,
// puts it in the worker's SCHOOL_APP_ENVS and restarts the worker, THEN applies
// (docs/key-rotation.md). The old key is revoked at its source only after this
// reports success. This job changes nothing until the new settings pass checks
// that can be made without restarting anything, and the server puts the old
// settings back if the school is not healthy on the new ones.

const clip = (s: string, n = 800) => (s.length > n ? `${s.slice(0, n)}…` : s);
const short = (tag: string | null | undefined) => (tag ? tag.slice(0, 12) : "unknown");
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

class Refused extends Error {}

export async function handleReconfigureSchool(job: Job, deps: HandlerDeps): Promise<HandlerResult> {
  const { store, secrets } = deps;
  if (!job.school_id) return { ok: false, error: "The job has no school." };
  // The registry fields provisioning reads are exactly what the settings are checked against.
  const ctx = await store.provisionContext(job.school_id);
  if (!ctx) return { ok: false, error: "That school does not exist." };
  const { school } = ctx;
  const from = await store.schoolForAction(job.school_id);
  const host = school.hostnames[0];
  const tag = from?.image_tag ?? null;

  try {
    if (school.status !== "active")
      throw new Refused(`${school.slug} is ${school.status}, not active.`);
    if (!host) throw new Refused(`${school.slug} has no hostname.`);
    if (!tag) throw new Refused(`The dashboard does not know which version ${school.slug} runs.`);

    // 1. The settings must be complete and belong to this school, before anything else.
    const values = await secrets.schoolAppEnv(school.slug);
    const built = buildSchoolEnvFile(values, {
      slug: school.slug,
      supabaseProjectRef: school.supabase_project_ref,
      r2Bucket: school.r2_bucket,
    });
    if (!built.ok) throw new Refused(`The settings are not ready: ${built.errors.join(" ")}`);

    // 1b. A claim-signing key must be one the control plane will accept, or the school's
    //     payment claims are refused (401) the moment it restarts on it. Its public half
    //     has to be registered and active first (docs/key-rotation.md, "Payment claim key").
    const seed = values?.CLAIM_SIGNING_KEY;
    if (seed) {
      const pub = publicKeyFromClaimSeed(seed);
      if (!pub) {
        throw new Refused(
          "CLAIM_SIGNING_KEY is not a valid 43-character private key (npm run claim-key). Nothing was changed."
        );
      }
      if (!(await store.activeSigningKeys(school.id)).includes(pub)) {
        throw new Refused(
          `The public key for CLAIM_SIGNING_KEY (${pub}) is not registered and active for ${school.slug}. ` +
            'Add it under "Payment claim keys" first. Nothing was changed.'
        );
      }
    }

    // 2. A new R2 key is proved before the container is restarted on it.
    if (!deps.checkStorage) throw new Refused("The worker has no storage check configured.");
    const env = values!;
    const storage = await deps.checkStorage({
      endpoint: env.R2_ENDPOINT,
      bucket: env.R2_BUCKET,
      accessKeyId: env.R2_ACCESS_KEY_ID,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    });
    if (!storage.ok) throw new Refused(`Nothing was changed. ${storage.error}`);

    // 3. Never act on a guess: the server must agree about what is running.
    const state = await deps.deploy({ action: "status", slug: school.slug });
    if (!state.ok) throw new Refused(`Could not read the server's state: ${state.message}`);
    if (state.tag !== tag) {
      throw new Refused(
        `The server says ${short(state.tag)} is running but the dashboard says ${short(tag)}. ` +
          "Nothing was changed. Refresh versions, check the server, then try again."
      );
    }

    // 4. Apply. The server writes the file, restarts on the same tag, waits for
    //    health, and puts the old file back if the school is not healthy.
    const out = await deps.deploy({ action: "reconfigure", slug: school.slug, env: built.file });
    if (!out.ok) {
      throw new Refused(
        out.code === 10
          ? `${out.message} The old settings are running again, so do not revoke the old keys.`
          : out.message
      );
    }

    // 5. The deeper check, from outside, on the public address. It reaches the
    //    school's database, so it catches a service role key that does not work.
    const probe = await deps.probe(host, school.slug);
    if (!probe.ok || probe.version !== tag) {
      const why = probe.ok
        ? `it reports version ${short(probe.version)}`
        : (probe.error ?? "unhealthy");
      throw new Refused(
        `The new settings are running, but the school does not look right: ${why}. ` +
          "The old settings are NOT restored automatically. Put the previous values back in SCHOOL_APP_ENVS and apply again."
      );
    }
    await notify(deps, `Settings applied to ${school.slug}. It is healthy on the new settings.`);
    return { ok: true, result: { tag, applied_keys: Object.keys(env).sort() } };
  } catch (error) {
    if (!(error instanceof Refused)) throw error;
    const message = clip(secrets.redact(error.message));
    await notify(deps, `Applying settings to ${school.slug} failed: ${message}`);
    return { ok: false, result: { tag }, error: message };
  }
}

async function notify(deps: HandlerDeps, text: string) {
  try {
    await deps.telegram?.send(text);
  } catch (error) {
    deps.log(`notice failed: ${errorText(error)}`);
  }
}
